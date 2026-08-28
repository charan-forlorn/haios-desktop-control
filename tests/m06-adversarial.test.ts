import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalOperatorGit } from "../src/operator/local-git.js";
import { OperatorTransactionService, type OperatorTransactionGit } from "../src/operator/transaction-isolation.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const roots: string[] = [];
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

class AdversarialGit implements OperatorTransactionGit {
  canonicalHead = SHA_A;
  canonicalStatus = "";
  checkpoint = SHA_B;
  ancestor = true;
  cleanupFails = false;
  identityMismatch = false;
  mergeCalls = 0;

  async head() { return this.canonicalHead; }
  async status() { return this.canonicalStatus; }
  async commonDir(cwd: string) { return this.identityMismatch && cwd.toLowerCase().includes("worktrees") ? "C:\\foreign\\.git" : "C:\\shared\\.git"; }
  async worktreeAdd(repo: string, path: string) {
    await mkdir(path, { recursive: true });
    await cp(repo, path, { recursive: true, filter: (source) => !source.includes("\\.git") });
  }
  async worktreeRemove(_repo: string, path: string) {
    if (this.cleanupFails) throw new Error("cleanup denied");
    await rm(path, { recursive: true, force: true });
  }
  async deleteBranch() { if (this.cleanupFails) throw new Error("cleanup denied"); }
  async addAll() {}
  async commit() { return this.checkpoint; }
  async isAncestor() { return this.ancestor; }
  async mergeFastForward(_cwd: string, checkpoint: string) {
    this.mergeCalls += 1;
    this.canonicalHead = checkpoint;
    return checkpoint;
  }
}

async function fixture() {
  const canonical = await mkdtemp("C:\\Workspace\\m06-adv-canonical-");
  const worktreeRoot = await mkdtemp("C:\\Workspace\\m06-adv-worktrees-");
  roots.push(canonical, worktreeRoot);
  await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
  const git = new AdversarialGit();
  const service = new OperatorTransactionService({ worktreeRoot, allowedProjects: { demo: canonical }, git });
  const begun = await service.begin("demo", canonical);
  if (begun.decision !== "ALLOW") throw new Error("begin denied");
  return { canonical, git, service, tx: begun.transaction.txId, worktree: begun.transaction.worktreePath };
}

