import { createHash } from "node:crypto";

import { computeFailureFingerprint, type FailureEffectClass } from "./remediation-fingerprint.js";
import { RemediationController, type RemediationDirective } from "./remediation-controller.js";
import { classifyRecovery, type RecoveryClassificationInput, type RecoveryClassification } from "./recovery-classifier.js";
import type { OperatorControlTaskApi, OperatorPrimitiveResult } from "./control-runtime.js";
import type { OperatorTaskRunRequest, OperatorTaskRunResult } from "./task-runner.js";
import type { OperatorTransactionRecoveryCoordinator } from "./transaction-isolation.js";

export const M12_STABILITY_COORDINATOR_DENIED = "M12_STABILITY_COORDINATOR_DENIED" as const;

export interface M12StabilityFacts {
  readonly projectId: "operator-canary" | "skill-fabric" | "hermes-os";
  readonly repositoryIdentity: string;
  readonly baseHeadSha: string;
  readonly authority: "AUTHORIZED" | "DENIED" | "UNKNOWN";
  readonly currentness: "CURRENT" | "STALE" | "UNKNOWN";
  readonly emergency: "NONE" | "ACTIVE" | "UNKNOWN";
  readonly invariant: { readonly name: string; readonly value: string };
  readonly recovery: RecoveryClassificationInput;
}

export interface M12StabilityFactsProvider {
  inspect(transactionId: string): Promise<M12StabilityFacts | undefined>;
}
export interface M12StabilityCoordinatorConfig {
  readonly remediation: RemediationController;
  readonly facts: M12StabilityFactsProvider;
  readonly recovery?: OperatorTransactionRecoveryCoordinator;
}

export interface M12StabilityResult {
  readonly directive: RemediationDirective;
  readonly attempt: number;
  readonly replanUsed: boolean;
  readonly coarseFingerprint: string;
  readonly fineFingerprint: string;
  readonly progressClassification: string;
  readonly recovery: RecoveryClassification;
}

function deny(): never { throw new Error(M12_STABILITY_COORDINATOR_DENIED); }
function admittedProjectId(value: unknown): value is M12StabilityFacts["projectId"] {
  return value === "operator-canary" || value === "skill-fabric" || value === "hermes-os";
}
function code(value: string, fallback: string): string {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : fallback;
}
function episodeId(request: OperatorTaskRunRequest): string {
  const digest = createHash("sha256").update(`${request.txId}|${request.taskId}`, "utf8").digest("hex");
  return `episode-${digest.slice(0, 32)}`;
}
function effectClass(result: OperatorTaskRunResult): FailureEffectClass {
  const summary = result.metadata.effectSummary;
  if (summary.protected > 0) return "PROTECTED";
  if (summary.unclassified > 0) return "UNCLASSIFIED";
  if (summary.allowedArtifact > 0) return "ALLOWED_ARTIFACT";
  return "NONE";
}
function remediationFailure(result: OperatorTaskRunResult): "REMEDIATION_ELIGIBLE_FAILURE" | "NON_REMEDIABLE_FAILURE" | "NOT_A_FAILURE" {
  if (result.decision === "ALLOW") return "NOT_A_FAILURE";
  return result.reason === "TASK_SANDBOX_FAILED" ? "REMEDIATION_ELIGIBLE_FAILURE" : "NON_REMEDIABLE_FAILURE";
}

function validateRequest(request: OperatorTaskRunRequest): void {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return deny();
  const keys = Reflect.ownKeys(request);
  const expected = new Set(["txId", "taskId", "params", "expectedRegistrySha256"]);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) return deny();
  if (!/^txn_[a-f0-9]{32}$/u.test(request.txId) || !/^[A-Za-z0-9._:-]{1,256}$/u.test(request.taskId)) return deny();
}

function normalizedRecovery(result: OperatorTaskRunResult, facts: M12StabilityFacts): RecoveryClassification {
  if (result.metadata.cleanupStatus === "UNVERIFIED") return "MANUAL_RECONCILIATION_REQUIRED";
  const effect = effectClass(result);
  if (effect === "PROTECTED" || effect === "UNCLASSIFIED") return "SAFE_TO_ROLLBACK";
  return classifyRecovery(facts.recovery);
}

export class M12StabilityCoordinator {
  readonly #remediation: RemediationController;
  readonly #facts: M12StabilityFactsProvider;
  readonly #recovery: OperatorTransactionRecoveryCoordinator | undefined;
  readonly #pendingReplanProofs = new Map<string, Readonly<{ txId: string; taskId: string }>>();

  constructor(config: M12StabilityCoordinatorConfig) {
    const keys = Reflect.ownKeys(config);
    if (keys.some((key) => key !== "remediation" && key !== "facts" && key !== "recovery")) {
      throw new Error(M12_STABILITY_COORDINATOR_DENIED);
    }
    if (!(config.remediation instanceof RemediationController)) throw new Error(M12_STABILITY_COORDINATOR_DENIED);
    this.#remediation = config.remediation;
    this.#facts = config.facts;
    this.#recovery = config.recovery;
  }

