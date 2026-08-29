import { describe, expect, it } from "vitest";

import {
  computeFailureFingerprint,
  normalizeFailureFingerprintInput,
  type FailureFingerprintInput,
} from "../src/operator/remediation-fingerprint.js";

const baseInput = {
  reason: "TASK_SANDBOX_FAILED",
  exitCode: 1,
  taskId: "project.test",
  effectClass: "NONE",
  currentness: "CURRENT",
} as const satisfies FailureFingerprintInput;

describe("M12 deterministic dual failure fingerprints", () => {
  it("creates stable coarse fingerprints while preserving bounded fine diagnostics", () => {
    const a = computeFailureFingerprint(baseInput);
    const b = computeFailureFingerprint({ ...baseInput, exitCode: 2 });

    expect(a).toEqual({
      coarse: expect.stringMatching(/^[a-f0-9]{64}$/),
      fine: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(a.coarse).toBe(b.coarse);
    expect(a.fine).not.toBe(b.fine);
  });

  it("rejects volatile raw diagnostics from the input type and normalizer", () => {
    // @ts-expect-error Failure fingerprints must never accept raw stdout.
    const typedUnsafeInput: FailureFingerprintInput = { ...baseInput, stdout: "secret output" };
    expect(typedUnsafeInput).toBeDefined();

    for (const volatileField of [
      "stdout", "stderr", "worktreePath", "timestamp", "txId", "pid", "resourceId",
    ]) {
      expect(() => normalizeFailureFingerprintInput({
        ...baseInput,
        [volatileField]: "volatile-value",
      })).toThrow("FAILURE_FINGERPRINT_FIELDS_DENIED");
    }
  });
});
