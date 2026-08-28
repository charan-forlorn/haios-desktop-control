export type GatewayCapabilityClass = "READ" | "EXECUTE" | "MUTATE" | "UNKNOWN";

export interface GatewayToolDefinition {
  readonly name: string;
  readonly capabilityClass: "READ" | "EXECUTE" | "MUTATE";
}

function defineTool(
  name: string,
  capabilityClass: "READ" | "EXECUTE" | "MUTATE",
): Readonly<GatewayToolDefinition> {
  return Object.freeze({ name, capabilityClass });
}

export const READ_TOOL_DEFINITIONS: readonly Readonly<GatewayToolDefinition>[] =
  Object.freeze([
    defineTool("desktop_status", "READ"),
    defineTool("gateway_status", "READ"),
    defineTool("filesystem_list", "READ"),
    defineTool("filesystem_read", "READ"),
    defineTool("filesystem_read_multiple", "READ"),
    defineTool("filesystem_stat", "READ"),
    defineTool("search_start", "READ"),
    defineTool("search_results", "READ"),
    defineTool("search_stop", "READ"),    defineTool("search_list", "READ"),
    defineTool("process_list", "READ"),
    defineTool("session_list", "READ"),
  ]);

export const EXECUTE_TOOL_DEFINITIONS: readonly Readonly<GatewayToolDefinition>[] =
  Object.freeze([
    defineTool("project_test", "EXECUTE"),
    defineTool("project_typecheck", "EXECUTE"),
    defineTool("project_build", "EXECUTE"),
    defineTool("git_status", "EXECUTE"),
    defineTool("git_diff", "EXECUTE"),
    defineTool("git_log", "EXECUTE"),
  ]);

export const MUTATE_TOOL_DEFINITIONS: readonly Readonly<GatewayToolDefinition>[] =
  Object.freeze([
    defineTool("transaction_begin", "MUTATE"),
    defineTool("transaction_stage_create", "MUTATE"),
    defineTool("transaction_stage_replace", "MUTATE"),
    defineTool("transaction_stage_move", "MUTATE"),
    defineTool("transaction_validate", "MUTATE"),
    defineTool("transaction_apply", "MUTATE"),
    defineTool("transaction_rollback", "MUTATE"),
    defineTool("transaction_status", "MUTATE"),
  ]);

const READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  READ_TOOL_DEFINITIONS.map(({ name }) => name),
);
const EXECUTE_TOOL_NAMES: ReadonlySet<string> = new Set(
  EXECUTE_TOOL_DEFINITIONS.map(({ name }) => name),
);
const MUTATE_TOOL_NAMES: ReadonlySet<string> = new Set(
  MUTATE_TOOL_DEFINITIONS.map(({ name }) => name),
);

export function classifyGatewayTool(name: string): GatewayCapabilityClass {
  if (READ_TOOL_NAMES.has(name)) return "READ";
  if (EXECUTE_TOOL_NAMES.has(name)) return "EXECUTE";
  if (MUTATE_TOOL_NAMES.has(name)) return "MUTATE";
  return "UNKNOWN";
}
