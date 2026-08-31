import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateHostOperatorLaunchConfig } from "../src/operator/host-runtime-config.js";
import { validateM10ReadOnlyProductionConfig } from "../src/operator/m10-production-config.js";
import {
  createM12ActiveCanaryOperatorRuntime,
  createM12ActiveCanaryReadinessMetadata,
  createM12ActiveCanaryRuntime,
  M12RecoveryLeaseHeartbeat,
  scanM12CanonicalGitCommonDirForLocks,
} from "../src/operator/m12-active-canary-runtime.js";
import { dispatchOperatorControlTool } from "../src/operator/control-runtime.js";
import {
  createQualifiedOperatorControlRuntime,
  M08_QUALIFIED_RUNTIME_IDENTITY,
} from "../src/operator/qualified-control-runtime.js";
import * as qualifiedRuntimeAuthority from "../src/operator/qualified-control-runtime.js";
import { isM12ActiveCanaryOperatorRuntime } from "../src/operator/m12-active-canary-operator-core.js";
import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";
import { RecoveryLeaseManager, type ProcessIdentityProbe } from "../src/operator/recovery-lease.js";

const roots: string[] = [];
const API_KEY = "M12-UNIT-KEY-123456789";
const ORIGINAL_LOCAL_APP_DATA = process.env.LOCALAPPDATA;

