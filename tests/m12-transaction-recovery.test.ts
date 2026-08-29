import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OperatorTransactionService,
  type OperatorTransactionGit,
  type OperatorTransactionRecoveryCoordinator,
} from "../src/operator/transaction-isolation.js";
import type { OperatorTransactionRecord } from "../src/operator/transaction-types.js";

const SHA_A = "a".repeat(40);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

class FakeGit implements OperatorTransactionGit {
  canonicalHead = SHA_A;
  canonicalStatus = "";
  canonicalIdentity = "C:\\shared\\.git";
  worktreeIdentity = "C:\\shared\\.git";
  canonicalPath = "";
  canReachCanonicalHead = true;
  readonly worktrees = new Map<string, { head: string; status: string; branch: string }>();
  #worktree(cwd: string) {
    const worktree = this.worktrees.get(resolve(cwd));
    if (worktree === undefined) throw new Error("unknown worktree");
    return worktree;
  }
  async head(cwd: string) { return resolve(cwd) === this.canonicalPath ? this.canonicalHead : this.#worktree(cwd).head; }
  async status(cwd: string) { return resolve(cwd) === this.canonicalPath ? this.canonicalStatus : this.#worktree(cwd).status; }
  async commonDir(cwd: string) { return resolve(cwd) === this.canonicalPath ? this.canonicalIdentity : this.worktreeIdentity; }
  async currentWorktreeBranch(cwd: string) { return this.#worktree(cwd).branch; }
  async worktreeAdd(repo: string, path: string, branch: string, start: string) {
    await mkdir(path, { recursive: true });
    await cp(repo, path, { recursive: true });
    this.worktrees.set(resolve(path), { head: start, status: "", branch });
  }
  async worktreeRemove(_repo: string, path: string) { this.worktrees.delete(resolve(path)); await rm(path, { recursive: true, force: true }); }
  async deleteBranch(_repo: string, _branch: string) {}
  async addAll(_cwd: string) {}
  async commit(_cwd: string, _message: string) { return "b".repeat(40); }
  async isAncestor(_cwd: string, _ancestor: string, _descendant: string) { return this.canReachCanonicalHead; }
  async mergeFastForward(_cwd: string, checkpoint: string) { this.canonicalHead = checkpoint; return checkpoint; }
}

class FakeRecovery implements OperatorTransactionRecoveryCoordinator {
  readonly beginCalls: Array<{ record: OperatorTransactionRecord; repositoryIdentity: string }> = [];
  readonly terminalCalls: OperatorTransactionRecord[] = [];
  readonly residue = new Map<string, OperatorTransactionRecord>();
  failBegin = false;
  failTerminal = false;
  recoveryDecision: "SAFE_TO_CONTINUE" | "SAFE_TO_ROLLBACK" | "MANUAL_RECONCILIATION_REQUIRED" = "SAFE_TO_ROLLBACK";

  async onBegin(record: OperatorTransactionRecord, repositoryIdentity: string) {
    if (this.failBegin) throw new Error("lease conflict");
    this.beginCalls.push({ record, repositoryIdentity });
    this.residue.set(record.txId, record);
  }
  async onTerminal(record: OperatorTransactionRecord) {
    if (this.failTerminal) throw new Error("lease release failure");
    this.terminalCalls.push(record);
    this.residue.delete(record.txId);
  }
  async recoverOwnedTransaction(_record: OperatorTransactionRecord) { return this.recoveryDecision; }
  async collectOwnedResidue() { return Object.freeze([...this.residue.values()]); }
}

type BranchReaderOption = "absent" | ((cwd: string) => Promise<string>);

async function fixture(recovery?: FakeRecovery, branchReader?: BranchReaderOption) {
  const canonical = await mkdtemp(join(tmpdir(), "m12-recovery-canonical-"));
  const worktreeRoot = await mkdtemp(join(tmpdir(), "m12-recovery-worktrees-"));
  roots.push(canonical, worktreeRoot);
  await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
  const git = new FakeGit();
  git.canonicalPath = resolve(canonical);
  const readCurrentWorktreeBranch = branchReader === "absent"
    ? undefined
    : branchReader ?? git.currentWorktreeBranch.bind(git);
  const service = new OperatorTransactionService({
    worktreeRoot,
    allowedProjects: { "operator-canary": canonical },
    git,
    ...(recovery === undefined ? {} : { recovery }),
    ...(readCurrentWorktreeBranch === undefined ? {} : { readCurrentWorktreeBranch }),
  });
  return { canonical, worktreeRoot, git, service };
}

describe("M12 transaction recovery seam", () => {
  it("preserves the legacy M06 constructor when recovery is absent", async () => {
    const { canonical, service } = await fixture();
    await expect(service.begin("operator-canary", canonical)).resolves.toMatchObject({ decision: "ALLOW", state: "OPEN" });
  });

  it("binds recovery only after repository identity is proven", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    expect(begun.decision).toBe("ALLOW");
    expect(recovery.beginCalls).toHaveLength(1);
    expect(recovery.beginCalls[0]?.repositoryIdentity).toBe("C:\\shared\\.git");
    expect(recovery.beginCalls[0]?.record.txId).toBe(begun.decision === "ALLOW" ? begun.transaction.txId : "");
  });

  it("cleans the worktree if recovery begin cannot establish ownership", async () => {
    const recovery = new FakeRecovery();
    recovery.failBegin = true;
    const { canonical, worktreeRoot, service } = await fixture(recovery);
    await expect(service.begin("operator-canary", canonical)).resolves.toEqual({
      decision: "DENY", reason: "RECOVERY_BEGIN_FAILED_TRANSACTION_DISCARDED",
    });
    await expect((await import("node:fs/promises")).readdir(worktreeRoot).then((items) => items.length)).resolves.toBe(0);
  });

  it("releases recovery ownership only after successful rollback cleanup", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    await expect(service.rollback(begun.transaction.txId)).resolves.toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
    expect(recovery.terminalCalls).toHaveLength(1);
    expect(await recovery.collectOwnedResidue()).toHaveLength(0);
  });

  it("keeps recovery residue when terminal release fails", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    recovery.failTerminal = true;
    await expect(service.rollback(begun.transaction.txId)).resolves.toEqual({
      decision: "DENY", reason: "ROLLBACK_RECOVERY_RELEASE_PENDING",
    });
    expect(await recovery.collectOwnedResidue()).toHaveLength(1);
  });

  it("releases recovery ownership after promotion cleanup", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    const tx = begun.transaction.txId;
    await service.stageCreate(tx, "new.txt", Buffer.from("new").toString("base64"));
    await service.validate(tx);
    await service.apply(tx);
    const checkpoint = await service.checkpoint(tx, "m12 recovery test");
    if (checkpoint.decision !== "ALLOW" || checkpoint.transaction.checkpointId === undefined) throw new Error("checkpoint denied");
    await expect(service.promote(tx, SHA_A, checkpoint.transaction.checkpointId)).resolves.toMatchObject({ decision: "ALLOW", cleanupPending: false });
    expect(await recovery.collectOwnedResidue()).toHaveLength(0);
  });

  it("exposes interrupted owned residue for startup classification without touching foreign residue", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    const residue = await recovery.collectOwnedResidue();
    expect(residue).toHaveLength(1);
    await expect(recovery.recoverOwnedTransaction(residue[0]!)).resolves.toBe("SAFE_TO_ROLLBACK");
    recovery.recoveryDecision = "MANUAL_RECONCILIATION_REQUIRED";
    await expect(recovery.recoverOwnedTransaction(residue[0]!)).resolves.toBe("MANUAL_RECONCILIATION_REQUIRED");
    expect(await recovery.collectOwnedResidue()).toHaveLength(1);
  });
  it("allows a recovery-owned, unpromoted transaction to clean only its own worktree after a legitimate canonical advance", async () => {
    const recovery = new FakeRecovery();
    const { canonical, git, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    git.canonicalHead = "c".repeat(40);
    await expect(service.rollback(begun.transaction.txId)).resolves.toMatchObject({
      decision: "ALLOW", state: "ROLLED_BACK",
    });
    expect(await recovery.collectOwnedResidue()).toHaveLength(0);
    await expect((await import("node:fs/promises")).access(begun.transaction.worktreePath)).rejects.toThrow();
  });

  it.each([
    ["canonical is dirty", (git: FakeGit, _worktreePath: string) => { git.canonicalHead = "c".repeat(40); git.canonicalStatus = " M foreign.txt"; }],
    ["base is not an ancestor of canonical HEAD", (git: FakeGit, _worktreePath: string) => { git.canonicalHead = "c".repeat(40); git.canReachCanonicalHead = false; }],
    ["canonical/worktree repository identity mismatches", (git: FakeGit, _worktreePath: string) => { git.canonicalHead = "c".repeat(40); git.worktreeIdentity = "C:\\foreign\\.git"; }],
    ["transaction branch identity is not exact", (git: FakeGit, worktreePath: string) => { git.canonicalHead = "c".repeat(40); git.worktrees.get(resolve(worktreePath))!.branch = "foreign-branch"; }],
  ])("denies recovery-owned stale cleanup when %s", async (_reason, invalidate) => {
    const recovery = new FakeRecovery();
    const { canonical, git, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    invalidate(git, begun.transaction.worktreePath);

    await expect(service.rollback(begun.transaction.txId)).resolves.toEqual({
      decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING",
    });
    expect(await recovery.collectOwnedResidue()).toHaveLength(1);
    await expect((await import("node:fs/promises")).access(begun.transaction.worktreePath)).resolves.toBeUndefined();
  });

  it("fails closed when recovery cleanup has no branch reader", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery, "absent");
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");

    await expect(service.rollback(begun.transaction.txId)).resolves.toEqual({
      decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING",
    });
    expect(await recovery.collectOwnedResidue()).toHaveLength(1);
  });

  it("fails closed when the recovery branch reader fails", async () => {
    const recovery = new FakeRecovery();
    const { canonical, service } = await fixture(recovery, async () => { throw new Error("branch read failed"); });
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");

    await expect(service.rollback(begun.transaction.txId)).resolves.toEqual({
      decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING",
    });
    expect(await recovery.collectOwnedResidue()).toHaveLength(1);
  });

  it("does not let an arbitrary recovery object opt out of stale/currentness cleanup", async () => {
    const recovery = new FakeRecovery() as FakeRecovery & {
      allowDisposableStaleWorktreeDiscard?: () => Promise<boolean>;
    };
    recovery.allowDisposableStaleWorktreeDiscard = async () => true;
    const { canonical, git, service } = await fixture(recovery);
    const begun = await service.begin("operator-canary", canonical);
    if (begun.decision !== "ALLOW") throw new Error("begin denied");
    git.canonicalHead = "c".repeat(40);
    git.canReachCanonicalHead = false;

    await expect(service.rollback(begun.transaction.txId)).resolves.toEqual({
      decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING",
    });
    expect(await recovery.collectOwnedResidue()).toHaveLength(1);
  });

});
