import { type FailureFingerprint } from "./remediation-fingerprint.js";
import {
  M12_REMEDIATION_STATE_DENIED,
  RemediationStore,
  isVerifiedRemediationEpisodeRecord,
  type RemediationEpisodeRecord,
  type RemediationEpisodeSnapshot,
  type RemediationRecovery,
} from "./remediation-store.js";

export const M12_REMEDIATION_CONTROLLER_DENIED = "M12_REMEDIATION_CONTROLLER_DENIED" as const;

export type RemediationDirective =
  | "RETRY_SAME_PLAN"
  | "REPLAN_REQUIRED"
  | "ROLLBACK_REQUIRED"
  | "MANUAL_RECONCILIATION_REQUIRED"
  | "AUTONOMOUS_REMEDIATION_STAGNATED"
  | "AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED"
  | "PASS";

export interface RemediationInvariant {
  readonly name: string;
  readonly value: string;
}

/** Facts constructed by the server's transaction/currentness boundary, never tool input. */
export interface RemediationObservation {
  readonly episodeId: string;
  readonly projectId: "operator-canary";
  readonly repositoryIdentity: string;
  readonly transactionId: string;
  readonly baseHeadSha: string;
  readonly failure: "REMEDIATION_ELIGIBLE_FAILURE" | "NOT_A_FAILURE";
  readonly fingerprint: FailureFingerprint;
  readonly invariant: RemediationInvariant;
  readonly authority: "AUTHORIZED" | "DENIED" | "UNKNOWN";
  readonly currentness: "CURRENT" | "STALE" | "UNKNOWN";
  readonly emergency: "NONE" | "ACTIVE" | "UNKNOWN";
  readonly recovery: RemediationRecovery;
}

export interface RemediationDecision {
  readonly directive: RemediationDirective;
  readonly attempt: number;
  readonly replanUsed: boolean;
}

export interface CleanStateReplanPreconditions {
  readonly activeMutableCodeProcess: boolean;
  readonly unresolvedTaskEffects: boolean;
  readonly ownership: "UNAMBIGUOUS" | "AMBIGUOUS";
  readonly recovery: RemediationRecovery;
}

interface NormalizedObservation extends RemediationObservation {
  readonly progressFact: string;
}

const OBSERVATION_FIELDS = new Set([
  "episodeId", "projectId", "repositoryIdentity", "transactionId", "baseHeadSha", "failure", "fingerprint", "invariant",
  "authority", "currentness", "emergency", "recovery",
]);
const INVARIANT_FIELDS = new Set(["name", "value"]);
const FINGERPRINT_FIELDS = new Set(["coarse", "fine"]);
const PRECONDITION_FIELDS = new Set(["activeMutableCodeProcess", "unresolvedTaskEffects", "ownership", "recovery"]);
const RECOVERY_VALUES = new Set<RemediationRecovery>([
  "SAFE_TO_CONTINUE", "SAFE_TO_ROLLBACK", "MANUAL_RECONCILIATION_REQUIRED",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EPISODE_IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const HEAD_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function deny(): never { throw new Error(M12_REMEDIATION_CONTROLLER_DENIED); }

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataFields(value: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string>): ReadonlyMap<string, unknown> {
  if (!isPlainDataObject(value)) return deny();
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); } catch { return deny(); }
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return deny();
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") return deny();
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return deny(); }
    if (descriptor === undefined || !("value" in descriptor)) return deny();
    fields.set(key, descriptor.value);
  }
  for (const key of required) if (!fields.has(key)) return deny();
  return fields;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) return deny();
  return value;
}

function episodeId(value: unknown): string {
  if (typeof value !== "string" || !EPISODE_IDENTIFIER.test(value)) return deny();
  return value;
}

function repositoryIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return deny();
  return value;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) return deny();
  return value;
}

function headSha(value: unknown): string {
  if (typeof value !== "string" || !HEAD_SHA.test(value)) return deny();
  return value;
}

