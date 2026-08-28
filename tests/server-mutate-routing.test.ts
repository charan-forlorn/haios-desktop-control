import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryAuditSink } from "../src/audit.js";
import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { TransactionService } from "../src/transactions/service.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";
import type { DesktopCommanderMutationClient, DesktopCommanderReadClient } from "../src/upstream.js";

const CURRENT: TransactionCurrentness = {
  head: "a".repeat(40), branch: "refs/heads/test", trackedStateDigest: "b".repeat(64),
};
const dirs: string[] = [];
let runtime: GatewayRuntime | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true });
  client = undefined;
  runtime = undefined;
});
function readUpstream(): DesktopCommanderReadClient {
  const value = async () => ({ ok: true });
  return {
    listDirectory: value, readFile: value, readMultipleFiles: value, getFileInfo: value,
    startSearch: value, getMoreSearchResults: value, stopSearch: value,
    listSearches: value, listProcesses: value, listSessions: value, getConfig: value,
    close: async () => undefined,
  };
}

function mutationCapableUpstream(): DesktopCommanderMutationClient {
  const base = readUpstream();
  return {
    ...base,
    startProcess: async () => ({ content: [{ type: "text", text: "Process started with PID 999" }] }),
    readProcessOutput: async () => ({ content: [{ type: "text", text: "Process completed with exit code 0" }] }),
    killProcess: async () => ({ ok: true }),
    writeFile: async () => ({ ok: true }),
    moveFile: async () => ({ ok: true }),
  };
}

function mutationUpstream() {
  return {
    async writeFile(args: { path: string; content: string; mode: "rewrite" }) {
      await mkdir(join(args.path, ".."), { recursive: true });
      await writeFile(args.path, args.content, "utf8");
    },    async moveFile(args: { source: string; destination: string }) {
      await mkdir(join(args.destination, ".."), { recursive: true });
      await rename(args.source, args.destination);
    },
  };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

async function connect(service: TransactionService, sink: MemoryAuditSink) {
  runtime = await createGatewayServer({
    apiKey: "mutate-key", upstream: readUpstream(), transactionService: service, auditSink: sink, port: 0,
  });
  const address = await runtime.listen();
  client = new Client({ name: "m03-routing-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": "mutate-key" } },
  });
  await client.connect(transport);
  return client;
}

describe("M03 MCP mutation routing", () => {
  it("routes exact typed transaction ids without exposing raw mutation primitives", async () => {
    const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-routing-");    dirs.push(root);
    const sink = new MemoryAuditSink();
    const service = new TransactionService({
      currentness: async () => CURRENT,
      adapter: new TransactionMutationAdapter(mutationUpstream()),
      rollbackRoot: root,
      verifier: async () => true,
    });
    const connected = await connect(service, sink);
    const names = (await connected.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("transaction_begin");
    expect(names).toContain("transaction_apply");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("move_file");

    const begun = payload(await connected.callTool({ name: "transaction_begin", arguments: {} }));
    const id = String(begun.transactionId);
    expect(id).toMatch(/^txn_[a-f0-9]{32}$/);
    const target = join(root, "routed-secret.txt");
    const secret = "TOP-SECRET-MUTATION-CONTENT";
    const staged = await connected.callTool({
      name: "transaction_stage_create",
      arguments: { transactionId: id, path: target, content: secret },
    });
    expect(staged.isError).toBeFalsy();
    const wrong = await connected.callTool({
      name: "transaction_stage_create",
      arguments: { transactionId: `txn_${"0".repeat(32)}`, path: join(root, "wrong.txt"), content: "x" },
    });    expect(wrong.isError).toBe(true);
    expect(payload(wrong)).toMatchObject({ decision: "DENY", reason: "TRANSACTION_NOT_FOUND" });
    expect((await connected.callTool({ name: "transaction_validate", arguments: { transactionId: id } })).isError).toBeFalsy();
    const applied = await connected.callTool({ name: "transaction_apply", arguments: { transactionId: id } });
    expect(applied.isError).toBeFalsy();
    expect(payload(applied)).toMatchObject({ decision: "ALLOW", state: "PROMOTED" });
    expect(await readFile(target, "utf8")).toBe(secret);
    const status = payload(await connected.callTool({ name: "transaction_status", arguments: { transactionId: id } }));
    expect(status).toMatchObject({ decision: "ALLOW", state: "PROMOTED", intentCount: 1 });

    const serializedAudit = JSON.stringify(sink.events);
    expect(serializedAudit).not.toContain(secret);
    expect(serializedAudit).not.toContain(target);
    expect(sink.events.filter((event) => event.capabilityClass === "MUTATE")).toHaveLength(6);
  });

  it("auto-wires the transaction service for the pinned mutation-capable upstream", async () => {
    runtime = await createGatewayServer({ apiKey: "mutate-key", upstream: mutationCapableUpstream(), port: 0 });
    const address = await runtime.listen();
    client = new Client({ name: "m03-default-routing-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(address.url), {
      requestInit: { headers: { "X-API-Key": "mutate-key" } },
    });
    await client.connect(transport);    const begun = await client.callTool({ name: "transaction_begin", arguments: {} });
    expect(begun.isError).toBeFalsy();
    expect(payload(begun)).toMatchObject({ decision: "ALLOW", state: "OPEN" });
  });
});
