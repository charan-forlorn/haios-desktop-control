import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadTaskRegistryV2,
  validateTaskRegistryV2,
} from "../src/operator/task-contract-v2.js";
import {
  loadTaskEffectPolicy,
  validateTaskEffectPolicy,
} from "../src/operator/task-effects.js";

const REGISTRY_PATH = join(process.cwd(), "task-registry.m07.json");
const EFFECTS_PATH = join(process.cwd(), "task-effects.m07.json");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function validRegistry() {
  return {
    registryId: "test-registry-v2",
    version: "2.0.0",
    tasks: {
      "node.test.run": {
        argvTemplate: ["node", "--test", "{{testPath}}", "--test-reporter", "{{reporter}}"],
        paramSchemas: {
          testPath: { kind: "relpath", mustExist: true, fileType: "file" },
          reporter: { kind: "enum", values: ["spec", "dot"] },
        },
        requiredParams: ["testPath", "reporter"],
        toolchainProfile: "node22-sandbox-v1",
        sandboxProfile: "S0",
        networkAuthority: "NONE",
        childProcessPolicy: "SANDBOX_OWNED_TREE",
        envAllowlist: ["CI"],
        effectPolicyRef: "default-artifacts-v1",
        timeoutMs: 300_000,
        stdoutMaxBytes: 65_536,
        stderrMaxBytes: 65_536,
      },
    },
  };
}

function validEffectPolicy() {
  return {
    policySetId: "test-effects-v1",
    version: "1.0.0",
    policies: {
      "default-artifacts-v1": {
        allowedArtifactPatterns: ["dist/**", "coverage/**", "*.tsbuildinfo"],
        protectedPatterns: ["src/**", ".env*", "**/.env*"],
      },
    },
  };
}

