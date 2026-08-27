import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { authorizePath } from "../src/paths.js";
import { createGatewayServer } from "../src/server.js";
import { dispatchReadTool } from "../src/tools/read-tools.js";
import type { DesktopCommanderReadClient } from "../src/upstream.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const path of temporaryPaths.splice(0).reverse()) {
    await rm(path, { force: true, recursive: true });
  }
});

function recordingClient(readValue: unknown = { ok: true }) {
  const calls: string[] = [];
  const call = (name: string, value: unknown = { ok: true }) => async () => {
    calls.push(name);
    return value;
  };
  const client: DesktopCommanderReadClient = {
    listDirectory: call("list_directory"),
    readFile: call("read_file", readValue),
    readMultipleFiles: call("read_multiple_files"),
    getFileInfo: call("get_file_info"),    startSearch: call("start_search"),
    getMoreSearchResults: call("get_more_search_results"),
    stopSearch: call("stop_search"),
    listSearches: call("list_searches"),
    listProcesses: call("list_processes"),
    listSessions: call("list_sessions"),
    getConfig: call("get_config"),
    close: async () => undefined,
  };
  return { client, calls };
}

describe("M01 adversarial closure", () => {
  it.each(["write_file", "edit_block", "start_process", "kill_process", "force_terminate", "set_config_value"])(
    "denies raw capability %s before upstream",
    async (name) => {
      const { client, calls } = recordingClient();
      const result = await dispatchReadTool(name, {}, { upstream: client });
      expect(result).toEqual({ decision: "DENY", reason: "TOOL_DENIED" });
      expect(calls).toEqual([]);
    },
  );

  it.each([
    "C:\\Windows\\system.ini",
    "C:\\Workspace\\..\\Windows\\system.ini",
    "C:\\Workspace\\.env",
    "C:\\Workspace\\project\\secrets\\token.txt",
  ])("blocks path attack before upstream: %s", async (path) => {    const { client, calls } = recordingClient();
    const result = await dispatchReadTool("filesystem_read", { path }, { upstream: client });
    expect(result.decision).toBe("DENY");
    expect(calls).toEqual([]);
  });

  it("rejects malformed oversized read arguments before upstream", async () => {
    const { client, calls } = recordingClient();
    const result = await dispatchReadTool(
      "filesystem_read",
      { path: "C:\\Workspace\\haios-desktop-control\\package.json", length: 1000000 },
      { upstream: client },
    );
    expect(result).toEqual({ decision: "DENY", reason: "INVALID_ARGUMENTS" });
    expect(calls).toEqual([]);
  });

  it("bounds an oversized upstream payload without returning its content", async () => {
    const secretMarker = "SHOULD_NOT_ESCAPE_" + "x".repeat(70_000);
    const { client, calls } = recordingClient({ payload: secretMarker });
    const result = await dispatchReadTool(
      "filesystem_read",
      { path: "C:\\Workspace\\haios-desktop-control\\package.json" },
      { upstream: client },
    );
    expect(result.decision).toBe("ALLOW");
    if (result.decision !== "ALLOW") throw new Error("expected allow");
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain("SHOULD_NOT_ESCAPE");
    expect(calls).toEqual(["read_file"]);
  });
  it("denies an existing junction that escapes C:\\Workspace", async () => {
    const inside = await mkdtemp("C:\\Workspace\\haios-m01-adversarial-");
    const outside = await mkdtemp("C:\\tmp\\haios-m01-adversarial-");
    temporaryPaths.push(inside, outside);

    const target = join(outside, "target");
    await mkdir(target);
    const link = join(inside, "escape");
    await symlink(await realpath(target), link, "junction");

    await expect(authorizePath(join(link, "payload.txt"))).resolves.toEqual({
      decision: "DENY",
      reason: "REPARSE_ESCAPE",
    });
  });
  it("does not accept API keys from the query string", async () => {
    const { client } = recordingClient();
    const runtime = await createGatewayServer({ apiKey: "expected-key", upstream: client, port: 0 });
    try {
      const address = await runtime.listen();
      const response = await fetch(`${address.url}?apiKey=expected-key`, { method: "GET" });
      expect(response.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });

});
