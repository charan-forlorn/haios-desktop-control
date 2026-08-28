import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateHostOperatorLaunchConfig } from "../src/operator/host-runtime-config.js";
import { validateM10ReadOnlyProductionConfig } from "../src/operator/m10-production-config.js";
import {
  createM11ActiveCanaryOperatorRuntime,
  createM11ActiveCanaryReadinessMetadata,
  createM11ActiveCanaryRuntime,
} from "../src/operator/m11-active-canary-runtime.js";
import { dispatchOperatorControlTool } from "../src/operator/control-runtime.js";
import { M08_QUALIFIED_RUNTIME_IDENTITY } from "../src/operator/qualified-control-runtime.js";
import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";

const roots: string[] = [];
const API_KEY = "M11-UNIT-KEY-123456789";
const ORIGINAL_LOCAL_APP_DATA = process.env.LOCALAPPDATA;

async function config() {
  const root = await mkdtemp(join(tmpdir(), "m11-runtime-"));
  roots.push(root);
  process.env.LOCALAPPDATA = root;
  const apiKeyFile = join(root, "HAIOS", "M10", "operator-api-key");
  const worktreeRoot = join(root, "HAIOS", "M11", "worktrees");
  await mkdir(join(root, "HAIOS", "M10"), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(apiKeyFile, API_KEY, "utf8");
  return {
    apiKeyFile,
    worktreeRoot,
    allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary" },
    port: 8769,
    mode: "ACTIVE",
    activationScope: "M11_CANARY_ONLY",
  } as const;
}

afterEach(async () => {
  if (ORIGINAL_LOCAL_APP_DATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCAL_APP_DATA;
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("M11 dedicated ACTIVE-canary runtime", () => {
  it("reports only the canary ACTIVE authority with exact M08 provenance", async () => {
    const input = await config();
    const metadata = createM11ActiveCanaryReadinessMetadata(input);

    expect(metadata).toEqual({
      host: "127.0.0.1",
      port: 8769,
      mode: "ACTIVE",
      protocolMode: "operator13",
      activationScope: "M11_CANARY_ONLY",
      projectIds: ["operator-canary"],
      runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile,
      registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
      effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
      s2Enabled: false,
      genericExec: false,
      genericShell: false,
      destructive: "LOCKED",
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.projectIds)).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain(API_KEY);
    expect(JSON.stringify(metadata)).not.toContain(String(input.apiKeyFile));
    expect(JSON.stringify(metadata)).not.toContain("C:\\Workspace\\haios-operator-canary");
  });

  it("constructs the exact qualified 13-tool runtime without listening on production port", async () => {
    const input = await config();
    const operatorRuntime = await createM11ActiveCanaryOperatorRuntime(input);
    const status = await dispatchOperatorControlTool("operator_status", {}, operatorRuntime);
    const capabilities = await dispatchOperatorControlTool("operator_capabilities", {}, operatorRuntime);
    const deniedProject = await dispatchOperatorControlTool("operator_begin_transaction", {
      projectId: "other-project", canonicalRoot: "C:\\Workspace\\other-project",
    }, operatorRuntime);
    const gateway = await createM11ActiveCanaryRuntime(input);

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
    const m11Scope = {
      apiKeyFile: "C:\\state\\operator-api-key.txt",
      worktreeRoot: "C:\\runtime\\m11-worktrees",
      allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary" },
      port: 8769,
      mode: "ACTIVE",
      activationScope: "M11_CANARY_ONLY",
    };

    expect(() => validateHostOperatorLaunchConfig(m11Scope)).toThrow("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
    expect(() => validateM10ReadOnlyProductionConfig(m11Scope)).toThrow("M10_PRODUCTION_CONFIG_DENIED");
  });
});

describe("M11 ACTIVE-canary launcher", () => {
  it("accepts only one config path and emits readiness metadata with clean signal shutdown", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "run-m11-active-canary-runtime.mjs"), "utf8");

    expect(source).toContain("../dist/src/operator/m11-active-canary-runtime.js");
    expect(source).toContain("process.argv.slice(2)");
    expect(source).toContain("args.length !== 1");
    expect(source).toContain("M11_ACTIVE_CANARY_CONFIG_PATH_REQUIRED");
    expect(source).toContain("JSON.stringify(started.metadata)");
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain("await started.close()");
    expect(source).toContain("M11_ACTIVE_CANARY_RUNTIME_START_FAILED");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("--api-key");
    expect(source).not.toContain("--host");
    expect(source).not.toContain("0.0.0.0");
  });

  it("fails closed for missing or extra launcher arguments", () => {
    const launcher = join(process.cwd(), "scripts", "run-m11-active-canary-runtime.mjs");
    for (const args of [[], ["a.json", "b.json"]]) {
      const result = spawnSync(process.execPath, [launcher, ...args], {
        cwd: process.cwd(), encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("M11_ACTIVE_CANARY_CONFIG_PATH_REQUIRED");
    }
  });
});

