import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { RemediationController } from "../src/operator/remediation-controller.js";
import { RemediationStore } from "../src/operator/remediation-store.js";
import {
  M12StabilityCoordinator,
  createM12StabilityTaskApi,
  type M12StabilityFactsProvider,
} from "../src/operator/m12-stability-coordinator.js";
import type { OperatorControlTaskApi } from "../src/operator/control-runtime.js";
import type { OperatorTaskResultMetadata, OperatorTaskRunResult } from "../src/operator/task-runner.js";
import type { OperatorTransactionRecoveryCoordinator } from "../src/operator/transaction-isolation.js";

const roots: string[] = [];
const HEAD = "a".repeat(40);
const DIGEST = "d".repeat(64);
const REPO = "C:\\Workspace\\haios-operator-canary\\.git";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function metadata(overrides: Partial<OperatorTaskResultMetadata> = {}): OperatorTaskResultMetadata {
  return {
    decision: "DENY", reason: "TASK_EXIT_NONZERO", exitCode: 1, sandboxReason: "PROCESS_EXIT_NONZERO", timedOut: false,
    taskId: "project_test", registryId: "registry", registryVersion: "1", registrySha256: "b".repeat(64),
    effectPolicySetId: "effects", effectPolicyVersion: "1", effectPolicyId: "effect", effectPolicySha256: "c".repeat(64),
    sandboxProfile: "S0", toolchainProfile: "node", image: "image", imageId: "image-id", transactionId: "txn_0123456789abcdef0123456789abcdef",
    worktreePath: "C:\\Workspace\\worktree", durationMs: 10, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
    effectSummary: { total: 0, allowedArtifact: 0, unclassified: 0, protected: 0, complete: true },
    canonicalPreHead: HEAD, canonicalPostHead: HEAD, canonicalPreStateDigest: DIGEST, canonicalPostStateDigest: DIGEST,
    canonicalStateUnchanged: true, cleanupVerified: true, cleanupStatus: "VERIFIED", ...overrides,
  };
}

function denied(overrides: Partial<OperatorTaskResultMetadata> = {}): OperatorTaskRunResult {
  const m = metadata(overrides);
  return { decision: "DENY", reason: m.reason ?? "TASK_EXIT_NONZERO", ...(m.exitCode === null ? {} : { exitCode: m.exitCode }), metadata: m };
}

function allowed(): OperatorTaskRunResult {
  const m = metadata({ decision: "ALLOW", reason: null, exitCode: 0, sandboxReason: null });
  return { decision: "ALLOW", taskId: "project_test", registrySha256: "b".repeat(64), effectPolicySha256: "c".repeat(64), exitCode: 0,
    stdout: "ok", stderr: "", effects: [], cleanupVerified: true, metadata: m };
}
class Facts implements M12StabilityFactsProvider {
  currentness: "CURRENT" | "STALE" | "UNKNOWN" = "CURRENT";
  async inspect(_txId: string) {
    return {
      projectId: "operator-canary" as const, repositoryIdentity: REPO, baseHeadSha: HEAD,
      authority: "AUTHORIZED" as const, currentness: this.currentness, emergency: "NONE" as const,
      invariant: { name: "CANONICAL_STATE", value: DIGEST },
      recovery: {
        projectId: "operator-canary" as const, repositoryIdentity: REPO,
        transactionId: "txn_0123456789abcdef0123456789abcdef",
        leaseOwner: "LIVE" as const, leaseExpired: false, repositoryMatch: true,
        ownership: "EXACT" as const, transactionState: "CLEAN" as const,
        unresolvedEffects: false, foreignGitLock: false,
      },
    };
  }
}

class Recovery implements OperatorTransactionRecoveryCoordinator {
  residue: any[] = [];
  async onBegin() {}
  async onTerminal() {}
  async recoverOwnedTransaction(record: any) { return record.classification ?? "SAFE_TO_ROLLBACK"; }
  async collectOwnedResidue() { return this.residue; }
}

async function fixture() {
  const stateRoot = await mkdtemp(`${tmpdir()}\\m12-stability-`); roots.push(stateRoot);
  const facts = new Facts(); const recovery = new Recovery();
  const coordinator = new M12StabilityCoordinator({ remediation: new RemediationController(new RemediationStore(stateRoot)), facts, recovery });
  return { coordinator, facts, recovery };
}
const request = Object.freeze({
  txId: "txn_0123456789abcdef0123456789abcdef", taskId: "project_test",
  params: Object.freeze({}), expectedRegistrySha256: "b".repeat(64),
});

describe("M12 stability coordinator", () => {
  it("fingerprints and persists an eligible task failure", async () => {
    const { coordinator } = await fixture();
    await expect(coordinator.observeTaskResult(request, denied())).resolves.toMatchObject({
      directive: "RETRY_SAME_PLAN", attempt: 1, replanUsed: false, recovery: "SAFE_TO_CONTINUE",
    });
    await expect(coordinator.observeTaskResult(request, denied())).resolves.toMatchObject({ directive: "REPLAN_REQUIRED", attempt: 2 });
  });

  it("routes protected effects to rollback instead of retry", async () => {
    const { coordinator } = await fixture();
    const result = denied({ effectSummary: { total: 1, allowedArtifact: 0, unclassified: 0, protected: 1, complete: true } });
    await expect(coordinator.observeTaskResult(request, result)).resolves.toMatchObject({ directive: "ROLLBACK_REQUIRED", recovery: "SAFE_TO_ROLLBACK" });
  });

  it("routes stale currentness and cleanup uncertainty away from retry", async () => {
    const first = await fixture(); first.facts.currentness = "STALE";
    await expect(first.coordinator.observeTaskResult(request, denied())).resolves.toMatchObject({ directive: "MANUAL_RECONCILIATION_REQUIRED" });
    const second = await fixture();
    await expect(second.coordinator.observeTaskResult(request, denied({ cleanupVerified: false, cleanupStatus: "UNVERIFIED" })))
      .resolves.toMatchObject({ directive: "MANUAL_RECONCILIATION_REQUIRED", recovery: "MANUAL_RECONCILIATION_REQUIRED" });
  });

  it("terminates a clean success with PASS without persisting a failure", async () => {
    const { coordinator } = await fixture();
    await expect(coordinator.observeTaskResult(request, allowed())).resolves.toMatchObject({ directive: "PASS", attempt: 1 });
  });

  it("wraps only the existing run API and returns sanitized stability metadata", async () => {
    const { coordinator } = await fixture();
    const base: OperatorControlTaskApi = Object.freeze({ run: async () => denied() });
    const api = createM12StabilityTaskApi(base, coordinator);
    expect(Object.keys(api)).toEqual(["run"]);
    const result = await api.run(request) as any;
    expect(result.stability).toMatchObject({ directive: "RETRY_SAME_PLAN", attempt: 1 });
    expect(result.stability).not.toHaveProperty("stdout");
    expect(result.stability).not.toHaveProperty("worktreePath");
  });

  it("returns only transaction id plus classification during startup recovery", async () => {
    const { coordinator, recovery } = await fixture();
    recovery.residue = [{ txId: request.txId, classification: "SAFE_TO_ROLLBACK" }];
    await expect(coordinator.recoverStartup()).resolves.toEqual([
      { transactionId: request.txId, classification: "SAFE_TO_ROLLBACK" },
    ]);
  });
});