function recovery(value: unknown): RemediationRecovery {
  if (typeof value !== "string" || !RECOVERY_VALUES.has(value as RemediationRecovery)) return deny();
  return value as RemediationRecovery;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return deny();
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) return deny();
  return value as T;
}

function normalizeObservation(value: unknown): NormalizedObservation {
  const fields = ownDataFields(value, OBSERVATION_FIELDS, OBSERVATION_FIELDS);
  if (fields.get("projectId") !== "operator-canary") return deny();
  const fingerprintFields = ownDataFields(fields.get("fingerprint"), FINGERPRINT_FIELDS, FINGERPRINT_FIELDS);
  const invariantFields = ownDataFields(fields.get("invariant"), INVARIANT_FIELDS, INVARIANT_FIELDS);
  const invariantName = identifier(invariantFields.get("name"));
  const invariantValue = identifier(invariantFields.get("value"));
  return Object.freeze({
    episodeId: episodeId(fields.get("episodeId")),
    projectId: "operator-canary" as const,
    repositoryIdentity: repositoryIdentity(fields.get("repositoryIdentity")),
    transactionId: identifier(fields.get("transactionId")),
    baseHeadSha: headSha(fields.get("baseHeadSha")),
    failure: enumValue(fields.get("failure"), new Set(["REMEDIATION_ELIGIBLE_FAILURE", "NOT_A_FAILURE"] as const)),
    fingerprint: Object.freeze({ coarse: sha(fingerprintFields.get("coarse")), fine: sha(fingerprintFields.get("fine")) }),
    invariant: Object.freeze({ name: invariantName, value: invariantValue }),
    authority: enumValue(fields.get("authority"), new Set(["AUTHORIZED", "DENIED", "UNKNOWN"] as const)),
    currentness: enumValue(fields.get("currentness"), new Set(["CURRENT", "STALE", "UNKNOWN"] as const)),
    emergency: enumValue(fields.get("emergency"), new Set(["NONE", "ACTIVE", "UNKNOWN"] as const)),
    recovery: recovery(fields.get("recovery")),
    progressFact: identifier(`${invariantName}:${invariantValue}`),
  });
}

function assertSameEpisode(previous: RemediationEpisodeRecord, observation: NormalizedObservation): void {
  if (previous.episodeId !== observation.episodeId || previous.projectId !== observation.projectId
    || previous.repositoryIdentity !== observation.repositoryIdentity || previous.transactionId !== observation.transactionId
    || previous.baseHeadSha !== observation.baseHeadSha) deny();
}

function safetyDirective(observation: NormalizedObservation): RemediationDirective | undefined {
  if (observation.recovery === "MANUAL_RECONCILIATION_REQUIRED") return "MANUAL_RECONCILIATION_REQUIRED";
  if (observation.recovery === "SAFE_TO_ROLLBACK") return "ROLLBACK_REQUIRED";
  if (observation.authority !== "AUTHORIZED" || observation.currentness !== "CURRENT" || observation.emergency !== "NONE") {
    return "MANUAL_RECONCILIATION_REQUIRED";
  }
  return undefined;
}

function decision(directive: RemediationDirective, attempt: number, replanUsed: boolean): RemediationDecision {
  return Object.freeze({ directive, attempt, replanUsed });
}

export function decideRemediation(previousInput: RemediationEpisodeRecord | undefined, observationInput: RemediationObservation): RemediationDecision {
  const observation = normalizeObservation(observationInput);
  if (previousInput !== undefined && !isVerifiedRemediationEpisodeRecord(previousInput)) deny();
  const previous = previousInput;
  if (previous !== undefined) assertSameEpisode(previous, observation);
  const currentAttempt = previous?.attempt ?? 1;
  const replanUsed = previous?.replanUsed ?? false;

  if (observation.failure === "NOT_A_FAILURE") return decision("PASS", currentAttempt, replanUsed);
  const safety = safetyDirective(observation);
  if (safety !== undefined) return decision(safety, currentAttempt, replanUsed);
  if (previous?.attempt === 5) return decision("AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED", 5, replanUsed);

  const attempt = previous === undefined ? 1 : previous.attempt + 1;
  if (attempt === 5) return decision("AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED", attempt, replanUsed);
  const sameCoarseWithoutProgress = previous !== undefined
    && previous.coarseFingerprint === observation.fingerprint.coarse
    && previous.progressFact === observation.progressFact;
  if (sameCoarseWithoutProgress) {
    return decision(replanUsed ? "AUTONOMOUS_REMEDIATION_STAGNATED" : "REPLAN_REQUIRED", attempt, replanUsed);
  }
  return decision("RETRY_SAME_PLAN", attempt, replanUsed);
}

