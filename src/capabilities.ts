export type GatewayCapabilityClass = "READ" | "UNKNOWN";

export interface ReadToolDefinition {
  readonly name: string;
  readonly capabilityClass: "READ";
}

function defineReadTool(name: string): Readonly<ReadToolDefinition> {
  return Object.freeze({ name, capabilityClass: "READ" });
}

export const READ_TOOL_DEFINITIONS: readonly Readonly<ReadToolDefinition>[] =
  Object.freeze([
    defineReadTool("desktop_status"),
    defineReadTool("gateway_status"),
    defineReadTool("filesystem_list"),
    defineReadTool("filesystem_read"),
    defineReadTool("filesystem_read_multiple"),
    defineReadTool("filesystem_stat"),
    defineReadTool("search_start"),
    defineReadTool("search_results"),
    defineReadTool("search_stop"),
    defineReadTool("search_list"),
    defineReadTool("process_list"),
    defineReadTool("session_list"),
  ]);

const READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  READ_TOOL_DEFINITIONS.map(({ name }) => name),
);

export function classifyGatewayTool(name: string): GatewayCapabilityClass {
  return READ_TOOL_NAMES.has(name) ? "READ" : "UNKNOWN";
}
