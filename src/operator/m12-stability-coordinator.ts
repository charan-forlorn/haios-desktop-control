import { createHash } from "node:crypto";

import { computeFailureFingerprint, type FailureEffectClass } from "./remediation-fingerprint.js";
import { RemediationController, type RemediationDirective } from "./remediation-controller.js";
import { classifyRecovery, type RecoveryClassificationInput, type RecoveryClassification } from "./recovery-classifier.js";
import type { OperatorControlTaskApi, OperatorPrimitiveResult } from "./control-runtime.js";
import type { OperatorTaskRunRequest, OperatorTaskRunResult } from "./task-runner.js";
import type { OperatorTransactionRecoveryCoordinator } from "./transaction-isolation.js";

export const M12_STABILITY_COORDINATOR_DENIED = "M12_STABILITY_COORDINATOR_DENIED" as const;

export interface M12StabilityFacts {
  readonly projectId: "operator-canary";
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

  async observeTaskResult(request: OperatorTaskRunRequest, result: OperatorTaskRunResult): Promise<M12StabilityResult> {
    validateRequest(request);
    const facts = await this.#facts.inspect(request.txId);
    if (facts === undefined || facts.projectId !== "operator-canary") return deny();
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
    const decision = await this.#remediation.record({
      episodeId: episodeId(request),
      projectId: "operator-canary",
      repositoryIdentity: facts.repositoryIdentity,
      transactionId: request.txId,
      baseHeadSha: facts.baseHeadSha,
      failure: result.decision === "ALLOW" ? "NOT_A_FAILURE" : "REMEDIATION_ELIGIBLE_FAILURE",
      fingerprint,
      invariant: facts.invariant,
      authority: facts.authority,
      currentness: facts.currentness,
      emergency: facts.emergency,
      recovery,
    });
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
  return Object.freeze({
    run: async (request: OperatorTaskRunRequest) => {
      const result = await baseTasks.run(request) as OperatorTaskRunResult;
      const stability = await coordinator.observeTaskResult(request, result);
      return Object.freeze({ ...result, stability });
    },
  });
}
