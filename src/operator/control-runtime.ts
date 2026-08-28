import type { GatewayCapabilityClass } from "../capabilities.js";
import { OPERATOR_V1_TOOL_NAMES } from "./protocol.js";
import type { BoundTaskRegistryV2 } from "./task-contract-v2.js";
import type { BoundTaskEffectPolicy } from "./task-effects.js";
import type { OperatorTaskRunRequest } from "./task-runner.js";

export type OperatorPrimitiveResult = ({ readonly decision: "ALLOW" | "DENY" } & object);
export interface OperatorControlTransactionApi {
  begin(projectId: string, canonicalRoot: string): Promise<OperatorPrimitiveResult>;
  stagePatch(txId: string, relPath: string, preimageSha256: string, newContentBase64: string): Promise<OperatorPrimitiveResult>;
  stageCreate(txId: string, relPath: string, contentBase64: string): Promise<OperatorPrimitiveResult>;
  stageMove(txId: string, fromRel: string, toRel: string, preimageSha256: string): Promise<OperatorPrimitiveResult>;
  stageRemove(txId: string, relPath: string, preimageSha256: string): Promise<OperatorPrimitiveResult>;
  validate(txId: string): Promise<OperatorPrimitiveResult>;
  apply(txId: string): Promise<OperatorPrimitiveResult>;
  rollback(txId: string): Promise<OperatorPrimitiveResult>;
  checkpoint(txId: string, message: string): Promise<OperatorPrimitiveResult>;
  promote(txId: string, expectedHeadSha: string, checkpointId: string): Promise<OperatorPrimitiveResult>;
  status(txId: string): Promise<OperatorPrimitiveResult>;
}
export interface OperatorControlTaskApi {
  run(request: OperatorTaskRunRequest): Promise<OperatorPrimitiveResult>;
}

export interface OperatorControlRuntimeConfig {
  readonly transactions: OperatorControlTransactionApi;
  readonly tasks: OperatorControlTaskApi;
  readonly registry: BoundTaskRegistryV2;
  readonly effects: BoundTaskEffectPolicy;
}

export interface OperatorControlRuntime extends OperatorControlRuntimeConfig {
  readonly mode: "ACTIVE";
}

export interface OperatorControlDispatch {
  readonly capabilityClass: GatewayCapabilityClass;
  readonly result: ({ readonly decision: "ALLOW" | "DENY" } & object);
}

function deny(capabilityClass: GatewayCapabilityClass, reason: string): OperatorControlDispatch {
  return { capabilityClass, result: Object.freeze({ decision: "DENY" as const, reason }) };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const candidate = record(value);
  if (candidate === null) return null;
  const actual = Reflect.ownKeys(candidate);
  if (actual.length !== keys.length) return null;
  const expected = new Set(keys);
  if (!actual.every((key) => typeof key === "string" && expected.has(key))) return null;
  return candidate;
}

function stringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function paramsField(value: unknown): value is Record<string, unknown> {
  return record(value) !== null;
}

function capabilityFor(name: string): GatewayCapabilityClass {
  if (name === "operator_status" || name === "operator_capabilities") return "READ";
  if (name === "operator_run_task") return "EXECUTE";
  return (OPERATOR_V1_TOOL_NAMES as readonly string[]).includes(name) ? "MUTATE" : "UNKNOWN";
}

export function createOperatorControlRuntime(config: OperatorControlRuntimeConfig): OperatorControlRuntime {
  return Object.freeze({ ...config, mode: "ACTIVE" as const });
}

