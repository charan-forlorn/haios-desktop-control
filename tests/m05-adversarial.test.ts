import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryAuditSink } from "../src/audit.js";
import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";
import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import type { DesktopCommanderMutationClient } from "../src/upstream.js";

const dirs: string[] = [];
let runtime: GatewayRuntime | undefined;
let client: Client | undefined;
let upstreamCalls = 0;

function upstream(): DesktopCommanderMutationClient {
  const called = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_DISPATCH_FORBIDDEN"); };
  return {
    listDirectory: called, readFile: called, readMultipleFiles: called, getFileInfo: called,
    startSearch: called, getMoreSearchResults: called, stopSearch: called,
    listSearches: called, listProcesses: called, listSessions: called, getConfig: called,
    startProcess: called, readProcessOutput: called, killProcess: called,
    writeFile: called, moveFile: called, close: async () => undefined,
  };
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true });
  client = undefined; runtime = undefined; upstreamCalls = 0;
});
function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectOperator(options: { registryPath?: string } = {}) {
  const sink = new MemoryAuditSink();
  runtime = await createGatewayServer({
    apiKey: "m05-key",
    upstream: upstream(),
    protocolMode: "operator13",
    operatorTaskRegistryPath: options.registryPath,
    auditSink: sink,
    port: 0,
  });
  const address = await runtime.listen();
  client = new Client({ name: "m05-adversarial", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": "m05-key" } },
  });
  await client.connect(transport);
  return { client, sink };
}

const MUTATION_NAMES = OPERATOR_V1_TOOL_NAMES.filter(
  (name) => name !== "operator_status" && name !== "operator_capabilities",
);

describe("M05 adversarial protocol reconciliation", () => {
  it.each(MUTATION_NAMES)("denies inactive Operator tool %s before schema/upstream", async (name) => {
    const connected = await connectOperator();
    const denied = await connected.client.callTool({ name, arguments: {} });
    expect(denied.isError).toBe(true);
    expect(payload(denied)).toEqual({ decision: "DENY", reason: "TOOL_DENIED_INACTIVE_MODE" });
    expect(upstreamCalls).toBe(0);
    const event = connected.sink.events.at(-1);
    expect(event).toMatchObject({ tool: name, capabilityClass: "MUTATE", decision: "DENY", resultClass: "DENIED" });
  });

  it.each(["write_file", "project_test", "transaction_apply", "operator_unknown"])(
    "denies undeclared/raw/legacy name %s without upstream",
    async (name) => {
      const connected = await connectOperator();
      const denied = await connected.client.callTool({ name, arguments: {} });
      expect(denied.isError).toBe(true);
      expect(payload(denied)).toEqual({ decision: "DENY", reason: "TOOL_DENIED" });
      expect(upstreamCalls).toBe(0);
    },
  );

  it("never publishes a union of legacy27 and operator13", async () => {
    const connected = await connectOperator();
    const names = (await connected.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(OPERATOR_V1_TOOL_NAMES);
    expect(names).not.toContain("filesystem_read");
    expect(names).not.toContain("transaction_begin");
    expect(names).not.toContain("project_test");
  });

  it("rejects an invalid protocol selector rather than falling back", async () => {
    await expect(createGatewayServer({
      apiKey: "x",
      upstream: upstream(),
      protocolMode: "operator13+legacy27" as never,
      port: 0,
    })).rejects.toThrow("M05_PROTOCOL_MODE_DENIED");
    expect(upstreamCalls).toBe(0);
  });

  it("fails closed when task-registry recipe tries to add shell authority", async () => {
    await mkdir(join(process.cwd(), "runtime"), { recursive: true });
    const dir = await mkdtemp(join(process.cwd(), "runtime", "m05-bad-registry-"));
    dirs.push(dir);
    const registryPath = join(dir, "registry.json");
    await writeFile(registryPath, JSON.stringify({
      registryId: "bad-registry",
      version: "1.0.0",
      tasks: {
        "bad.task": {
          argvTemplate: ["npm", "test"],
          paramSchemas: {},
          requiredParams: [],
          sandboxProfile: "S0",
          effectPolicyRef: "default-artifacts-v1",
          timeoutMs: 1000,
          shell: true,
        },
      },
    }), "utf8");
    await expect(createGatewayServer({
      apiKey: "x", upstream: upstream(), protocolMode: "operator13",
      operatorTaskRegistryPath: registryPath, port: 0,
    })).rejects.toThrow(/TASK_REGISTRY_INVALID/);
    expect(upstreamCalls).toBe(0);
  });

  it("does not disclose executable argv templates through status/capabilities", async () => {
    const connected = await connectOperator();
    const status = payload(await connected.client.callTool({ name: "operator_status", arguments: {} }));
    const caps = payload(await connected.client.callTool({ name: "operator_capabilities", arguments: {} }));
    const serialized = JSON.stringify({ status, caps });
    expect(serialized).not.toContain("argvTemplate");
    expect(serialized).not.toContain('"npm"');
    expect(serialized).not.toContain('"node"');
    expect(caps).toMatchObject({ s2Enabled: false, mutationActive: false, checkpointQualified: false, promotionQualified: false });
    expect(upstreamCalls).toBe(0);
  });

  it("marks only status/capabilities read-only and no tool destructive", async () => {
    const connected = await connectOperator();
    const tools = (await connected.client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint).toBe(false);
      if (tool.name === "operator_status" || tool.name === "operator_capabilities") {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      } else {
        expect(tool.annotations?.readOnlyHint).toBe(false);
      }
    }
  });
});

describe("M05 qualification contract", () => {
  it("binds inactive operator13 live proof, legacy regression, tunnel integrity and cleanup", async () => {
    const { readFile } = await import("node:fs/promises");
    const script = await readFile("scripts/qualify-m05.ps1", "utf8");
    expect(script).toContain("POWERSHELL_7_REQUIRED");
    expect(script).toContain("M05_ADVERSARIAL_TESTS");
    expect(script).toContain("LIVE_OPERATOR_TOOL_COUNT=13");
    expect(script).toContain("LIVE_INACTIVE_MUTATION_DENIAL=PASS");
    expect(script).toContain("LEGACY27_REGRESSION=PASS");
    expect(script).toContain("[StringComparer]::Ordinal");
    expect(script).toContain('($ManifestLines -join "`n") + "`n"');
    expect(script).toContain("TUNNEL_INTEGRITY=PASS");
    expect(script).toContain("RUNTIME_RESIDUE=0");
    expect(script).toContain("SECRETS_PERSISTED=FALSE");
    expect(script).toContain("HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_READY_FOR_INDEPENDENT_VERIFICATION");
  });
});
