import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperatorTransactionService } from "../src/operator/transaction-isolation.js";
import type { OperatorTransactionGit } from "../src/operator/transaction-isolation.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const roots: string[] = [];
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
  mergeFails = false;
  cleanupFails = false;

  async head(cwd: string) { this.calls.push({ op: "head", args: [cwd] }); return this.canonicalHead; }
  async status(cwd: string) { this.calls.push({ op: "status", args: [cwd] }); return this.canonicalStatus; }
  async commonDir(_cwd: string) { return "C:\\shared\\.git"; }
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
  async mergeFastForward(cwd: string, checkpoint: string) {
    this.calls.push({ op: "mergeFastForward", args: [cwd, checkpoint] });
    if (this.mergeFails) throw new Error("merge failed");
    this.canonicalHead = checkpoint;
    return checkpoint;
  }
  async worktreeRemove(repo: string, path: string) {
    this.calls.push({ op: "worktreeRemove", args: [repo, path] });
    if (this.cleanupFails) throw new Error("cleanup failed");
    await rm(path, { recursive: true, force: true });
  }
  async deleteBranch(repo: string, branch: string) {
    this.calls.push({ op: "deleteBranch", args: [repo, branch] });
    if (this.cleanupFails) throw new Error("cleanup failed");
  }
}

async function fixture() {
  const canonical = await mkdtemp("C:\\Workspace\\m06-promotion-canonical-");
  const worktreeRoot = await mkdtemp("C:\\Workspace\\m06-promotion-worktrees-");
  roots.push(canonical, worktreeRoot);
  await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
  const git = new FakeGit();
  const service = new OperatorTransactionService({ worktreeRoot, allowedProjects: { demo: canonical }, git });
  const begun = await service.begin("demo", canonical);
  if (begun.decision !== "ALLOW") throw new Error("begin denied");
  const tx = begun.transaction.txId;
  await service.stageCreate(tx, "new.txt", b64("new"));
  await service.validate(tx);
  await service.apply(tx);
  await service.checkpoint(tx, "checkpoint");
  return { canonical, git, service, tx, worktree: begun.transaction.worktreePath };
}

describe("M06 CAS fast-forward promotion", () => {
  it("denies every CAS conflict before canonical merge", async () => {
    const fx = await fixture();
    await expect(fx.service.promote(fx.tx, SHA_C, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "EXPECTED_HEAD_MISMATCH" });
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_C)).resolves.toEqual({ decision: "DENY", reason: "CHECKPOINT_MISMATCH" });

    fx.git.canonicalHead = SHA_C;
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "STALE_CANONICAL_HEAD" });
    fx.git.canonicalHead = SHA_A;
    fx.git.canonicalStatus = " M alpha.txt";
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "CANONICAL_DIRTY" });
    fx.git.canonicalStatus = "";
    fx.git.ancestor = false;
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "CHECKPOINT_NOT_DESCENDANT" });

    expect(fx.git.calls.filter((call) => call.op === "mergeFastForward")).toHaveLength(0);
    expect(await readFile(join(fx.canonical, "alpha.txt"), "utf8")).toBe("alpha");
  });

  it("promotes exactly to checkpoint by fast-forward and cleans owned runtime", async () => {
    const fx = await fixture();
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toMatchObject({
      decision: "ALLOW", state: "PROMOTED", cleanupPending: false,
    });
    expect(fx.git.canonicalHead).toBe(SHA_B);
    expect(fx.git.calls.filter((call) => call.op === "mergeFastForward")).toEqual([
      { op: "mergeFastForward", args: [fx.canonical, SHA_B] },
    ]);
    expect(await exists(fx.worktree)).toBe(false);
    await expect(fx.service.status(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "PROMOTED" });
  });
  it("keeps checkpointed state when ff-only promotion fails", async () => {
    const fx = await fixture();
    fx.git.mergeFails = true;
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({
      decision: "DENY", reason: "PROMOTION_FAILED",
    });
    expect(fx.git.canonicalHead).toBe(SHA_A);
    await expect(fx.service.status(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "CHECKPOINTED" });
  });

  it("reports cleanup pending after a successful promotion without undoing canonical", async () => {
    const fx = await fixture();
    fx.git.cleanupFails = true;
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toMatchObject({
      decision: "ALLOW", state: "PROMOTED", cleanupPending: true,
    });
    expect(fx.git.canonicalHead).toBe(SHA_B);
    await expect(fx.service.status(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "PROMOTED" });
  });

  it("rolls back an unpromoted transaction by deleting only owned runtime", async () => {
    const fx = await fixture();
    await expect(fx.service.rollback(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
    expect(await exists(fx.worktree)).toBe(false);
    expect(fx.git.canonicalHead).toBe(SHA_A);
    expect(await readFile(join(fx.canonical, "alpha.txt"), "utf8")).toBe("alpha");
    expect(fx.git.calls.some((call) => call.op === "mergeFastForward")).toBe(false);
  });
});
