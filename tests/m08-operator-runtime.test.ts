import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadTaskRegistryV2 } from "../src/operator/task-contract-v2.js";
import { loadTaskEffectPolicy } from "../src/operator/task-effects.js";
import {
  createOperatorControlRuntime,
  dispatchOperatorControlTool,
  type OperatorControlTaskApi,
} from "../src/operator/control-runtime.js";

async function setup() {
  const registry = await loadTaskRegistryV2(join(process.cwd(), "task-registry.m07.json"));
  const effects = await loadTaskEffectPolicy(join(process.cwd(), "task-effects.m07.json"));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const allow = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { decision: "ALLOW" as const, state: "OK", transaction: { txId: "txn_test" } };
  };
  const transactions = {
    begin: allow("begin"),
    stagePatch: allow("stagePatch"),
    stageCreate: allow("stageCreate"),
    stageMove: allow("stageMove"),
    stageRemove: allow("stageRemove"),
    validate: allow("validate"),
    apply: allow("apply"),
    rollback: allow("rollback"),
    checkpoint: allow("checkpoint"),
    promote: allow("promote"),
    status: allow("status"),
  };
  const tasks = {
    run: async (request: Parameters<OperatorControlTaskApi["run"]>[0]) => {
      calls.push({ method: "run", args: [request] });
      return { decision: "ALLOW" as const, taskId: request.taskId, metadata: { cleanupStatus: "VERIFIED" } };
    },
  };
  const runtime = createOperatorControlRuntime({ transactions, tasks, registry, effects });
  return { runtime, registry, effects, calls };
}

const SHA40 = "a".repeat(40);
const SHA64 = "b".repeat(64);

describe("M08 controlled Operator runtime", () => {
  it("reports exact ACTIVE capability state bound to M07 identities", async () => {
    const { runtime, registry, effects } = await setup();
    const status = await dispatchOperatorControlTool("operator_status", {}, runtime);
    const capabilities = await dispatchOperatorControlTool("operator_capabilities", {}, runtime);
    expect(status).toMatchObject({ capabilityClass: "READ", result: {
      decision: "ALLOW", protocol: "operator13", mode: "ACTIVE",
      qualification: "M08_CONTROLLED_WIRING", mutationActive: true, destructive: "LOCKED",
      taskRegistrySha256: registry.sha256, effectPolicySha256: effects.sha256,
    }});
    expect(capabilities).toMatchObject({ capabilityClass: "READ", result: {
      decision: "ALLOW", toolCount: 13, checkpointQualified: true, promotionQualified: true,
      s2Enabled: false, genericShell: false, genericExec: false,
    }});
  });

  it.each([
    ["operator_begin_transaction", { projectId: "demo", canonicalRoot: "C:\\demo" }, "begin", ["demo", "C:\\demo"]],
    ["operator_stage_patch", { txId: "txn_test", relPath: "src/a.ts", preimageSha256: SHA64, newContentBase64: "YQ==" }, "stagePatch", ["txn_test", "src/a.ts", SHA64, "YQ=="]],
    ["operator_stage_create", { txId: "txn_test", relPath: "src/new.ts", contentBase64: "YQ==" }, "stageCreate", ["txn_test", "src/new.ts", "YQ=="]],
    ["operator_stage_move", { txId: "txn_test", fromRel: "src/a.ts", toRel: "src/b.ts", preimageSha256: SHA64 }, "stageMove", ["txn_test", "src/a.ts", "src/b.ts", SHA64]],
    ["operator_stage_remove", { txId: "txn_test", relPath: "src/a.ts", preimageSha256: SHA64 }, "stageRemove", ["txn_test", "src/a.ts", SHA64]],
    ["operator_validate_transaction", { txId: "txn_test" }, "validate", ["txn_test"]],
    ["operator_apply_transaction", { txId: "txn_test" }, "apply", ["txn_test"]],
    ["operator_rollback_transaction", { txId: "txn_test" }, "rollback", ["txn_test"]],
    ["operator_git_checkpoint", { txId: "txn_test", message: "m08 checkpoint" }, "checkpoint", ["txn_test", "m08 checkpoint"]],
    ["operator_promote_transaction", { txId: "txn_test", expectedHeadSha: SHA40, checkpointId: SHA40 }, "promote", ["txn_test", SHA40, SHA40]],
  ] as const)("routes %s only to its certified transaction primitive", async (name, args, method, expectedArgs) => {
    const { runtime, calls } = await setup();
    const result = await dispatchOperatorControlTool(name, args, runtime);
    expect(result.capabilityClass).toBe("MUTATE");
    expect(result.result.decision).toBe("ALLOW");
    expect(calls).toEqual([{ method, args: [...expectedArgs] }]);
  });

  it("injects the exact server-bound M07 registry digest into operator_run_task", async () => {
    const { runtime, registry, calls } = await setup();
    const result = await dispatchOperatorControlTool("operator_run_task", {
      txId: "txn_test", taskId: "project.test", params: {},
    }, runtime);
    expect(result.capabilityClass).toBe("EXECUTE");
    expect(result.result.decision).toBe("ALLOW");
    expect(calls).toEqual([{ method: "run", args: [{
      txId: "txn_test", taskId: "project.test", params: {}, expectedRegistrySha256: registry.sha256,
    }] }]);
  });

  it.each([
    "operator_status", "operator_capabilities", "operator_begin_transaction", "operator_stage_patch",
    "operator_stage_create", "operator_stage_move", "operator_stage_remove", "operator_validate_transaction",
    "operator_apply_transaction", "operator_run_task", "operator_rollback_transaction", "operator_git_checkpoint",
    "operator_promote_transaction",
  ])("denies undeclared fields for %s before any primitive dispatch", async (name) => {
    const { runtime, calls } = await setup();
    const minimal: Record<string, unknown> = name === "operator_status" || name === "operator_capabilities" ? {} :
      name === "operator_begin_transaction" ? { projectId: "demo", canonicalRoot: "C:\\demo" } :
      name === "operator_run_task" ? { txId: "txn_test", taskId: "project.test", params: {} } :
      name === "operator_git_checkpoint" ? { txId: "txn_test", message: "m08" } :
      name === "operator_promote_transaction" ? { txId: "txn_test", expectedHeadSha: SHA40, checkpointId: SHA40 } :
      name === "operator_stage_patch" ? { txId: "txn_test", relPath: "src/a.ts", preimageSha256: SHA64, newContentBase64: "YQ==" } :
      name === "operator_stage_create" ? { txId: "txn_test", relPath: "src/a.ts", contentBase64: "YQ==" } :
      name === "operator_stage_move" ? { txId: "txn_test", fromRel: "src/a.ts", toRel: "src/b.ts", preimageSha256: SHA64 } :
      name === "operator_stage_remove" ? { txId: "txn_test", relPath: "src/a.ts", preimageSha256: SHA64 } :
      { txId: "txn_test" };
    const result = await dispatchOperatorControlTool(name, { ...minimal, shell: "cmd.exe" }, runtime);
    expect(result).toMatchObject({ result: { decision: "DENY", reason: "OPERATOR_INPUT_FIELDS_DENIED" } });
    expect(calls).toEqual([]);
  });

  it("fails closed for an unknown tool", async () => {
    const { runtime, calls } = await setup();
    const result = await dispatchOperatorControlTool("operator_shell", {}, runtime);
    expect(result).toEqual({ capabilityClass: "UNKNOWN", result: { decision: "DENY", reason: "TOOL_DENIED" } });
    expect(calls).toEqual([]);
  });
});
