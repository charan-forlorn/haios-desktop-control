import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperatorTransactionService } from "../src/operator/transaction-isolation.js";
import type { OperatorTransactionGit } from "../src/operator/transaction-isolation.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

class FakeGit implements OperatorTransactionGit {
  readonly calls: Array<{ op: string; args: string[] }> = [];
  canonicalHead = SHA_A;
  canonicalStatus = "";
  checkpointSha = SHA_B;
  ancestor = true;

  async head(cwd: string) { this.calls.push({ op: "head", args: [cwd] }); return this.canonicalHead; }
  async status(cwd: string) { this.calls.push({ op: "status", args: [cwd] }); return this.canonicalStatus; }
  async worktreeAdd(repo: string, path: string, branch: string, start: string) {
    this.calls.push({ op: "worktreeAdd", args: [repo, path, branch, start] });
    await mkdir(path, { recursive: true });
    await cp(repo, path, { recursive: true, filter: (source) => !source.includes("\\.git") });
  }
  async addAll(cwd: string) { this.calls.push({ op: "addAll", args: [cwd] }); }
  async commit(cwd: string, message: string) { this.calls.push({ op: "commit", args: [cwd, message] }); return this.checkpointSha; }
  async isAncestor(cwd: string, ancestor: string, descendant: string) {
    this.calls.push({ op: "isAncestor", args: [cwd, ancestor, descendant] }); return this.ancestor;
  }
  async worktreeRemove(repo: string, path: string) { this.calls.push({ op: "worktreeRemove", args: [repo, path] }); await rm(path, { recursive: true, force: true }); }
  async deleteBranch(repo: string, branch: string) { this.calls.push({ op: "deleteBranch", args: [repo, branch] }); }
}
async function fixture() {
  const canonical = await mkdtemp("C:\\Workspace\\m06-checkpoint-canonical-");
  const worktreeRoot = await mkdtemp("C:\\Workspace\\m06-checkpoint-worktrees-");
  roots.push(canonical, worktreeRoot);
  await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
  await writeFile(join(canonical, "move.txt"), "move", "utf8");
  await writeFile(join(canonical, "remove.txt"), "remove", "utf8");
  const git = new FakeGit();
  const service = new OperatorTransactionService({ worktreeRoot, allowedProjects: { demo: canonical }, git });
  const begun = await service.begin("demo", canonical);
  if (begun.decision !== "ALLOW") throw new Error("begin denied");
  return { canonical, git, service, tx: begun.transaction.txId, worktree: begun.transaction.worktreePath };
}

async function stageAll(fx: Awaited<ReturnType<typeof fixture>>) {
  await fx.service.stageCreate(fx.tx, "nested/new.txt", b64("new"));
  await fx.service.stagePatch(fx.tx, "alpha.txt", sha("alpha"), b64("changed"));
  await fx.service.stageMove(fx.tx, "move.txt", "moved.txt", sha("move"));
  await fx.service.stageRemove(fx.tx, "remove.txt", sha("remove"));
  await fx.service.validate(fx.tx);
}

describe("M06 worktree apply and checkpoint", () => {
  it("applies all mutation kinds only inside the transaction worktree", async () => {
    const fx = await fixture();
    await stageAll(fx);
    await expect(fx.service.apply(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "APPLIED" });
    expect(await readFile(join(fx.worktree, "alpha.txt"), "utf8")).toBe("changed");
    expect(await readFile(join(fx.worktree, "nested/new.txt"), "utf8")).toBe("new");
    expect(await exists(join(fx.worktree, "move.txt"))).toBe(false);
    expect(await readFile(join(fx.worktree, "moved.txt"), "utf8")).toBe("move");
    expect(await exists(join(fx.worktree, "remove.txt"))).toBe(false);
    expect(await readFile(join(fx.canonical, "alpha.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(fx.canonical, "move.txt"), "utf8")).toBe("move");
    expect(await readFile(join(fx.canonical, "remove.txt"), "utf8")).toBe("remove");
    expect(fx.git.canonicalHead).toBe(SHA_A);
  });
  it("creates one local descendant checkpoint and leaves the worktree clean", async () => {
    const fx = await fixture();
    await fx.service.stagePatch(fx.tx, "alpha.txt", sha("alpha"), b64("changed"));
    await fx.service.validate(fx.tx);
    await fx.service.apply(fx.tx);
    await expect(fx.service.checkpoint(fx.tx, "HAIOS M06 checkpoint")).resolves.toMatchObject({
      decision: "ALLOW", state: "CHECKPOINTED", transaction: { checkpointId: SHA_B },
    });
    expect(fx.git.calls.filter((call) => call.op === "commit")).toEqual([
      { op: "commit", args: [fx.worktree, "HAIOS M06 checkpoint"] },
    ]);
    expect(fx.git.calls.some((call) => call.op === "isAncestor" && call.args[1] === SHA_A && call.args[2] === SHA_B)).toBe(true);
  });

  it("destroys only the owned worktree when preimage drifts after validation", async () => {
    const fx = await fixture();
    await fx.service.stagePatch(fx.tx, "alpha.txt", sha("alpha"), b64("changed"));
    await fx.service.validate(fx.tx);
    await writeFile(join(fx.worktree, "alpha.txt"), "drift", "utf8");
    await expect(fx.service.apply(fx.tx)).resolves.toEqual({
      decision: "DENY", reason: "APPLY_FAILED_TRANSACTION_DISCARDED",
    });
    expect(await exists(fx.worktree)).toBe(false);
    expect(await readFile(join(fx.canonical, "alpha.txt"), "utf8")).toBe("alpha");
    expect(fx.git.canonicalHead).toBe(SHA_A);
    expect(fx.git.calls.some((call) => call.op === "worktreeRemove")).toBe(true);
    expect(fx.git.calls.some((call) => call.op === "deleteBranch")).toBe(true);
    await expect(fx.service.status(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
  });

  it("rejects checkpoint before apply and rejects non-descendant checkpoint", async () => {
    const fx = await fixture();
    await expect(fx.service.checkpoint(fx.tx, "early")).resolves.toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_STATE" });
    await fx.service.stagePatch(fx.tx, "alpha.txt", sha("alpha"), b64("changed"));
    await fx.service.validate(fx.tx);
    await fx.service.apply(fx.tx);
    fx.git.ancestor = false;
    await expect(fx.service.checkpoint(fx.tx, "bad descendant")).resolves.toEqual({
      decision: "DENY", reason: "CHECKPOINT_NOT_DESCENDANT",
    });
  });
});