export async function dispatchOperatorControlTool(
  name: string,
  args: unknown,
  runtime: OperatorControlRuntime,
): Promise<OperatorControlDispatch> {
  const capabilityClass = capabilityFor(name);
  if (capabilityClass === "UNKNOWN") return deny("UNKNOWN", "TOOL_DENIED");

  if (name === "operator_status") {
    if (exact(args, []) === null) return deny("READ", "OPERATOR_INPUT_FIELDS_DENIED");
    return {
      capabilityClass: "READ",
      result: Object.freeze({
        decision: "ALLOW" as const,
        protocol: "operator13" as const,
        mode: "ACTIVE" as const,
        qualification: "M08_CONTROLLED_WIRING" as const,
        mutationActive: true as const,
        destructive: "LOCKED" as const,
        version: "0.8.0-controlled" as const,
        taskRegistryId: runtime.registry.registry.registryId,
        taskRegistryVersion: runtime.registry.registry.version,
        taskRegistrySha256: runtime.registry.sha256,
        effectPolicySetId: runtime.effects.policySet.policySetId,
        effectPolicyVersion: runtime.effects.policySet.version,
        effectPolicySha256: runtime.effects.sha256,
      }),
    };
  }
  if (name === "operator_capabilities") {
    if (exact(args, []) === null) return deny("READ", "OPERATOR_INPUT_FIELDS_DENIED");
    return {
      capabilityClass: "READ",
      result: Object.freeze({
        decision: "ALLOW" as const,
        toolCount: OPERATOR_V1_TOOL_NAMES.length,
        taskRegistryId: runtime.registry.registry.registryId,
        taskRegistryVersion: runtime.registry.registry.version,
        taskRegistrySha256: runtime.registry.sha256,
        effectPolicySetId: runtime.effects.policySet.policySetId,
        effectPolicyVersion: runtime.effects.policySet.version,
        effectPolicySha256: runtime.effects.sha256,
        sandboxes: Object.freeze(["S0", "S1"] as const),
        modes: Object.freeze(["ACTIVE", "READ_ONLY_EMERGENCY", "DISABLED"] as const),
        mutationActive: true as const,
        checkpointQualified: true as const,
        promotionQualified: true as const,
        s2Enabled: false as const,
        genericShell: false as const,
        genericExec: false as const,
        destructive: "LOCKED" as const,
      }),
    };
  }

  if (name === "operator_begin_transaction") {
    const a = exact(args, ["projectId", "canonicalRoot"]);
    if (a === null || !stringField(a.projectId) || !stringField(a.canonicalRoot)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.begin(a.projectId, a.canonicalRoot) };
  }
  if (name === "operator_stage_patch") {
    const a = exact(args, ["txId", "relPath", "preimageSha256", "newContentBase64"]);
    if (a === null || !stringField(a.txId) || !stringField(a.relPath) || !stringField(a.preimageSha256) || !stringField(a.newContentBase64)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.stagePatch(a.txId, a.relPath, a.preimageSha256, a.newContentBase64) };
  }
  if (name === "operator_stage_create") {
    const a = exact(args, ["txId", "relPath", "contentBase64"]);
    if (a === null || !stringField(a.txId) || !stringField(a.relPath) || !stringField(a.contentBase64)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.stageCreate(a.txId, a.relPath, a.contentBase64) };
  }
  if (name === "operator_stage_move") {
    const a = exact(args, ["txId", "fromRel", "toRel", "preimageSha256"]);
    if (a === null || !stringField(a.txId) || !stringField(a.fromRel) || !stringField(a.toRel) || !stringField(a.preimageSha256)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.stageMove(a.txId, a.fromRel, a.toRel, a.preimageSha256) };
  }
  if (name === "operator_stage_remove") {
    const a = exact(args, ["txId", "relPath", "preimageSha256"]);
    if (a === null || !stringField(a.txId) || !stringField(a.relPath) || !stringField(a.preimageSha256)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.stageRemove(a.txId, a.relPath, a.preimageSha256) };
  }
  if (name === "operator_validate_transaction" || name === "operator_apply_transaction" || name === "operator_rollback_transaction") {
    const a = exact(args, ["txId"]);
    if (a === null || !stringField(a.txId)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    const result = name === "operator_validate_transaction"
      ? await runtime.transactions.validate(a.txId)
      : name === "operator_apply_transaction"
        ? await runtime.transactions.apply(a.txId)
        : await runtime.transactions.rollback(a.txId);
    return { capabilityClass: "MUTATE", result };
  }
  if (name === "operator_run_task") {
    const a = exact(args, ["txId", "taskId", "params"]);
    if (a === null || !stringField(a.txId) || !stringField(a.taskId) || !paramsField(a.params)) return deny("EXECUTE", "OPERATOR_INPUT_FIELDS_DENIED");
    return {
      capabilityClass: "EXECUTE",
      result: await runtime.tasks.run({
        txId: a.txId,
        taskId: a.taskId,
        params: a.params,
        expectedRegistrySha256: runtime.registry.sha256,
      }),
    };
  }
  if (name === "operator_git_checkpoint") {
    const a = exact(args, ["txId", "message"]);
    if (a === null || !stringField(a.txId) || !stringField(a.message)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.checkpoint(a.txId, a.message) };
  }
  if (name === "operator_promote_transaction") {
    const a = exact(args, ["txId", "expectedHeadSha", "checkpointId"]);
    if (a === null || !stringField(a.txId) || !stringField(a.expectedHeadSha) || !stringField(a.checkpointId)) return deny("MUTATE", "OPERATOR_INPUT_FIELDS_DENIED");
    return { capabilityClass: "MUTATE", result: await runtime.transactions.promote(a.txId, a.expectedHeadSha, a.checkpointId) };
  }
  return deny("UNKNOWN", "TOOL_DENIED");
}
