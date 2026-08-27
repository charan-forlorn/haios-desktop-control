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

describe("M01 Streamable HTTP gateway", () => {
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

  it("initializes and exposes exactly the M01 READ tool surface", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(listed.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("start_process");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("kill_process");
  });
});
