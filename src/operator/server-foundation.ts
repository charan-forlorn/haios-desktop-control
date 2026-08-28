import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { GatewayCapabilityClass } from "../capabilities.js";
import {
  OPERATOR_V1_TOOL_NAMES,
  operatorFoundationCapabilities,
  operatorFoundationStatus,
  type OperatorV1ToolName,
} from "./protocol.js";
import { loadTaskRegistry, type BoundTaskRegistry } from "./task-registry.js";

export interface OperatorFoundation {
  readonly registry: BoundTaskRegistry;
  readonly tools: readonly Tool[];
}

export interface OperatorFoundationDispatch {
  readonly capabilityClass: GatewayCapabilityClass;
  readonly result: Readonly<Record<string, unknown>> & { readonly decision: "ALLOW" | "DENY" };
}

const STRING = { type: "string" } as const;
const TX_ID = { ...STRING, minLength: 1 } as const;
const REL_PATH = { ...STRING, minLength: 1, maxLength: 256 } as const;
const SHA256 = { ...STRING, pattern: "^[a-fA-F0-9]{64}$" } as const;
const CONTENT = { ...STRING, maxLength: 16 * 1024 * 1024 } as const;

function objectSchema(
  properties: Record<string, object> = {},
  required: string[] = [],
): Tool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

function operatorSchemas(taskIds: readonly string[]): Record<OperatorV1ToolName, Tool["inputSchema"]> {
  const params = {
    type: "object",
    maxProperties: 32,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "integer" }, { type: "boolean" }],
    },
  } as const;
  return {
    operator_status: objectSchema(),
    operator_capabilities: objectSchema(),
    operator_begin_transaction: objectSchema(
      { projectId: { ...STRING, minLength: 1, maxLength: 64 }, canonicalRoot: { ...STRING, minLength: 1 } },
      ["projectId", "canonicalRoot"],
    ),
    operator_stage_patch: objectSchema(
      { txId: TX_ID, relPath: REL_PATH, preimageSha256: SHA256, newContentBase64: CONTENT },
      ["txId", "relPath", "preimageSha256", "newContentBase64"],
    ),
    operator_stage_create: objectSchema(
      { txId: TX_ID, relPath: REL_PATH, contentBase64: CONTENT },
      ["txId", "relPath", "contentBase64"],
    ),
    operator_stage_move: objectSchema(
      { txId: TX_ID, fromRel: REL_PATH, toRel: REL_PATH, preimageSha256: SHA256 },
      ["txId", "fromRel", "toRel", "preimageSha256"],
    ),
    operator_stage_remove: objectSchema(
      { txId: TX_ID, relPath: REL_PATH, preimageSha256: SHA256 },
      ["txId", "relPath", "preimageSha256"],
    ),
    operator_validate_transaction: objectSchema({ txId: TX_ID }, ["txId"]),
    operator_apply_transaction: objectSchema({ txId: TX_ID }, ["txId"]),
    operator_run_task: objectSchema(
      {
        txId: TX_ID,
        taskId: { type: "string", enum: [...taskIds] },
        params,
      },
      ["txId", "taskId", "params"],
    ),
    operator_rollback_transaction: objectSchema({ txId: TX_ID }, ["txId"]),
    operator_git_checkpoint: objectSchema(
      { txId: TX_ID, message: { ...STRING, minLength: 1, maxLength: 200 } },
      ["txId", "message"],
    ),
    operator_promote_transaction: objectSchema(
      {
        txId: TX_ID,
        expectedHeadSha: { ...STRING, pattern: "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$" },
        checkpointId: { ...STRING, minLength: 1 },
      },
      ["txId", "expectedHeadSha", "checkpointId"],
    ),
  };
}

export function createOperatorToolDefinitions(taskIds: readonly string[]): readonly Tool[] {
  const schemas = operatorSchemas([...taskIds].sort());
  return Object.freeze(OPERATOR_V1_TOOL_NAMES.map((name) => ({
    name,
    description: `HAIOS Level B v1 foundation tool ${name}`,
    inputSchema: schemas[name],
    annotations: {
      readOnlyHint: name === "operator_status" || name === "operator_capabilities",
      destructiveHint: false,
      idempotentHint: name === "operator_status" || name === "operator_capabilities",
      openWorldHint: false,
    },
  } satisfies Tool)));
}

export async function createOperatorFoundation(sourcePath?: string): Promise<OperatorFoundation> {
  const registryPath = sourcePath ?? join(process.cwd(), "task-registry.m05.json");
  const registry = await loadTaskRegistry(registryPath);
  const tools = createOperatorToolDefinitions(Object.keys(registry.registry.tasks));
  return Object.freeze({ registry, tools });
}

export function dispatchOperatorFoundationTool(
  name: string,
  foundation: OperatorFoundation,
): OperatorFoundationDispatch {
  if (name === "operator_status") {
    return {
      capabilityClass: "READ",
      result: Object.freeze({
        decision: "ALLOW",
        ...operatorFoundationStatus(),
        breaker: null,
        version: "0.5.0-foundation",
        taskRegistrySha256: foundation.registry.sha256,
      }),
    };
  }
  if (name === "operator_capabilities") {
    return {
      capabilityClass: "READ",
      result: Object.freeze({
        decision: "ALLOW",
        ...operatorFoundationCapabilities(),
        sandboxes: Object.freeze(["S0", "S1"]),
        modes: Object.freeze(["ACTIVE", "READ_ONLY_EMERGENCY", "DISABLED"]),
        taskRegistryId: foundation.registry.registry.registryId,
        taskRegistryVersion: foundation.registry.registry.version,
        taskRegistrySha256: foundation.registry.sha256,
      }),
    };
  }

  if ((OPERATOR_V1_TOOL_NAMES as readonly string[]).includes(name)) {
    return {
      capabilityClass: "MUTATE",
      result: Object.freeze({ decision: "DENY", reason: "TOOL_DENIED_INACTIVE_MODE" }),
    };
  }
  return {
    capabilityClass: "UNKNOWN",
    result: Object.freeze({ decision: "DENY", reason: "TOOL_DENIED" }),
  };
}
