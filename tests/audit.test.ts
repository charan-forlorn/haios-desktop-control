import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryAuditSink } from "../src/audit.js";
import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import type { DesktopCommanderReadClient } from "../src/upstream.js";

let runtime: GatewayRuntime | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  client = undefined;
  runtime = undefined;
});

function secretReturningUpstream(): DesktopCommanderReadClient {
  const generic = async () => ({ ok: true });
  return {
    listDirectory: generic,
    readFile: async () => ({ text: "TOP-SECRET-CONTENT" }),
    readMultipleFiles: generic,
    getFileInfo: generic,
    startSearch: generic,
    getMoreSearchResults: generic,
    stopSearch: generic,
    listSearches: generic,
    listProcesses: generic,
    listSessions: generic,
    getConfig: generic,
    close: async () => undefined,
  };
}

async function connectWithAudit(sink: MemoryAuditSink) {
  runtime = await createGatewayServer({
    apiKey: "audit-key",
    upstream: secretReturningUpstream(),
    auditSink: sink,
    port: 0,
  });
  const address = await runtime.listen();
  client = new Client({ name: "m01-audit-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": "audit-key" } },
  });
  await client.connect(transport);
  return client;
}

describe("metadata-only audit", () => {
  it("records decisions without API keys or upstream file contents", async () => {
    const sink = new MemoryAuditSink();
    const connected = await connectWithAudit(sink);
    await connected.callTool({
      name: "filesystem_read",
      arguments: { path: "C:\\Workspace\\missing-audit-test.txt" },
    });

    expect(sink.events).toHaveLength(1);
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain("audit-key");
    expect(serialized).not.toContain("TOP-SECRET-CONTENT");
    expect(sink.events[0]).toMatchObject({
      tool: "filesystem_read",
      capabilityClass: "READ",
      decision: "ALLOW",
      resultClass: "SUCCESS",
    });
  });
});