async function config() {
  const root = await mkdtemp(join(tmpdir(), "m12-runtime-"));
  roots.push(root);
  process.env.LOCALAPPDATA = root;
  const apiKeyFile = join(root, "HAIOS", "M10", "operator-api-key");
  const stateRoot = join(root, "HAIOS", "M12");
  const worktreeRoot = join(stateRoot, "worktrees");
  await mkdir(join(root, "HAIOS", "M10"), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(apiKeyFile, API_KEY, "utf8");
  return {
    apiKeyFile,
    worktreeRoot,
    stateRoot,
    allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary" },
    port: 8769,
    mode: "ACTIVE",
    activationScope: "M12_B5_CANARY_STABILITY_ONLY",
  } as const;
}

afterEach(async () => {
  if (ORIGINAL_LOCAL_APP_DATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCAL_APP_DATA;
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("M12 dedicated B5 canary-stability runtime", () => {
  it("reports only the canary ACTIVE authority with exact M08 provenance", async () => {
    const input = await config();
    const metadata = createM12ActiveCanaryReadinessMetadata(input);

    expect(metadata).toEqual({
      host: "127.0.0.1",
      port: 8769,
      mode: "ACTIVE",
      protocolMode: "operator13",
      activationScope: "M12_B5_CANARY_STABILITY_ONLY",
      projectIds: ["operator-canary"],
      runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile,
      registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
      effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
      s2Enabled: false,
      genericExec: false,
      genericShell: false,
      destructive: "LOCKED",
      remediationBudget: 5,
      cleanStateReplanLimit: 1,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.projectIds)).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain(API_KEY);
    expect(JSON.stringify(metadata)).not.toContain(String(input.apiKeyFile));
    expect(JSON.stringify(metadata)).not.toContain(String(input.stateRoot));
    expect(JSON.stringify(metadata)).not.toContain(String(input.worktreeRoot));
    expect(JSON.stringify(metadata)).not.toContain("C:\\Workspace\\haios-operator-canary");
  });

  it("constructs the exact qualified 13-tool runtime without listening on production port", async () => {
    const input = await config();
    const operatorRuntime = await createM12ActiveCanaryOperatorRuntime(input);
    const status = await dispatchOperatorControlTool("operator_status", {}, operatorRuntime);
    const capabilities = await dispatchOperatorControlTool("operator_capabilities", {}, operatorRuntime);
    const deniedProject = await dispatchOperatorControlTool("operator_begin_transaction", {
      projectId: "other-project", canonicalRoot: "C:\\Workspace\\other-project",
    }, operatorRuntime);
    const gateway = await createM12ActiveCanaryRuntime(input);

    expect(OPERATOR_V1_TOOL_NAMES).toHaveLength(13);
    expect(status).toMatchObject({ result: {
      decision: "ALLOW", protocol: "operator13", mode: "ACTIVE", mutationActive: true,
      taskRegistrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
      effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
      destructive: "LOCKED",
    }});
    expect(capabilities).toMatchObject({ result: {
      decision: "ALLOW", toolCount: 13, mutationActive: true, s2Enabled: false,
      genericExec: false, genericShell: false, destructive: "LOCKED",
    }});
    expect(deniedProject).toEqual({
      capabilityClass: "MUTATE",
      result: { decision: "DENY", reason: "PROJECT_NOT_ALLOWED" },
    });
    await gateway.close();
  });

  it("does not weaken M09 test-only or M10 emergency validation", () => {
    const m12Scope = {
      apiKeyFile: "C:\\state\\operator-api-key.txt",
      worktreeRoot: "C:\\runtime\\m12-worktrees",
      stateRoot: "C:\\state\\m12",
      allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary" },
      port: 8769,
      mode: "ACTIVE",
      activationScope: "M12_B5_CANARY_STABILITY_ONLY",
    };

    expect(() => validateHostOperatorLaunchConfig(m12Scope)).toThrow(/^M09_/u);
    expect(() => validateM10ReadOnlyProductionConfig(m12Scope)).toThrow();
  });
});

describe("M12 ACTIVE-canary launcher", () => {
  it("accepts only one config path and emits readiness metadata with clean signal shutdown", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "run-m12-active-canary-runtime.mjs"), "utf8");

    expect(source).toContain("../dist/src/operator/m12-active-canary-runtime.js");
    expect(source).toContain("process.argv.slice(2)");
    expect(source).toContain("args.length !== 1");
    expect(source).toContain("M12_ACTIVE_CANARY_CONFIG_PATH_REQUIRED");
    expect(source).toContain("JSON.stringify(started.metadata)");
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain("await started.close()");
    expect(source).toContain("M12_ACTIVE_CANARY_RUNTIME_START_FAILED");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("--api-key");
    expect(source).not.toContain("--host");
    expect(source).not.toContain("0.0.0.0");
  });

  it("keeps the M12 supervisor pinned to the M12 launcher and host config", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "run-m12-active-canary-supervisor.mjs"), "utf8");
    expect(source).toContain("run-m12-active-canary-runtime.mjs");
    expect(source).toContain('"HAIOS", "M12", "host-config.json"');
    expect(source).toContain("shell: false");
    expect(source).toContain("DEFAULT_MAX_RESTARTS = 3");
    expect(source).not.toContain("M11");
    expect(source).not.toContain("0.0.0.0");
  });

  it("fails closed for missing or extra launcher arguments", () => {
    const launcher = join(process.cwd(), "scripts", "run-m12-active-canary-runtime.mjs");
    for (const args of [[], ["a.json", "b.json"]]) {
      const result = spawnSync(process.execPath, [launcher, ...args], {
        cwd: process.cwd(), encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("M12_ACTIVE_CANARY_CONFIG_PATH_REQUIRED");
    }
  });
});

