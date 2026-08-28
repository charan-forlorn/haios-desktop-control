import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOperatorControlRuntime } from "../src/operator/control-runtime.js";
import {
  createQualifiedOperatorControlRuntime,
  isQualifiedOperatorControlRuntime,
  M08_QUALIFIED_RUNTIME_IDENTITY,
} from "../src/operator/qualified-control-runtime.js";
import { loadTaskRegistryV2 } from "../src/operator/task-contract-v2.js";
import { loadTaskEffectPolicy } from "../src/operator/task-effects.js";
import { createGatewayServer } from "../src/server.js";
import type { DesktopCommanderReadClient } from "../src/upstream.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

function fakeUpstream(): DesktopCommanderReadClient {
  const value = async () => ({});
  return {
    listDirectory: value, readFile: value, readMultipleFiles: value, getFileInfo: value,
    startSearch: value, getMoreSearchResults: value, stopSearch: value, listSearches: value,
    listProcesses: value, listSessions: value, getConfig: value, close: async () => undefined,
  };
}

async function qualified() {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "m08-qualified-runtime-"));
  roots.push(worktreeRoot);
  return createQualifiedOperatorControlRuntime({
    worktreeRoot,
    allowedProjects: {},
    registryPath: join(process.cwd(), "task-registry.m07.json"),
    effectPolicyPath: join(process.cwd(), "task-effects.m07.json"),
  });
}

async function structuralFake() {
  const registry = await loadTaskRegistryV2(join(process.cwd(), "task-registry.m07.json"));
  const effects = await loadTaskEffectPolicy(join(process.cwd(), "task-effects.m07.json"));
  const allow = async () => ({ decision: "ALLOW" as const });
  return createOperatorControlRuntime({
    transactions: {
      begin: allow, stagePatch: allow, stageCreate: allow, stageMove: allow, stageRemove: allow,
      validate: allow, apply: allow, rollback: allow, checkpoint: allow, promote: allow, status: allow,
    },
    tasks: { run: allow }, registry, effects,
  });
}
describe("M08 qualified runtime provenance", () => {
  it("brands only the internally constructed M06/M07 runtime stack", async () => {
    const runtime = await qualified();
    expect(isQualifiedOperatorControlRuntime(runtime)).toBe(true);
    expect(runtime.attestation).toEqual(M08_QUALIFIED_RUNTIME_IDENTITY);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(isQualifiedOperatorControlRuntime(await structuralFake())).toBe(false);
  });

  it("rejects a structural fake at the ACTIVE server boundary", async () => {
    const fake = await structuralFake();
    await expect(createGatewayServer({
      apiKey: "m08-key", upstream: fakeUpstream(), protocolMode: "operator13",
      operatorMode: "ACTIVE", operatorRuntime: fake as any, port: 0,
    })).rejects.toThrow("M08_ACTIVE_RUNTIME_UNQUALIFIED");
  });

  it("accepts a branded runtime at the ACTIVE server boundary", async () => {
    const runtime = await qualified();
    const gateway = await createGatewayServer({
      apiKey: "m08-key", upstream: fakeUpstream(), protocolMode: "operator13",
      operatorMode: "ACTIVE", operatorRuntime: runtime, port: 0,
    });
    await gateway.close();
  });
  it("fails closed if registry bytes drift from the qualified identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "m08-registry-drift-"));
    roots.push(root);
    const registryPath = join(root, "registry.json");
    await copyFile(join(process.cwd(), "task-registry.m07.json"), registryPath);
    await writeFile(registryPath, `${await readFile(registryPath, "utf8")} `, "utf8");
    await expect(createQualifiedOperatorControlRuntime({
      worktreeRoot: join(root, "worktrees"), allowedProjects: {}, registryPath,
      effectPolicyPath: join(process.cwd(), "task-effects.m07.json"),
    })).rejects.toThrow("M08_QUALIFIED_REGISTRY_IDENTITY_MISMATCH");
  });

  it("fails closed if effect-policy bytes drift from the qualified identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "m08-effect-drift-"));
    roots.push(root);
    const effectPolicyPath = join(root, "effects.json");
    await copyFile(join(process.cwd(), "task-effects.m07.json"), effectPolicyPath);
    await writeFile(effectPolicyPath, `${await readFile(effectPolicyPath, "utf8")} `, "utf8");
    await expect(createQualifiedOperatorControlRuntime({
      worktreeRoot: join(root, "worktrees"), allowedProjects: {},
      registryPath: join(process.cwd(), "task-registry.m07.json"), effectPolicyPath,
    })).rejects.toThrow("M08_QUALIFIED_EFFECT_POLICY_IDENTITY_MISMATCH");
  });
});
