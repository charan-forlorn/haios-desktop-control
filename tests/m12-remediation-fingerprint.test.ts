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

  it("canonicalizes equivalent effect summaries regardless of insertion order", () => {
    const summaryA = {
      total: 3,
      allowedArtifact: 1,
      unclassified: 1,
      protected: 1,
      complete: true,
    };
    const summaryB = {
      complete: true,
      protected: 1,
      unclassified: 1,
      allowedArtifact: 1,
      total: 3,
    };

    expect(computeFailureFingerprint({ ...baseInput, effectSummary: summaryA }))
      .toEqual(computeFailureFingerprint({ ...baseInput, effectSummary: summaryB }));
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

  it("rejects root and nested accessor fields without invoking their getters", () => {
    let getterCalls = 0;
    const rootAccessorInput = { ...baseInput } as Record<string, unknown>;
    Object.defineProperty(rootAccessorInput, "reason", {
      enumerable: true,
      get: () => { getterCalls += 1; return baseInput.reason; },
    });
    const nestedAccessorInput = {
      ...baseInput,
      effectSummary: {
        total: 0,
        allowedArtifact: 0,
        unclassified: 0,
        protected: 0,
      },
    } as Record<string, unknown>;
    Object.defineProperty(nestedAccessorInput.effectSummary as object, "complete", {
      enumerable: true,
      get: () => { getterCalls += 1; return false; },
    });

    expect(() => normalizeFailureFingerprintInput(rootAccessorInput))
      .toThrow("FAILURE_FINGERPRINT_INPUT_DENIED");
    expect(() => normalizeFailureFingerprintInput(nestedAccessorInput))
      .toThrow("FAILURE_FINGERPRINT_EFFECT_SUMMARY_DENIED");
    expect(getterCalls).toBe(0);
  });

  it("rejects inherited prototype-polluted fields without invoking their getter", () => {
    let getterCalls = 0;
    const priorReason = Object.getOwnPropertyDescriptor(Object.prototype, "reason");
    Object.defineProperty(Object.prototype, "reason", {
      configurable: true,
      get: () => { getterCalls += 1; return baseInput.reason; },
    });
    try {
      const inheritedInput = {
        exitCode: baseInput.exitCode,
        taskId: baseInput.taskId,
        effectClass: baseInput.effectClass,
        currentness: baseInput.currentness,
      };
      expect(() => normalizeFailureFingerprintInput(inheritedInput))
        .toThrow("FAILURE_FINGERPRINT_INPUT_DENIED");
      expect(getterCalls).toBe(0);
    } finally {
      if (priorReason === undefined) delete (Object.prototype as { reason?: unknown }).reason;
      else Object.defineProperty(Object.prototype, "reason", priorReason);
    }
  });

  it("rejects non-plain prototypes before reading inherited accessors", () => {
    let getterCalls = 0;
    const prototype = Object.create(Object.prototype);
    Object.defineProperty(prototype, "reason", {
      enumerable: true,
      get: () => { getterCalls += 1; return baseInput.reason; },
    });
    const nonPlainInput = Object.assign(Object.create(prototype), {
      exitCode: baseInput.exitCode,
      taskId: baseInput.taskId,
      effectClass: baseInput.effectClass,
      currentness: baseInput.currentness,
    });

    expect(() => normalizeFailureFingerprintInput(nonPlainInput))
      .toThrow("FAILURE_FINGERPRINT_INPUT_DENIED");
    expect(getterCalls).toBe(0);
  });
});