async function checkpointed() {
  const fx = await fixture();
  await fx.service.stageCreate(fx.tx, "new.txt", b64("new"));
  await fx.service.validate(fx.tx);
  await fx.service.apply(fx.tx);
  await fx.service.checkpoint(fx.tx, "checkpoint");
  return fx;
}
describe("M06 adversarial authority boundaries", () => {
  it("exposes only typed local Git primitives and no network/arbitrary execution surface", () => {
    const methods = Object.getOwnPropertyNames(LocalOperatorGit.prototype).sort();
    expect(methods).toEqual([
      "addAll", "commit", "commonDir", "constructor", "deleteBranch", "head", "isAncestor",
      "mergeFastForward", "status", "worktreeAdd", "worktreeRemove",
    ]);
    for (const forbidden of ["push", "pull", "fetch", "remote", "clone", "run", "exec", "shell"]) {
      expect(methods).not.toContain(forbidden);
    }
  });

  it("preserves M05 public operator13 inactivity and projection separation", async () => {
    const server = await readFile("src/server.ts", "utf8");
    const foundation = await readFile("src/operator/server-foundation.ts", "utf8");
    const protocol = await readFile("src/operator/protocol.ts", "utf8");
    expect(server).toContain("operatorFoundation?.tools ?? legacyPublicTools()");
    expect(server).not.toContain("transaction-isolation");
    expect(server).not.toContain("local-git");
    expect(foundation).toContain("TOOL_DENIED_INACTIVE_MODE");
    expect(foundation).not.toContain("transaction-isolation");
    expect(protocol).toContain('qualification: "M05_FOUNDATION_ONLY"');
    expect(protocol).toContain("mutationActive: false");
  });

  it("fails closed for traversal, sensitive paths and junction escape", async () => {
    const fx = await fixture();
    for (const path of ["..\\escape.txt", ".git/config", ".env", "secrets/key.txt", "id.pem"]) {
      await expect(fx.service.stageCreate(fx.tx, path, b64("x"))).resolves.toMatchObject({ decision: "DENY", reason: "PATH_DENIED" });
    }
    const outside = await mkdtemp("C:\\Workspace\\m06-adv-outside-");
    roots.push(outside);
    await symlink(outside, join(fx.worktree, "escape"), "junction");
    await expect(fx.service.stageCreate(fx.tx, "escape/new.txt", b64("x"))).resolves.toMatchObject({ decision: "DENY", reason: "PATH_DENIED" });
  });
  it("denies stale-head, dirty canonical, wrong checkpoint and non-descendant before merge", async () => {
    const fx = await checkpointed();
    await expect(fx.service.promote(fx.tx, "c".repeat(40), SHA_B)).resolves.toEqual({ decision: "DENY", reason: "EXPECTED_HEAD_MISMATCH" });
    await expect(fx.service.promote(fx.tx, SHA_A, "c".repeat(40))).resolves.toEqual({ decision: "DENY", reason: "CHECKPOINT_MISMATCH" });
    fx.git.canonicalHead = "c".repeat(40);
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "STALE_CANONICAL_HEAD" });
    fx.git.canonicalHead = SHA_A;
    fx.git.canonicalStatus = " M alpha.txt";
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "CANONICAL_DIRTY" });
    fx.git.canonicalStatus = "";
    fx.git.ancestor = false;
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "CHECKPOINT_NOT_DESCENDANT" });
    expect(fx.git.mergeCalls).toBe(0);
  });

  it("rejects a newly created worktree whose shared Git identity mismatches canonical", async () => {
    const canonical = await mkdtemp("C:\\Workspace\\m06-adv-identity-canonical-");
    const worktreeRoot = await mkdtemp("C:\\Workspace\\m06-adv-identity-worktrees-");
    roots.push(canonical, worktreeRoot);
    await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
    const git = new AdversarialGit();
    git.identityMismatch = true;
    const service = new OperatorTransactionService({ worktreeRoot, allowedProjects: { demo: canonical }, git });
    await expect(service.begin("demo", canonical)).resolves.toEqual({
      decision: "DENY", reason: "WORKTREE_REPOSITORY_IDENTITY_MISMATCH",
    });
  });

  it("refuses rollback cleanup after repository identity drifts", async () => {
    const fx = await checkpointed();
    fx.git.identityMismatch = true;
    await expect(fx.service.rollback(fx.tx)).resolves.toEqual({
      decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING",
    });
    expect(await exists(fx.worktree)).toBe(true);
    await expect(fx.service.status(fx.tx)).resolves.toMatchObject({ decision: "ALLOW", state: "CHECKPOINTED" });
    expect(fx.git.canonicalHead).toBe(SHA_A);
  });
  it("fails closed when rollback cleanup ownership cannot be completed", async () => {
    const fx = await checkpointed();
    fx.git.cleanupFails = true;
    await expect(fx.service.rollback(fx.tx)).resolves.toEqual({ decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING" });
    expect(fx.git.canonicalHead).toBe(SHA_A);
    expect(fx.git.mergeCalls).toBe(0);
  });

  it("denies invalid promotion state before canonical mutation", async () => {
    const fx = await fixture();
    await expect(fx.service.promote(fx.tx, SHA_A, SHA_B)).resolves.toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_STATE" });
    expect(fx.git.mergeCalls).toBe(0);
  });
});

describe("M06 qualification contract", () => {
  it("binds full regression, live Git CAS proof, tunnel integrity and independent handoff", async () => {
    const script = await readFile("scripts/qualify-m06.ps1", "utf8");
    for (const marker of [
      "POWERSHELL_7_REQUIRED", "M06_ADVERSARIAL_TESTS", "FULL_TEST_PASSING_COUNT",
      "[StringComparer]::Ordinal", "LIVE_STALE_HEAD_CONFLICT=PASS", "LIVE_FF_PROMOTION=PASS",
      "RUNTIME_RESIDUE=0", "REPOSITORY_IDENTITY_BOUND=PASS", "TUNNEL_INTEGRITY=PASS", "PORT_8772_FREE=PASS",
      "HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_READY_FOR_INDEPENDENT_VERIFICATION",
    ]) expect(script).toContain(marker);
    expect(script).not.toContain("'sk-[A-Za-z0-9_-]+'");
    expect(script).toContain("(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}");
  });
});
