import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperatorTransactionService } from "../src/operator/transaction-isolation.js";
import type { OperatorTransactionGit } from "../src/operator/transaction-isolation.js";

const SHA_A = "a".repeat(40);
const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

class FakeGit implements OperatorTransactionGit {
  readonly calls: Array<{ op: string; args: string[] }> = [];
  canonicalStatus = "";
  canonicalHead = SHA_A;

  async head(cwd: string) { this.calls.push({ op: "head", args: [cwd] }); return this.canonicalHead; }
  async status(cwd: string) { this.calls.push({ op: "status", args: [cwd] }); return this.canonicalStatus; }
  async worktreeAdd(repo: string, path: string, branch: string, start: string) {
    this.calls.push({ op: "worktreeAdd", args: [repo, path, branch, start] });
    await mkdir(path, { recursive: true });
    await cp(repo, path, { recursive: true, filter: (source) => !source.includes("\\.git") });
  }
}

async function fixture() {
  const canonical = await mkdtemp("C:\\Workspace\\m06-canonical-");
  const worktreeRoot = await mkdtemp("C:\\Workspace\\m06-worktrees-");
  roots.push(canonical, worktreeRoot);
  await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
  await writeFile(join(canonical, "move.txt"), "move", "utf8");
  const git = new FakeGit();
  const service = new OperatorTransactionService({
    worktreeRoot,
    allowedProjects: { demo: canonical },
    git,
  });
  return { canonical, worktreeRoot, git, service };
}
describe("M06 transaction-owned isolation", () => {
  it("binds begin to allowlisted clean canonical HEAD and generated worktree", async () => {
    const { canonical, worktreeRoot, git, service } = await fixture();
    const result = await service.begin("demo", canonical);
    expect(result.decision).toBe("ALLOW");
    if (result.decision !== "ALLOW") throw new Error("begin denied");
    expect(result.transaction).toMatchObject({
      projectId: "demo", canonicalRoot: canonical, baseHeadSha: SHA_A, state: "OPEN",
    });
    expect(result.transaction.txId).toMatch(/^txn_[a-f0-9]{32}$/);
    expect(result.transaction.branchName).toMatch(/^haios-tx-[a-f0-9]{12}$/);
    expect(result.transaction.worktreePath.startsWith(worktreeRoot)).toBe(true);
    expect(git.calls.some((call) => call.op === "worktreeAdd" && call.args[3] === SHA_A)).toBe(true);
  });

  it("fails closed for unapproved root or dirty canonical", async () => {
    const { canonical, git, service } = await fixture();
    await expect(service.begin("unknown", canonical)).resolves.toEqual({
      decision: "DENY", reason: "PROJECT_NOT_ALLOWED",
    });
    const other = await mkdtemp("C:\\Workspace\\m06-other-");
    roots.push(other);
    await expect(service.begin("demo", other)).resolves.toEqual({
      decision: "DENY", reason: "CANONICAL_ROOT_MISMATCH",
    });
    git.canonicalStatus = " M alpha.txt";
    await expect(service.begin("demo", canonical)).resolves.toEqual({
      decision: "DENY", reason: "CANONICAL_DIRTY",
    });
  });

  it("stages typed create patch move remove intents and validates currentness", async () => {
    const { canonical, service } = await fixture();
    const begun = await service.begin("demo", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    const tx = begun.transaction.txId;
    await expect(service.stageCreate(tx, "nested/new.txt", b64("new"))).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
    await expect(service.stagePatch(tx, "alpha.txt", sha("alpha"), b64("changed"))).resolves.toMatchObject({ decision: "ALLOW" });
    await expect(service.stageMove(tx, "move.txt", "moved.txt", sha("move"))).resolves.toMatchObject({ decision: "ALLOW" });
    await writeFile(join(begun.transaction.worktreePath, "remove.txt"), "remove", "utf8");
    await expect(service.stageRemove(tx, "remove.txt", sha("remove"))).resolves.toMatchObject({ decision: "ALLOW" });
    await expect(service.validate(tx)).resolves.toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
    await expect(service.status(tx)).resolves.toMatchObject({ decision: "ALLOW", intentCount: 4, state: "VALIDATED" });
  });
  it("rejects traversal, sensitive paths, wrong preimages and duplicate targets", async () => {
    const { canonical, service } = await fixture();
    const begun = await service.begin("demo", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    const tx = begun.transaction.txId;
    for (const path of ["..\\escape.txt", "C:\\escape.txt", ".git/config", ".env", "secrets/key.txt", "private.pem"]) {
      await expect(service.stageCreate(tx, path, b64("x"))).resolves.toMatchObject({ decision: "DENY", reason: "PATH_DENIED" });
    }
    await expect(service.stagePatch(tx, "alpha.txt", "0".repeat(64), b64("x"))).resolves.toMatchObject({
      decision: "DENY", reason: "PREIMAGE_MISMATCH",
    });
    await expect(service.stageCreate(tx, "new.txt", b64("one"))).resolves.toMatchObject({ decision: "ALLOW" });
    await expect(service.stageCreate(tx, "new.txt", b64("two"))).resolves.toMatchObject({
      decision: "DENY", reason: "PATH_ALREADY_STAGED",
    });
  });

  it("rejects a junction escape outside the transaction worktree", async () => {
    const { canonical, service } = await fixture();
    const begun = await service.begin("demo", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    const outside = await mkdtemp("C:\\Workspace\\m06-outside-");
    roots.push(outside);
    await symlink(outside, join(begun.transaction.worktreePath, "escape"), "junction");
    await expect(service.stageCreate(begun.transaction.txId, "escape/new.txt", b64("x"))).resolves.toMatchObject({
      decision: "DENY", reason: "PATH_DENIED",
    });
  });

  it("denies validate before staging and staging after validation", async () => {
    const { canonical, service } = await fixture();
    const begun = await service.begin("demo", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    const tx = begun.transaction.txId;
    await expect(service.validate(tx)).resolves.toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_STATE" });
    await service.stageCreate(tx, "new.txt", b64("x"));
    await service.validate(tx);
    await expect(service.stageCreate(tx, "later.txt", b64("y"))).resolves.toEqual({
      decision: "DENY", reason: "INVALID_TRANSACTION_STATE",
    });
  });
});