describe("M12 runtime recovery ownership hardening", () => {
  it("keeps a long-running owned transaction live only while its bounded heartbeat is healthy", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "m12-heartbeat-"));
    roots.push(stateRoot);
    let now = Date.parse("2026-08-30T00:00:00.000Z");
    const probe: ProcessIdentityProbe = { inspect: async () => ({ alive: true, startTime: "2026-08-30T00:00:00.000Z" }) };
    const manager = new RecoveryLeaseManager({ stateRoot, processProbe: probe, now: () => now });
    const transactionId = "txn_0123456789abcdef0123456789abcdef";
    await manager.acquire({
      projectId: "operator-canary", repositoryIdentity: "C:\\repo\\.git", transactionId,
      ownerPid: 4242, ownerStartTime: "2026-08-30T00:00:00.000Z", ttlMs: 300_000,
    });
    let scheduled: (() => void) | undefined;
    const heartbeat = new M12RecoveryLeaseHeartbeat({
      leases: manager, transactionId, owner: { ownerPid: 4242, ownerStartTime: "2026-08-30T00:00:00.000Z" },
      intervalMs: 60_000,
      schedule: (callback) => { scheduled = callback; return 1; },
      cancel: () => { scheduled = undefined; },
    });

    heartbeat.start();
    now += 240_000;
    scheduled?.();
    await heartbeat.flush();

    expect(await manager.inspect(transactionId)).toMatchObject({ owner: "LIVE", expired: false });
    heartbeat.assertHealthy();
    heartbeat.stop();
  });

  it("fails closed after a heartbeat failure and never renews after a simulated crash", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "m12-heartbeat-failure-"));
    roots.push(stateRoot);
    let now = Date.parse("2026-08-30T00:00:00.000Z");
    const identity = "2026-08-30T00:00:00.000Z";
    const probe: { state: { alive: boolean; startTime: string }; inspect(pid: number): Promise<{ alive: boolean; startTime: string }> } = {
      state: { alive: true, startTime: identity }, inspect: async () => probe.state,
    };
    const manager = new RecoveryLeaseManager({ stateRoot, processProbe: probe, now: () => now });
    const transactionId = "txn_abcdef0123456789abcdef0123456789";
    await manager.acquire({ projectId: "operator-canary", repositoryIdentity: "C:\\repo\\.git", transactionId, ownerPid: 4242, ownerStartTime: identity, ttlMs: 300_000 });
    const heartbeat = new M12RecoveryLeaseHeartbeat({
      leases: manager, transactionId, owner: { ownerPid: 4242, ownerStartTime: identity }, intervalMs: 60_000,
      schedule: () => 1, cancel: () => undefined,
    });

    heartbeat.start();
    probe.state = { alive: false, startTime: identity };
    await heartbeat.pulse();
    expect(() => heartbeat.assertHealthy()).toThrow("M12_RECOVERY_HEARTBEAT_FAILED");
    now += 600_000;
    expect(await manager.inspect(transactionId)).toMatchObject({ owner: "DEAD_OR_REUSED", expired: true });
    heartbeat.stop();
  });

  it("detects nested Git locks and reparse ambiguity before forced worktree removal", async () => {
    const commonDir = await mkdtemp(join(tmpdir(), "m12-common-dir-"));
    roots.push(commonDir);
    await mkdir(join(commonDir, "logs", "refs", "heads"), { recursive: true });
    await writeFile(join(commonDir, "logs", "refs", "heads", "canary.lock"), "locked", "utf8");
    expect(await scanM12CanonicalGitCommonDirForLocks(commonDir)).toBe(true);
    await rm(join(commonDir, "logs"), { recursive: true, force: true });
    await mkdir(join(commonDir, "safe"), { recursive: true });
    await symlink(join(commonDir, "safe"), join(commonDir, "ambiguous"), "junction");
    expect(await scanM12CanonicalGitCommonDirForLocks(commonDir)).toBe(true);
  });

  it("accepts only the exact config-driven M12 core runtime as M12", async () => {
    const input = await config();
    const callerCreatedLegacyRuntime = await createQualifiedOperatorControlRuntime({
      worktreeRoot: input.worktreeRoot,
      allowedProjects: { "arbitrary-project": "C:\\Workspace\\arbitrary-project" },
      registryPath: join(process.cwd(), "task-registry.m07.json"),
      effectPolicyPath: join(process.cwd(), "task-effects.m07.json"),
    });
    const exactM12Runtime = await createM12ActiveCanaryOperatorRuntime(input);
    const gateway = await createM12ActiveCanaryRuntime(input);

    expect(isM12ActiveCanaryOperatorRuntime(callerCreatedLegacyRuntime)).toBe(false);
    expect(isM12ActiveCanaryOperatorRuntime(exactM12Runtime)).toBe(true);
    expect(Object.keys(qualifiedRuntimeAuthority).filter((name) => /m12|bless|derive/iu.test(name))).toEqual([]);

    await gateway.close();
  });
});
