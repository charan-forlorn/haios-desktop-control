import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";

const harnessPath = join(process.cwd(), "scripts", "qualify-m12-disposable-b5.mjs");
const execFileAsync = promisify(execFile);
let result: Record<string, any>;
let outputRoot: string;

async function source(): Promise<string> {
  return readFile(harnessPath, "utf8");
}

beforeAll(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "m12-disposable-b5-test-"));
  await execFileAsync(process.execPath, [
    harnessPath, "--run-id", "remediation-contract", "--port", "19083", "--output-root", outputRoot,
  ], { cwd: process.cwd(), windowsHide: true });
  result = JSON.parse(await readFile(join(outputRoot, "m12-disposable-b5-result.json"), "utf8")) as Record<string, any>;
}, 30_000);

afterAll(async () => { if (outputRoot !== undefined) await rm(outputRoot, { recursive: true, force: true }); });

describe("M12 disposable B5 qualification evidence provenance", () => {
  it("uses the exact public operator protocol and qualified dispatch rather than semantic aliases or lower-level services", async () => {
    const text = await source();

    expect(OPERATOR_V1_TOOL_NAMES).toEqual([
      "operator_status", "operator_capabilities", "operator_begin_transaction",
      "operator_stage_patch", "operator_stage_create", "operator_stage_move",
      "operator_stage_remove", "operator_validate_transaction", "operator_apply_transaction",
      "operator_run_task", "operator_rollback_transaction", "operator_git_checkpoint",
      "operator_promote_transaction",
    ]);
    expect(text).toContain('OPERATOR_V1_TOOL_NAMES');
    expect(text).toContain('dispatchOperatorControlTool');
    expect(text).toContain('createM12DisposableB5FixtureRuntime');
    expect(text).not.toContain('new OperatorTransactionService');
    expect(text).not.toContain('new M12StabilityCoordinator');
    expect(text).not.toContain('"transaction.begin"');
  });

  it("rejects the protected canary root and every canonical Windows descendant before fixture creation", async () => {
    const text = await source();

    expect(text).toContain('M12_DISPOSABLE_PROTECTED_ROOT_DENIED');
    expect(text).toContain('win32.relative');
    expect(text).toContain('M12_ACTIVE_CANARY_PROJECT_ROOT');
    expect(text).toContain('isProtectedCanaryPath');
    await expect(execFileAsync(process.execPath, [
      harnessPath, "--run-id", "protected-descendant", "--port", "19085",
      "--output-root", "C:\\Workspace\\haios-operator-canary\\task8-descendant",
    ], { cwd: process.cwd(), windowsHide: true })).rejects.toThrow("M12_DISPOSABLE_PROTECTED_ROOT_DENIED");
  });

  it("does not trampoline through a shell or build the root repository", async () => {
    const text = await source();

    expect(text).not.toMatch(/cmd\.exe|ComSpec|npm\.cmd/iu);
    expect(text).not.toMatch(/npm[\s\S]{0,80}run[\s\S]{0,80}build/iu);
  });

  it("routes every public transaction and task pattern through the disposable M12 runtime dispatcher", async () => {
    const text = await source();

    for (const name of [
      "operator_begin_transaction", "operator_stage_patch", "operator_stage_create",
      "operator_validate_transaction", "operator_apply_transaction", "operator_run_task",
      "operator_git_checkpoint", "operator_promote_transaction", "operator_rollback_transaction",
    ]) expect(text).toContain(name);
    expect(text).toContain('dispatch(runtime, "operator_run_task"');
  });

  it("measures stale-CAS cleanup through public rollback without a fixture bypass", async () => {
    const text = await source();

    expect(text).toContain('staleRollback.decision === "ALLOW"');
    expect(text).toContain('staleRollback.state === "ROLLED_BACK"');
    expect(text).not.toContain('cleanupLastDeniedStaleTransaction');
    expect(result.patterns.staleCas).toMatchObject({
      passed: true,
      publicRollbackAccepted: true,
      publicRollbackState: "ROLLED_BACK",
      staleMutationAbsent: true,
    });
  });

  it("drives foreign-lock preservation through an actual M12 recovery attempt", async () => {
    const text = await source();

    expect(text).toContain('recoverAfterSimulatedOwnerDeath');
    expect(text).toContain('MANUAL_RECONCILIATION_REQUIRED');
    expect(text).toContain('foreignRecovery');
    expect(text).toContain('cleanupRecovery');
  });

  it("derives inventories and normalized conclusions from observations rather than proof-shaped literals", async () => {
    const text = await source();

    expect(text).toContain('inspectOwnedResidue');
    expect(text).toContain('ownedRecoveryRecords');
    expect(text).toContain('ownedLeaseRecords');
    expect(text).not.toContain('allPatternsPassed: true');
    expect(text).not.toContain('zeroOwnedResidue: true');
    expect(text).not.toContain('authorityExpanded: false');
    expect(text).not.toContain('ffOnly: true');
    expect(text).not.toContain('casBound: true');
  });

  it("measures clean-state replan acceptance after the same episode reaches REPLAN_REQUIRED", () => {
    expect(result.patterns.autonomousRemediation.cleanStateReplanAccepted).toBe(true);
  });

  it("measures PASS as a continuation of the episode that requested replan", () => {
    expect(result.patterns.autonomousRemediation.passContinuesReplanEpisode).toBe(true);
  });

  it("measures the real controller/store stagnation terminal", () => {
    expect(result.patterns.autonomousRemediation.stagnation.directive).toBe("AUTONOMOUS_REMEDIATION_STAGNATED");
    expect(result.patterns.autonomousRemediation.stagnation.durable).toBe(true);
  });

  it("measures the real controller/store budget terminal", () => {
    expect(result.patterns.autonomousRemediation.budget.directive).toBe("AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED");
    expect(result.patterns.autonomousRemediation.budget.durable).toBe(true);
  });

  it("never executes caller-staged worktree JavaScript while qualifying the fixed data fixture", () => {
    const isolation = result.patterns.hostCodeIsolation;

    expect(isolation).toMatchObject({
      passed: true,
      maliciousWorktreeJsNeverExecuted: true,
      fixedRunnerOutsideWorktree: true,
      networkAuthority: "NONE",
      protectedWriteAttempted: false,
    });
    expect(isolation.taskDecision).toBe("ALLOW");
  });

  it("makes every remediation pass gate independently necessary", () => {
    const remediation = result.patterns.autonomousRemediation;
    const requiredGates = [
      "retrySamePlan",
      "replanRequired",
      "stableFingerprints",
      "replanAcceptedExactlyOnce",
      "sameEpisodePass",
      "sameAttemptLineage",
      "attemptsWithinBudget",
      "durableStagnationTerminal",
      "durableBudgetTerminal",
      "rollbackCompleted",
    ];

    expect(remediation.passed).toBe(true);
    for (const gate of requiredGates) {
      expect(remediation.gates[gate]).toBe(true);
      expect(remediation.missingGatePasses[gate]).toBe(false);
    }
  });

  it("binds the allowed artifact task to the exact transaction classified by recovery", () => {
    const recovery = result.patterns.lockEffectRecovery;

    expect(recovery.passed).toBe(true);
    expect(recovery.allowedArtifactEffect).toBe(true);
    expect(recovery.effectTransactionId).toBe(recovery.recoveredTransactionId);
    expect(recovery.effectTaskId).toBe("project.test");
  });
});
