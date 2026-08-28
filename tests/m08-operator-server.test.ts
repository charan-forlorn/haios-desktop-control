import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";
import { createQualifiedOperatorControlRuntime } from "../src/operator/qualified-control-runtime.js";
import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import type { DesktopCommanderReadClient } from "../src/upstream.js";

let gateway: GatewayRuntime | undefined;
let client: Client | undefined;
let upstreamCalls = 0;

function fakeUpstream(): DesktopCommanderReadClient {
  const value = async () => { upstreamCalls += 1; return { ok: true }; };
  return {
    listDirectory: value, readFile: value, readMultipleFiles: value, getFileInfo: value,
    startSearch: value, getMoreSearchResults: value, stopSearch: value, listSearches: value,
    listProcesses: value, listSessions: value, getConfig: value, close: async () => undefined,
  };
}

async function activeRuntime() {
  return createQualifiedOperatorControlRuntime({
    worktreeRoot: join(process.cwd(), "runtime", "m08-server-test-unused"),
    allowedProjects: {},
    registryPath: join(process.cwd(), "task-registry.m07.json"),
    effectPolicyPath: join(process.cwd(), "task-effects.m07.json"),
  });
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n")) as Record<string, unknown>;
}

async function connect(config: Record<string, unknown>) {
  gateway = await createGatewayServer({
    apiKey: "m08-key", upstream: fakeUpstream(), port: 0,
    ...(config as any),
  });
  const address = await gateway.listen();
  client = new Client({ name: "m08-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": "m08-key" } },
  }));
  return client;
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await gateway?.close().catch(() => undefined);
  client = undefined; gateway = undefined; upstreamCalls = 0;
});

describe("M08 explicit Operator activation gate", () => {
  it("preserves default operator13 READ_ONLY_EMERGENCY behavior", async () => {
    const connected = await connect({ protocolMode: "operator13" });
    const status = payload(await connected.callTool({ name: "operator_status", arguments: {} }));
    expect(status).toMatchObject({ mode: "READ_ONLY_EMERGENCY", mutationActive: false });
    const denied = await connected.callTool({ name: "operator_begin_transaction", arguments: { projectId: "demo", canonicalRoot: "C:\\demo" } });
    expect(payload(denied)).toMatchObject({ decision: "DENY", reason: "TOOL_DENIED_INACTIVE_MODE" });
  });

  it("rejects ACTIVE without an injected runtime", async () => {
    await expect(createGatewayServer({
      apiKey: "m08-key", upstream: fakeUpstream(), protocolMode: "operator13", port: 0,
      ...({ operatorMode: "ACTIVE" } as any),
    })).rejects.toThrow("M08_ACTIVE_RUNTIME_REQUIRED");
  });

  it("rejects an injected runtime unless ACTIVE is explicit", async () => {
    const runtime = await activeRuntime();
    await expect(createGatewayServer({
      apiKey: "m08-key", upstream: fakeUpstream(), protocolMode: "operator13", port: 0,
      ...({ operatorRuntime: runtime } as any),
    })).rejects.toThrow("M08_ACTIVE_RUNTIME_NOT_AUTHORIZED");
  });

  it("rejects Operator activation configuration on legacy27", async () => {
    const runtime = await activeRuntime();
    await expect(createGatewayServer({
      apiKey: "m08-key", upstream: fakeUpstream(), protocolMode: "legacy27", port: 0,
      ...({ operatorMode: "ACTIVE", operatorRuntime: runtime } as any),
    })).rejects.toThrow("M08_OPERATOR_CONFIG_PROTOCOL_MISMATCH");
  });

  it("routes controlled ACTIVE through injected runtime while listing only 13 tools", async () => {
    const runtime = await activeRuntime();
    const connected = await connect({ protocolMode: "operator13", operatorMode: "ACTIVE", operatorRuntime: runtime });
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(OPERATOR_V1_TOOL_NAMES);
    expect(listed.tools).toHaveLength(13);
    expect(listed.tools.map((tool) => tool.name)).not.toContain("transaction_apply");
    const runTask = listed.tools.find((tool) => tool.name === "operator_run_task");
    expect(runTask?.inputSchema).toMatchObject({
      properties: { taskId: { enum: Object.keys(runtime.registry.registry.tasks).sort() } },
      additionalProperties: false,
    });

    const status = payload(await connected.callTool({ name: "operator_status", arguments: {} }));
    expect(status).toMatchObject({ mode: "ACTIVE", qualification: "M08_CONTROLLED_WIRING", destructive: "LOCKED" });
    const caps = payload(await connected.callTool({ name: "operator_capabilities", arguments: {} }));
    expect(caps).toMatchObject({ checkpointQualified: true, promotionQualified: true, s2Enabled: false, genericShell: false, genericExec: false });

    expect(upstreamCalls).toBe(0);
  });
});