describe("M07 R1.2-complete task registry contract", () => {
  it("loads the exact four immutable production recipes", async () => {
    const bound = await loadTaskRegistryV2(REGISTRY_PATH);

    expect(bound.registry.registryId).toBe("haios-desktop-control-m07-task-registry");
    expect(Object.keys(bound.registry.tasks)).toEqual([
      "node.test.run", "project.build", "project.test", "project.typecheck",
    ]);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.registry)).toBe(true);
    expect(Object.isFrozen(bound.registry.tasks)).toBe(true);
    expect(Object.isFrozen(bound.registry.tasks["node.test.run"]?.paramSchemas.testPath)).toBe(true);
    expect(Object.isFrozen(bound.registry.tasks["node.test.run"]?.argvTemplate)).toBe(true);
    for (const recipe of Object.values(bound.registry.tasks)) {
      expect(recipe.toolchainProfile).toBe("node22-sandbox-v1");
      expect(recipe.sandboxProfile).toBe("S0");
      expect(recipe.networkAuthority).toBe("NONE");
      expect(recipe.childProcessPolicy).toBe("SANDBOX_OWNED_TREE");
      expect(recipe.envAllowlist).toEqual(["CI"]);
    }
  });

  it("SHA-256 binds exact registry bytes", async () => {
    const bytes = await readFile(REGISTRY_PATH);
    const bound = await loadTaskRegistryV2(REGISTRY_PATH);
    expect(bound.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(bound.sourcePath).toBe(REGISTRY_PATH);
  });

  it("accepts fixed executables and typed whole-element placeholders", () => {
    expect(() => validateTaskRegistryV2(validRegistry())).not.toThrow();
  });

  it.each([
    ["shell", true],
    ["command", "npm test"],
    ["cwd", "C:\\Workspace"],
    ["env", { CI: "1" }],
    ["executable", "powershell.exe"],
    ["unknown", true],
  ] as const)("rejects forbidden or unknown recipe key %s", (key, value) => {
    const raw = validRegistry();
    Object.assign(raw.tasks["node.test.run"], { [key]: value });
    expect(() => validateTaskRegistryV2(raw)).toThrow(/TASK_REGISTRY_V2_INVALID/);
  });

  it("rejects unknown root and parameter-schema keys", () => {
    const root = validRegistry();
    Object.assign(root, { command: "node" });
    expect(() => validateTaskRegistryV2(root)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    const parameter = validRegistry();
    Object.assign(parameter.tasks["node.test.run"].paramSchemas.testPath, { default: "test.js" });
    expect(() => validateTaskRegistryV2(parameter)).toThrow(/TASK_REGISTRY_V2_INVALID/);
  });

  it("rejects executable placeholders, partial placeholders, and undeclared placeholders", () => {
    const executable = validRegistry();
    executable.tasks["node.test.run"].argvTemplate[0] = "{{testPath}}";
    expect(() => validateTaskRegistryV2(executable)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    const partial = validRegistry();
    partial.tasks["node.test.run"].argvTemplate[2] = "--file={{testPath}}";
    expect(() => validateTaskRegistryV2(partial)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    const undeclared = validRegistry();
    undeclared.tasks["node.test.run"].argvTemplate.push("{{unknown}}" as never);
    expect(() => validateTaskRegistryV2(undeclared)).toThrow(/TASK_REGISTRY_V2_INVALID/);
  });

  it("rejects S2 and incompatible network/profile pairs", () => {
    const s2 = validRegistry();
    s2.tasks["node.test.run"].sandboxProfile = "S2";
    expect(() => validateTaskRegistryV2(s2)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    const s0Network = validRegistry();
    s0Network.tasks["node.test.run"].networkAuthority = "FIXTURE_ONLY";
    expect(() => validateTaskRegistryV2(s0Network)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    const s1Network = validRegistry();
    s1Network.tasks["node.test.run"].sandboxProfile = "S1";
    expect(() => validateTaskRegistryV2(s1Network)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    const validS1 = validRegistry();
    validS1.tasks["node.test.run"].sandboxProfile = "S1";
    validS1.tasks["node.test.run"].networkAuthority = "FIXTURE_ONLY";
    expect(() => validateTaskRegistryV2(validS1)).not.toThrow();
  });

  it("requires sandbox-owned child trees and safe explicit environment names", () => {
    const childPolicy = validRegistry();
    childPolicy.tasks["node.test.run"].childProcessPolicy = "INHERIT";
    expect(() => validateTaskRegistryV2(childPolicy)).toThrow(/TASK_REGISTRY_V2_INVALID/);

    for (const name of ["GITHUB_TOKEN", "API_KEY", "PASSWORD", "npm_config_userconfig", "PATH"]) {
      const raw = validRegistry();
      raw.tasks["node.test.run"].envAllowlist = [name];
      expect(() => validateTaskRegistryV2(raw)).toThrow(/TASK_REGISTRY_V2_INVALID/);
    }
  });

  it.each([
    ["timeoutMs", 999], ["timeoutMs", 600_001],
    ["stdoutMaxBytes", 0], ["stdoutMaxBytes", 65_537],
    ["stderrMaxBytes", 0], ["stderrMaxBytes", 65_537],
  ] as const)("rejects out-of-range %s=%s", (key, value) => {
    const raw = validRegistry();
    Object.assign(raw.tasks["node.test.run"], { [key]: value });
    expect(() => validateTaskRegistryV2(raw)).toThrow(/TASK_REGISTRY_V2_INVALID/);
  });
});

describe("M07 fail-closed task effect policy contract", () => {
  it("loads, independently hashes, and deeply freezes the production policy", async () => {
    const registry = await loadTaskRegistryV2(REGISTRY_PATH);
    const bytes = await readFile(EFFECTS_PATH);
    const effects = await loadTaskEffectPolicy(EFFECTS_PATH);

    expect(effects.policySet.policySetId).toBe("haios-desktop-control-m07-task-effects");
    expect(effects.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(effects.sha256).not.toBe(registry.sha256);
    expect(effects.sourcePath).toBe(EFFECTS_PATH);
    expect(Object.isFrozen(effects)).toBe(true);
    expect(Object.isFrozen(effects.policySet.policies["default-artifacts-v1"]?.allowedArtifactPatterns)).toBe(true);
    expect(Object.isFrozen(effects.policySet.policies["default-artifacts-v1"]?.protectedPatterns)).toBe(true);
  });

  it("accepts only exact policy keys and nonempty protected rules", () => {
    expect(() => validateTaskEffectPolicy(validEffectPolicy())).not.toThrow();

    const unknown = validEffectPolicy();
    Object.assign(unknown.policies["default-artifacts-v1"], { allowAll: true });
    expect(() => validateTaskEffectPolicy(unknown)).toThrow(/TASK_EFFECT_POLICY_INVALID/);

    const unprotected = validEffectPolicy();
    unprotected.policies["default-artifacts-v1"].protectedPatterns = [];
    expect(() => validateTaskEffectPolicy(unprotected)).toThrow(/TASK_EFFECT_POLICY_INVALID/);
  });

  it.each(["**/*", "**", "*", "/workspace/**", "../dist/**", "dist\\**", "C:/workspace/**"])(
    "rejects unsafe or overbroad effect pattern %s",
    (pattern) => {
      const raw = validEffectPolicy();
      raw.policies["default-artifacts-v1"].allowedArtifactPatterns = [pattern];
      expect(() => validateTaskEffectPolicy(raw)).toThrow(/TASK_EFFECT_POLICY_INVALID/);
    },
  );

  it("fails closed on malformed JSON without confusing registry and policy bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "haios-m07-contract-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "effects.json");
    await writeFile(path, "{not-json", "utf8");
    await expect(loadTaskEffectPolicy(path)).rejects.toThrow("TASK_EFFECT_POLICY_INVALID:JSON");
  });
});
