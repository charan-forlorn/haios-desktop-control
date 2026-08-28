import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";
import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import type { DesktopCommanderReadClient } from "../src/upstream.js";

let runtime: GatewayRuntime | undefined;
let client: Client | undefined;
let upstreamCalls = 0;

function fakeUpstream(): DesktopCommanderReadClient {
  const value = async () => { upstreamCalls += 1; return { ok: true }; };
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

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  client = undefined;
  upstreamCalls = 0;
});
function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectOperator() {
  runtime = await createGatewayServer({
    apiKey: "operator-key",
    upstream: fakeUpstream(),
    protocolMode: "operator13",
    port: 0,
  });
  const address = await runtime.listen();
  client = new Client({ name: "m05-operator-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": "operator-key" } },
  });
  await client.connect(transport);
  return client;
}

describe("M05 operator13 MCP projection", () => {
  it("lists exactly the canonical 13 tools and no legacy union", async () => {
    const connected = await connectOperator();
    const listed = await connected.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(OPERATOR_V1_TOOL_NAMES);
    expect(names).toHaveLength(13);
    expect(names).not.toContain("filesystem_read");
    expect(names).not.toContain("project_test");
    expect(names).not.toContain("transaction_apply");
    expect(names).not.toContain("write_file");
  });
  it("serves status and capabilities without upstream dispatch", async () => {
    const connected = await connectOperator();
    const status = payload(await connected.callTool({ name: "operator_status", arguments: {} }));
    expect(status).toMatchObject({
      protocol: "operator13",
      mode: "READ_ONLY_EMERGENCY",
      qualification: "M05_FOUNDATION_ONLY",
      mutationActive: false,
      destructive: "LOCKED",
    });
    const capabilities = payload(await connected.callTool({ name: "operator_capabilities", arguments: {} }));
    expect(capabilities).toMatchObject({
      toolCount: 13,
      mutationActive: false,
      checkpointQualified: false,
      promotionQualified: false,
      s2Enabled: false,
      genericShell: false,
      genericExec: false,
    });
    expect(String(capabilities.taskRegistrySha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(upstreamCalls).toBe(0);
  });

  it("denies mutation before any legacy service/upstream dispatch", async () => {
    const connected = await connectOperator();
    const denied = await connected.callTool({
      name: "operator_begin_transaction",
      arguments: { projectId: "project", canonicalRoot: "C:\\Workspace\\project" },
    });
    expect(denied.isError).toBe(true);
    expect(payload(denied)).toMatchObject({
      decision: "DENY",
      reason: "TOOL_DENIED_INACTIVE_MODE",
    });
    expect(upstreamCalls).toBe(0);
  });
  it("advertises bounded canonical schemas including registry task IDs", async () => {
    const connected = await connectOperator();
    const listed = await connected.listTools();
    const runTask = listed.tools.find((tool) => tool.name === "operator_run_task");
    const begin = listed.tools.find((tool) => tool.name === "operator_begin_transaction");
    expect(runTask?.inputSchema).toMatchObject({
      properties: {
        taskId: { enum: ["node.test.run", "project.build", "project.test", "project.typecheck"] },
        params: { type: "object", maxProperties: 32 },
      },
      additionalProperties: false,
    });
    expect(begin?.inputSchema).toMatchObject({
      properties: { projectId: { type: "string" }, canonicalRoot: { type: "string" } },
      required: ["projectId", "canonicalRoot"],
      additionalProperties: false,
    });
  });
});
