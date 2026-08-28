import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import type { DesktopCommanderReadClient } from "../src/upstream.js";

const EXPECTED_TOOLS = [
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
  "project_test",
  "project_typecheck",
  "project_build",
  "git_status",
  "git_diff",
  "git_log",
  "transaction_begin",
  "transaction_stage_create",
  "transaction_stage_replace",
  "transaction_stage_move",
  "transaction_validate",
  "transaction_apply",
  "transaction_rollback",
  "transaction_status",
];

function fakeUpstream(): DesktopCommanderReadClient {
  const value = async () => ({ ok: true });
  return {
    listDirectory: value,
    readFile: value,
    readMultipleFiles: value,
    getFileInfo: value,
    startSearch: value,
    getMoreSearchResults: value,
    stopSearch: value,
    listSearches: value,
    listProcesses: value,
    listSessions: value,
    getConfig: value,
    close: async () => undefined,
  };
}

let runtime: GatewayRuntime | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  client = undefined;
  runtime = undefined;
});

async function connect(apiKey = "test-key") {
  runtime = await createGatewayServer({
    apiKey: "test-key",
    upstream: fakeUpstream(),
    port: 0,
  });
  const address = await runtime.listen();
  client = new Client({ name: "m01-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": apiKey } },
  });
  await client.connect(transport);
  return { address, client };
}

describe("M03 Streamable HTTP gateway", () => {
  it("rejects missing authentication with HTTP 401", async () => {
    runtime = await createGatewayServer({
      apiKey: "test-key",
      upstream: fakeUpstream(),
      port: 0,
    });
    const address = await runtime.listen();
    const response = await fetch(address.url, { method: "GET" });
    expect(response.status).toBe(401);
  });

  it("rejects incorrect authentication", async () => {
    await expect(connect("wrong-key")).rejects.toThrow();
  });

  it("initializes and exposes exactly the M02 READ plus EXECUTE surface", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(listed.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("start_process");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("kill_process");
    const gitDiff = listed.tools.find((tool) => tool.name === "git_diff");
    const gitLog = listed.tools.find((tool) => tool.name === "git_log");
    expect(gitDiff?.inputSchema).toMatchObject({
      properties: { mode: { enum: ["working", "staged"] } },
      additionalProperties: false,
    });
    expect(gitLog?.inputSchema).toMatchObject({
      properties: { maxCount: { minimum: 1, maximum: 20 } },
      additionalProperties: false,
    });
  });
});
