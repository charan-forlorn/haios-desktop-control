import { describe, expect, it } from "vitest";

import {
  M10_PREFLIGHT_PORT,
  M10_PRODUCTION_PORT,
  validateM10ReadOnlyProductionConfig,
} from "../src/operator/m10-production-config.js";

function validConfig(): Record<string, unknown> {
  return {
    apiKeyFile: "C:\\state\\operator-api-key",
    worktreeRoot: "C:\\runtime\\worktrees",
    allowedProjects: {},
    port: 8769,
    mode: "READ_ONLY_EMERGENCY",
  };
}

describe("M10 read-only production config boundary", () => {
  it("accepts only the exact production emergency shape", () => {
    const result = validateM10ReadOnlyProductionConfig(validConfig());
    expect(result).toEqual(validConfig());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.allowedProjects)).toBe(true);
    expect(M10_PRODUCTION_PORT).toBe(8769);
    expect(M10_PREFLIGHT_PORT).toBe(8774);
  });

  it("rejects ACTIVE, scope, alternate production port, and project authority", () => {
    const bad = [
      { ...validConfig(), mode: "ACTIVE", activationScope: "M09_TEST_ONLY" },
      { ...validConfig(), activationScope: "M09_TEST_ONLY" },
      { ...validConfig(), port: 8774 },
      { ...validConfig(), allowedProjects: { demo: "C:\\demo" } },
    ];
    for (const value of bad) {
      expect(() => validateM10ReadOnlyProductionConfig(value))
        .toThrow("M10_PRODUCTION_CONFIG_DENIED");
    }
  });

  it("rejects every caller-controlled runtime or transport authority field", () => {
    for (const field of [
      "host", "runtime", "upstream", "operatorRuntime", "registryPath",
      "effectPolicyPath", "executable", "env", "tunnelId", "dockerSocket",
    ]) {
      expect(() => validateM10ReadOnlyProductionConfig({ ...validConfig(), [field]: {} }))
        .toThrow("M09_HOST_CONFIG_INVALID");
    }
  });

  it("preserves the M09 path-validation error semantics", () => {
    expect(() => validateM10ReadOnlyProductionConfig({ ...validConfig(), apiKeyFile: "relative.key" }))
      .toThrow("M09_HOST_CONFIG_INVALID");
  });
});