function normalizeCleanStateReplanPreconditions(value: unknown): CleanStateReplanPreconditions {
  const fields = ownDataFields(value, PRECONDITION_FIELDS, PRECONDITION_FIELDS);
  return Object.freeze({
    activeMutableCodeProcess: boolean(fields.get("activeMutableCodeProcess")),
    unresolvedTaskEffects: boolean(fields.get("unresolvedTaskEffects")),
    ownership: enumValue(fields.get("ownership"), new Set(["UNAMBIGUOUS", "AMBIGUOUS"] as const)),
    recovery: recovery(fields.get("recovery")),
  });
}

function eligibleFailureSnapshot(observation: NormalizedObservation, decisionResult: RemediationDecision): RemediationEpisodeSnapshot {
  return Object.freeze({
    schema: "HAIOS_M12_REMEDIATION_EPISODE_R1" as const,
    episodeId: observation.episodeId,
    projectId: "operator-canary" as const,
    repositoryIdentity: observation.repositoryIdentity,
    transactionId: observation.transactionId,
    baseHeadSha: observation.baseHeadSha,
    attempt: decisionResult.attempt,
    replanUsed: decisionResult.replanUsed,
    coarseFingerprint: observation.fingerprint.coarse,
    fineFingerprint: observation.fingerprint.fine,
    progressFact: observation.progressFact,
    recovery: observation.recovery,
  });
}

export class RemediationController {
  readonly #store: RemediationStore;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(store: RemediationStore) {
    if (!(store instanceof RemediationStore)) throw new Error(M12_REMEDIATION_STATE_DENIED);
    this.#store = store;
  }

  async record(observationInput: RemediationObservation): Promise<RemediationDecision> {
    return this.#serialized(async () => {
      const observation = normalizeObservation(observationInput);
      const previous = await this.#store.load(observation.episodeId);
      const result = decideRemediation(previous, observationInput);
      if (observation.failure === "NOT_A_FAILURE") return result;
      if (result.directive === "REPLAN_REQUIRED") {
        if (previous === undefined) deny();
        await this.#store.saveReplanRequiredTransition(previous, eligibleFailureSnapshot(observation, result));
      } else {
        await this.#store.save(eligibleFailureSnapshot(observation, result));
      }
      return result;
    });
  }

  async acceptCleanStateReplan(episodeIdInput: string, preconditionsInput: CleanStateReplanPreconditions): Promise<RemediationEpisodeRecord> {
    return this.#serialized(async () => {
      const id = episodeId(episodeIdInput);
      const preconditions = normalizeCleanStateReplanPreconditions(preconditionsInput);
      if (preconditions.activeMutableCodeProcess || preconditions.unresolvedTaskEffects || preconditions.ownership !== "UNAMBIGUOUS"
        || preconditions.recovery !== "SAFE_TO_CONTINUE") deny();
      const previous = await this.#store.load(id);
      if (previous === undefined || previous.replanUsed || previous.recovery !== "SAFE_TO_CONTINUE") deny();
      try {
        return await this.#store.acceptPendingReplan(id);
      } catch (error) {
        if (error instanceof Error && error.message === M12_REMEDIATION_STATE_DENIED) deny();
        throw error;
      }
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#operationTail;
    let release: (() => void) | undefined;
    this.#operationTail = new Promise<void>((resolveGate) => { release = resolveGate; });
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
