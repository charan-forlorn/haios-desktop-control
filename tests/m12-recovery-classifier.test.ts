import { describe, expect, it } from "vitest";

import {
  classifyRecovery,
  type RecoveryClassificationInput,
} from "../src/operator/recovery-classifier.js";

const REPO = "C:\\Workspace\\haios-operator-canary\\.git";

function facts(overrides: Partial<RecoveryClassificationInput> = {}): RecoveryClassificationInput {
  return {
    projectId: "operator-canary",
    repositoryIdentity: REPO,
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    leaseOwner: "DEAD_OR_REUSED",
    leaseExpired: true,
    repositoryMatch: true,
    ownership: "EXACT",
    transactionState: "CLEAN",
    unresolvedEffects: false,
    foreignGitLock: false,
    ...overrides,
  };
}

describe("M12 crash-recovery classifier", () => {
  it("classifies an exact dead owner with clean transaction as safe to rollback", () => {
    expect(classifyRecovery(facts())).toBe("SAFE_TO_ROLLBACK");
  });

  it("classifies an exact live owner as safe to continue", () => {
    expect(classifyRecovery(facts({ leaseOwner: "LIVE", leaseExpired: false }))).toBe("SAFE_TO_CONTINUE");
  });

  it.each([
    ["foreign git lock", { foreignGitLock: true }],
    ["repository mismatch", { repositoryMatch: false }],
    ["ambiguous ownership", { ownership: "AMBIGUOUS" as const }],
    ["unknown lease", { leaseOwner: "UNKNOWN" as const }],
    ["unresolved effects", { unresolvedEffects: true }],
    ["ambiguous transaction", { transactionState: "AMBIGUOUS" as const }],
  ])("fails closed for %s", (_name, overrides) => {
    expect(classifyRecovery(facts(overrides))).toBe("MANUAL_RECONCILIATION_REQUIRED");
  });

  it("never converts an expired but still-live exact owner into rollback authority", () => {
    expect(classifyRecovery(facts({ leaseOwner: "LIVE", leaseExpired: true })))
      .toBe("MANUAL_RECONCILIATION_REQUIRED");
  });

  it("rejects malformed caller facts instead of guessing", () => {
    expect(() => classifyRecovery({ ...facts(), projectId: "other" } as unknown as RecoveryClassificationInput))
      .toThrow("M12_RECOVERY_CLASSIFICATION_DENIED");
    expect(() => classifyRecovery({ ...facts(), extra: true } as unknown as RecoveryClassificationInput))
      .toThrow("M12_RECOVERY_CLASSIFICATION_DENIED");
  });

  it("treats a mutated exact dead transaction as rollback-only when effects are resolved", () => {
    expect(classifyRecovery(facts({ transactionState: "MUTATED" }))).toBe("SAFE_TO_ROLLBACK");
  });
});
