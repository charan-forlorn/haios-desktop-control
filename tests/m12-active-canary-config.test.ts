import { win32 } from "node:path";
import { describe, expect, it } from "vitest";

import {
  M12_ACTIVE_CANARY_PRODUCTION_PORT,
  validateM12ActiveCanaryConfig,
} from "../src/operator/m12-active-canary-config.js";

const CANARY_ROOT = "C:\\Workspace\\haios-operator-canary";
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? "C:\\Users\\fixture\\AppData\\Local";
const M10_API_KEY = win32.join(LOCAL_APP_DATA, "HAIOS", "M10", "operator-api-key");
const M12_STATE_ROOT = win32.join(LOCAL_APP_DATA, "HAIOS", "M12");
const M12_WORKTREES = win32.join(M12_STATE_ROOT, "worktrees");

function validConfig(): Record<string, unknown> {
  return {
    apiKeyFile: M10_API_KEY,
    worktreeRoot: M12_WORKTREES,
    stateRoot: M12_STATE_ROOT,
    allowedProjects: { "operator-canary": CANARY_ROOT },
    port: 8769,
    mode: "ACTIVE",
    activationScope: "M12_B5_CANARY_STABILITY_ONLY",
  };
}

describe("M12 B5 canary-stability config boundary", () => {
  it("accepts and freezes only the exact canary authority shape", () => {
    const input = validConfig();
    const result = validateM12ActiveCanaryConfig(input);

    (input.allowedProjects as Record<string, string>).extra = "C:\\projects\\extra";
    input.port = 9999;

    expect(result).toEqual(validConfig());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.allowedProjects)).toBe(true);
    expect(M12_ACTIVE_CANARY_PRODUCTION_PORT).toBe(8769);
  });

  it("rejects anything but one own operator-canary project at its canonical root", () => {
    const inheritedProjects = Object.create({ "operator-canary": CANARY_ROOT }) as Record<string, string>;
    const inheritedExtra = Object.create({ hidden: "C:\\projects\\hidden" }) as Record<string, string>;
    inheritedExtra["operator-canary"] = CANARY_ROOT;

    for (const allowedProjects of [
      {},
      { demo: CANARY_ROOT },
      { "operator-canary": "C:\\Workspace\\other-project" },
      { "operator-canary": "c:\\Workspace\\haios-operator-canary" },
      { "operator-canary": CANARY_ROOT, demo: "C:\\projects\\demo" },
      inheritedProjects,
      inheritedExtra,
      Object.assign(Object.create(null), { "operator-canary": CANARY_ROOT }),
      ["operator-canary"],
    ]) {
      expect(() => validateM12ActiveCanaryConfig({ ...validConfig(), allowedProjects }))
        .toThrow("M12_ACTIVE_CANARY_CONFIG_DENIED");
    }
  });

  it("rejects unknown, inherited, prototype, symbol, and accessor fields", () => {
    const inheritedConfig = Object.create({ port: 8769 }) as Record<string, unknown>;
    Object.assign(inheritedConfig, validConfig());
    delete inheritedConfig.port;
    const symbolConfig = { ...validConfig(), [Symbol("extra")]: true };
    const accessorConfig = validConfig();
    Object.defineProperty(accessorConfig, "port", {
      enumerable: true,
      get() { return 8769; },
    });

    for (const value of [
      null,
      [],
      Object.assign(Object.create(null), validConfig()),
      inheritedConfig,
      { ...validConfig(), host: "127.0.0.1" },
      { ...validConfig(), runtime: {} },
      { ...validConfig(), s2Enabled: true },
      { ...validConfig(), genericExec: true },
      { ...validConfig(), genericShell: true },
      symbolConfig,
      accessorConfig,
    ]) {
      expect(() => validateM12ActiveCanaryConfig(value)).toThrow("M12_ACTIVE_CANARY_CONFIG_DENIED");
    }
  });

  it("rejects inline secret authority and non-file-backed or non-absolute paths", () => {
    for (const value of [
      { ...validConfig(), apiKey: "SENSITIVE-KEY-BYTES" },
      { ...validConfig(), apiKeyValue: "SENSITIVE-KEY-BYTES" },
      { ...validConfig(), apiKeyFile: "SENSITIVE-KEY-BYTES" },
      { ...validConfig(), apiKeyFile: "operator-api-key.txt" },
      { ...validConfig(), apiKeyFile: "\\state\\operator-api-key.txt" },
      { ...validConfig(), worktreeRoot: "m12-worktrees" },
      { ...validConfig(), worktreeRoot: "\\runtime\\m12-worktrees" },
    ]) {
      expect(() => validateM12ActiveCanaryConfig(value)).toThrow("M12_ACTIVE_CANARY_CONFIG_DENIED");
    }
  });

  it("rejects every mode, scope, and port except the live M12 canary values", () => {
    const { activationScope: _activationScope, ...configWithoutScope } = validConfig();

    for (const value of [
      { ...validConfig(), mode: "READ_ONLY_EMERGENCY" },
      { ...validConfig(), mode: "ACTIVE", activationScope: "M09_TEST_ONLY" },
      { ...validConfig(), mode: "ACTIVE", activationScope: "M10_TEST_ONLY" },
      configWithoutScope,
      { ...validConfig(), port: 8768 },
      { ...validConfig(), port: 8774 },
      { ...validConfig(), port: 8769.5 },
      { ...validConfig(), port: "8769" },
    ]) {
      expect(() => validateM12ActiveCanaryConfig(value)).toThrow("M12_ACTIVE_CANARY_CONFIG_DENIED");
    }
  });
});

describe("M12 production path pinning", () => {
  it("rejects alternate API-key, state-root, and transaction-worktree paths", () => {
    for (const value of [
      { ...validConfig(), apiKeyFile: "C:\\state\\operator-api-key.txt" },
      { ...validConfig(), worktreeRoot: "C:\\runtime\\m12-worktrees" },
      { ...validConfig(), stateRoot: "C:\\state\\m12" },
      { ...validConfig(), stateRoot: win32.join(LOCAL_APP_DATA, "HAIOS", "M12", "nested") },
      { ...validConfig(), apiKeyFile: win32.join(LOCAL_APP_DATA, "HAIOS", "M11", "operator-api-key") },
      { ...validConfig(), worktreeRoot: win32.join(LOCAL_APP_DATA, "HAIOS", "M10", "worktrees") },
    ]) {
      expect(() => validateM12ActiveCanaryConfig(value)).toThrow("M12_ACTIVE_CANARY_CONFIG_DENIED");
    }
  });
});
