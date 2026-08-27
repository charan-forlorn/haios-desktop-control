import { describe, expect, it } from "vitest";

import type { DesktopCommanderReadClient } from "../src/upstream.js";
import { dispatchReadTool } from "../src/tools/read-tools.js";

function fakeClient(): DesktopCommanderReadClient & { calls: string[] } {
  const calls: string[] = [];
  const record = async (name: string) => {
    calls.push(name);
    return { ok: true };
  };
  return {
    calls,
    listDirectory: async () => record("list_directory"),
    readFile: async () => record("read_file"),
    readMultipleFiles: async () => record("read_multiple_files"),
    getFileInfo: async () => record("get_file_info"),
    startSearch: async () => record("start_search"),
    getMoreSearchResults: async () => record("get_more_search_results"),
    stopSearch: async () => record("stop_search"),
    listSearches: async () => record("list_searches"),
    listProcesses: async () => record("list_processes"),
    listSessions: async () => record("list_sessions"),
    getConfig: async () => record("get_config"),
    close: async () => undefined,
  };
}

describe("deny-before-upstream", () => {
  it.each([
    "write_file",
    "edit_block",
    "start_process",
    "kill_process",
    "force_terminate",
    "set_config_value",
    "unknown_tool",
  ])("denies %s without any upstream call", async (name) => {
    const upstream = fakeClient();
    await expect(dispatchReadTool(name, {}, { upstream })).resolves.toEqual({
      decision: "DENY",
      reason: "TOOL_DENIED",
    });
    expect(upstream.calls).toEqual([]);
  });
});
