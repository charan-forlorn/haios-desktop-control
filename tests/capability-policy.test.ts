import { describe, expect, it } from "vitest";

import {
  READ_TOOL_DEFINITIONS,
  classifyGatewayTool,
} from "../src/capabilities.js";
import { authorizeTool } from "../src/policy.js";

const APPROVED_READ_TOOLS = [
  "desktop_status",
  "gateway_status",
  "filesystem_list",
  "filesystem_read",
  "filesystem_read_multiple",
  "filesystem_stat",
  "search_start",
  "search_results",
  "search_stop",
  "search_list",
  "process_list",
  "session_list",
] as const;

const LOCKED_RAW_TOOLS = [
  "write_file",
  "edit_block",
  "start_process",
  "kill_process",
  "force_terminate",
  "set_config_value",
] as const;

describe("READ capability registry", () => {
  it("exposes exactly the approved downstream READ wrappers", () => {
    expect(READ_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual(
      APPROVED_READ_TOOLS,
    );
    expect(READ_TOOL_DEFINITIONS).toHaveLength(APPROVED_READ_TOOLS.length);
    expect(
      READ_TOOL_DEFINITIONS.every(
        ({ capabilityClass }) => capabilityClass === "READ",
      ),
    ).toBe(true);
  });

  it("is immutable at runtime", () => {
    expect(Object.isFrozen(READ_TOOL_DEFINITIONS)).toBe(true);
    expect(
      READ_TOOL_DEFINITIONS.every((definition) => Object.isFrozen(definition)),
    ).toBe(true);
  });
});

describe("gateway tool policy", () => {
  it.each(APPROVED_READ_TOOLS)("classifies and allows %s", (name) => {
    expect(classifyGatewayTool(name)).toBe("READ");
    expect(authorizeTool(name)).toBe("ALLOW");
  });

  it.each(LOCKED_RAW_TOOLS)("denies locked raw tool %s", (name) => {
    expect(classifyGatewayTool(name)).toBe("UNKNOWN");
    expect(authorizeTool(name)).toBe("DENY");
  });

  it.each(["", "unknown_tool", "FILESYSTEM_READ", " filesystem_read"])(
    "fails closed for unknown name %j",
    (name) => {
      expect(classifyGatewayTool(name)).toBe("UNKNOWN");
      expect(authorizeTool(name)).toBe("DENY");
    },
  );
});
