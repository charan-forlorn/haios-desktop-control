import { describe, expect, it } from "vitest";

import {
  EXECUTE_TOOL_DEFINITIONS,
  READ_TOOL_DEFINITIONS,
  classifyGatewayTool,
} from "../src/capabilities.js";
import { authorizeTool } from "../src/policy.js";

const EXECUTE_NAMES = [
  "project_test",
  "project_typecheck",
  "project_build",
  "git_status",
  "git_diff",
  "git_log",
] as const;

const RAW_LOCKED = [
  "start_process",
  "interact_with_process",
  "kill_process",
  "force_terminate",
  "write_file",
  "set_config_value",
] as const;

describe("M02 execute capability registry", () => {
  it("keeps the M01 READ surface at exactly 12 tools", () => {
    expect(READ_TOOL_DEFINITIONS).toHaveLength(12);
  });
  it("defines exactly six immutable EXECUTE wrappers", () => {
    expect(EXECUTE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(EXECUTE_NAMES);
    expect(Object.isFrozen(EXECUTE_TOOL_DEFINITIONS)).toBe(true);
    expect(EXECUTE_TOOL_DEFINITIONS.every(Object.isFrozen)).toBe(true);
  });

  it.each(EXECUTE_NAMES)("classifies %s as EXECUTE", (name) => {
    expect(classifyGatewayTool(name)).toBe("EXECUTE");
    expect(authorizeTool(name)).toBe("DENY");
    expect(authorizeTool(name, "EXECUTE")).toBe("ALLOW");
  });

  it.each(RAW_LOCKED)("keeps raw capability %s denied", (name) => {
    expect(classifyGatewayTool(name)).toBe("UNKNOWN");
    expect(authorizeTool(name, "EXECUTE")).toBe("DENY");
  });

  it("fails closed when the requested authorization class is wrong", () => {
    expect(authorizeTool("filesystem_read", "EXECUTE")).toBe("DENY");
    expect(authorizeTool("project_test", "READ")).toBe("DENY");
  });
});