  async prepareTaskRun(request: OperatorTaskRunRequest, activeMutableCodeProcess: boolean): Promise<boolean> {
    validateRequest(request);
    if (typeof activeMutableCodeProcess !== "boolean") return deny();
    const id = episodeId(request);
    if (!(await this.#remediation.hasPendingReplan(id))) return false;
    const proof = this.#pendingReplanProofs.get(id);
    if (proof === undefined || proof.txId !== request.txId || proof.taskId !== request.taskId) return deny();
    const facts = await this.#facts.inspect(request.txId);
    if (facts === undefined || !admittedProjectId(facts.projectId) || facts.authority !== "AUTHORIZED"
      || facts.currentness !== "CURRENT" || facts.emergency !== "NONE"
      || facts.recovery.transactionId !== request.txId || facts.recovery.repositoryIdentity !== facts.repositoryIdentity
      || facts.recovery.projectId !== facts.projectId) return deny();
    const recovery = classifyRecovery(facts.recovery);
    const unresolvedTaskEffects = facts.recovery.unresolvedEffects;
    const ownership = facts.recovery.ownership === "EXACT" ? "UNAMBIGUOUS" as const : "AMBIGUOUS" as const;
    if (activeMutableCodeProcess || unresolvedTaskEffects || ownership !== "UNAMBIGUOUS" || recovery !== "SAFE_TO_CONTINUE") return deny();
    const accepted = await this.#remediation.acceptCleanStateReplan(id, {
      activeMutableCodeProcess, unresolvedTaskEffects, ownership, recovery,
    });
    if (!accepted.replanUsed) return deny();
    this.#pendingReplanProofs.delete(id);
    return true;
  }

  async observeTaskResult(request: OperatorTaskRunRequest, result: OperatorTaskRunResult): Promise<M12StabilityResult> {
    validateRequest(request);
    const facts = await this.#facts.inspect(request.txId);
    if (facts === undefined || !admittedProjectId(facts.projectId)) return deny();
    const recovery = normalizedRecovery(result, facts);
    if (facts.recovery.transactionId !== request.txId || facts.recovery.repositoryIdentity !== facts.repositoryIdentity
      || facts.recovery.projectId !== facts.projectId) return deny();
    const reason = result.decision === "ALLOW" ? "TASK_PASS" : code(result.reason, "TASK_FAILURE");
    const fingerprint = computeFailureFingerprint({
      reason,
      taskId: code(request.taskId, "TASK_UNKNOWN"),
      effectClass: effectClass(result),
      currentness: facts.currentness,
      sandboxClass: result.metadata.sandboxProfile ?? "NONE",
      exitCode: result.metadata.exitCode,
      sandboxReason: result.metadata.sandboxReason === null ? null : code(result.metadata.sandboxReason, "UNKNOWN"),
      timedOut: result.metadata.timedOut,
      effectSummary: result.metadata.effectSummary,
    });
    const id = episodeId(request);
    const decision = await this.#remediation.record({
      episodeId: id,
      projectId: facts.projectId,
      repositoryIdentity: facts.repositoryIdentity,
      transactionId: request.txId,
      baseHeadSha: facts.baseHeadSha,
      failure: remediationFailure(result),
      fingerprint,
      invariant: facts.invariant,
      authority: facts.authority,
      currentness: facts.currentness,
      emergency: facts.emergency,
      recovery,
    });
    if (decision.directive === "REPLAN_REQUIRED" && result.metadata.cleanupVerified === true
      && result.metadata.cleanupStatus === "VERIFIED" && recovery === "SAFE_TO_CONTINUE"
      && facts.authority === "AUTHORIZED" && facts.currentness === "CURRENT" && facts.emergency === "NONE") {
      this.#pendingReplanProofs.set(id, Object.freeze({ txId: request.txId, taskId: request.taskId }));
    } else if (decision.directive !== "REPLAN_REQUIRED") {
      this.#pendingReplanProofs.delete(id);
    }
    return Object.freeze({
      ...decision,
      coarseFingerprint: fingerprint.coarse,
      fineFingerprint: fingerprint.fine,
      progressClassification: facts.invariant.name,
      recovery,
    });
  }

  async recoverStartup(): Promise<readonly { readonly transactionId: string; readonly classification: string }[]> {
    if (this.#recovery === undefined) return Object.freeze([]);
    const residue = await this.#recovery.collectOwnedResidue();
    const result: Array<{ transactionId: string; classification: string }> = [];
    for (const record of residue) {
      if (!/^txn_[a-f0-9]{32}$/u.test(record.txId)) return deny();
      const classification = await this.#recovery.recoverOwnedTransaction(record);
      if (!["SAFE_TO_CONTINUE", "SAFE_TO_ROLLBACK", "MANUAL_RECONCILIATION_REQUIRED"].includes(classification)) return deny();
      result.push(Object.freeze({ transactionId: record.txId, classification }));
    }
    return Object.freeze(result);
  }
}

export interface M12StabilityTaskApi extends OperatorControlTaskApi {
  run(request: OperatorTaskRunRequest): Promise<OperatorPrimitiveResult & { readonly stability: M12StabilityResult }>;
}

export function createM12StabilityTaskApi(
  baseTasks: OperatorControlTaskApi,
  coordinator: M12StabilityCoordinator,
): M12StabilityTaskApi {
  if (!(coordinator instanceof M12StabilityCoordinator)) throw new Error(M12_STABILITY_COORDINATOR_DENIED);
  let activeRuns = 0;
  return Object.freeze({
    run: async (request: OperatorTaskRunRequest) => {
      const activeMutableCodeProcess = activeRuns !== 0;
      activeRuns += 1;
      try {
        await coordinator.prepareTaskRun(request, activeMutableCodeProcess);
        const result = await baseTasks.run(request) as OperatorTaskRunResult;
        const stability = await coordinator.observeTaskResult(request, result);
        return Object.freeze({ ...result, stability });
      } finally {
        activeRuns -= 1;
      }
    },
  });
}
