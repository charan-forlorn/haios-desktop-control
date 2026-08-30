export type RecoveryClassification =
  | "SAFE_TO_CONTINUE"
  | "SAFE_TO_ROLLBACK"
  | "MANUAL_RECONCILIATION_REQUIRED";

export interface RecoveryClassificationInput {
  readonly projectId: "operator-canary" | "skill-fabric" | "hermes-os";
  readonly repositoryIdentity: string;
  readonly transactionId: string;
  readonly leaseOwner: "LIVE" | "DEAD_OR_REUSED" | "UNKNOWN";
  readonly leaseExpired: boolean;
  readonly repositoryMatch: boolean;
  readonly ownership: "EXACT" | "AMBIGUOUS";
  readonly transactionState: "CLEAN" | "MUTATED" | "AMBIGUOUS";
  readonly unresolvedEffects: boolean;
  readonly foreignGitLock: boolean;
}

export const M12_RECOVERY_CLASSIFICATION_DENIED = "M12_RECOVERY_CLASSIFICATION_DENIED" as const;

const FIELDS = new Set([
  "projectId", "repositoryIdentity", "transactionId", "leaseOwner", "leaseExpired",
  "repositoryMatch", "ownership", "transactionState", "unresolvedEffects", "foreignGitLock",
]);
function deny(): never { throw new Error(M12_RECOVERY_CLASSIFICATION_DENIED); }

function data(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return deny();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return deny();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.size || keys.some((key) => typeof key !== "string" || !FIELDS.has(key))) return deny();
  const result: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return deny();
    result[key] = descriptor.value;
  }
  return result;
}

export function classifyRecovery(input: RecoveryClassificationInput): RecoveryClassification {
  const value = data(input);
  if (!["operator-canary", "skill-fabric", "hermes-os"].includes(value.projectId as string)) return deny();
  if (typeof value.repositoryIdentity !== "string" || value.repositoryIdentity.length === 0) return deny();
  if (typeof value.transactionId !== "string" || !/^txn_[a-f0-9]{32}$/u.test(value.transactionId)) return deny();
  if (!["LIVE", "DEAD_OR_REUSED", "UNKNOWN"].includes(value.leaseOwner as string)) return deny();
  if (typeof value.leaseExpired !== "boolean" || typeof value.repositoryMatch !== "boolean"
    || typeof value.unresolvedEffects !== "boolean" || typeof value.foreignGitLock !== "boolean") return deny();
  if (!["EXACT", "AMBIGUOUS"].includes(value.ownership as string)) return deny();
  if (!["CLEAN", "MUTATED", "AMBIGUOUS"].includes(value.transactionState as string)) return deny();

  if (value.foreignGitLock || !value.repositoryMatch || value.ownership !== "EXACT"
    || value.unresolvedEffects || value.transactionState === "AMBIGUOUS" || value.leaseOwner === "UNKNOWN") {
    return "MANUAL_RECONCILIATION_REQUIRED";
  }
  if (value.leaseOwner === "LIVE") {
    return value.leaseExpired ? "MANUAL_RECONCILIATION_REQUIRED" : "SAFE_TO_CONTINUE";
  }
  if (!value.leaseExpired) return "MANUAL_RECONCILIATION_REQUIRED";
  return "SAFE_TO_ROLLBACK";
}
