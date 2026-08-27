import { describe, expect, it } from "vitest";

import type { DesktopCommanderReadClient } from "../src/upstream.js";
import { dispatchReadTool } from "../src/tools/read-tools.js";

function fakeClient(): DesktopCommanderReadClient & { calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const record = async (name: string, args: unknown = {}) => {
    calls.push({ name, args });
    return { upstream: name, args };
  };
  return {
    calls,
    listDirectory: async (args) => record("list_directory", args),
    readFile: async (args) => record("read_file", args),
    readMultipleFiles: async (args) => record("read_multiple_files", args),
    getFileInfo: async (args) => record("get_file_info", args),
    startSearch: async (args) => record("start_search", args),
    getMoreSearchResults: async (args) => record("get_more_search_results", args),
    stopSearch: async (args) => record("stop_search", args),
    listSearches: async () => record("list_searches"),
    listProcesses: async () => record("list_processes"),
    listSessions: async () => record("list_sessions"),
    getConfig: async () => record("get_config"),
    close: async () => undefined,
  };
}

describe("READ wrappers", () => {
  it("authorizes and normalizes filesystem_list before dispatch", async () => {
    const upstream = fakeClient();
    const result = await dispatchReadTool(
      "filesystem_list",
      { path: "c:/workspace/project", depth: 2 },
      { upstream },
    );
    expect(result.decision).toBe("ALLOW");
    expect(upstream.calls).toEqual([
      {
        name: "list_directory",
        args: { path: "c:\\workspace\\project", depth: 2 },
      },
    ]);
  });

  it("denies a sensitive multi-read before any upstream call", async () => {
    const upstream = fakeClient();
    await expect(
      dispatchReadTool(
        "filesystem_read_multiple",
        { paths: ["C:\\Workspace\\ok.txt", "C:\\Workspace\\.env"] },
        { upstream },
      ),
    ).resolves.toMatchObject({ decision: "DENY" });
    expect(upstream.calls).toEqual([]);
  });

  it("dispatches process_list without filesystem authority", async () => {
    const upstream = fakeClient();
    const result = await dispatchReadTool("process_list", {}, { upstream });
    expect(result.decision).toBe("ALLOW");
    expect(upstream.calls).toEqual([{ name: "list_processes", args: {} }]);
  });

  it("serves gateway_status without upstream access", async () => {
    const upstream = fakeClient();
    const result = await dispatchReadTool("gateway_status", {}, { upstream });
    expect(result).toMatchObject({
      decision: "ALLOW",
      data: {
        readCapability: "QUALIFIED_CANDIDATE",
        executeCapability: "LOCKED",
        mutateCapability: "LOCKED",
        destructiveCapability: "LOCKED",
      },
    });
    expect(upstream.calls).toEqual([]);
  });

  it("bounds oversized upstream results explicitly", async () => {
    const upstream = fakeClient();
    upstream.listProcesses = async () => ({ text: "x".repeat(70000) });
    const result = await dispatchReadTool("process_list", {}, { upstream });
    expect(result).toMatchObject({ decision: "ALLOW", truncated: true });
  });
});
