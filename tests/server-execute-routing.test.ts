import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { createGatewayServer, type GatewayRuntime } from "../src/server.js";
import type {
  DesktopCommanderExecuteClient,
  DesktopCommanderStartProcessArgs,
} from "../src/upstream.js";

function resultText(text: string) {
  return { content: [{ type: "text", text }] };
}

const STATE = "HAIOS_STATE_BEGIN\nHEAD=stable\nHAIOS_STATE_END\n✅ Process completed with exit code 0";

function fakeExecuteUpstream(): DesktopCommanderExecuteClient & { starts: DesktopCommanderStartProcessArgs[] } {
  const starts: DesktopCommanderStartProcessArgs[] = [];
  let pid = 500;
  let reads = 0;
  const noop = async () => ({ ok: true });
  return {
    starts,
    startProcess: async (args) => {
      starts.push(args);
      pid += 1;
      return resultText(`Process started with PID ${pid} (shell: powershell)`);
    },
    readProcessOutput: async () => {
      reads += 1;
      return resultText(reads === 2 ? "TEST_OK\n✅ Process completed with exit code 0" : STATE);
    },
    killProcess: async () => resultText("killed"),
    listDirectory: noop,
    readFile: noop,
    readMultipleFiles: noop,
    getFileInfo: noop,
    startSearch: noop,
    getMoreSearchResults: noop,
    stopSearch: noop,
    listSearches: noop,
    listProcesses: noop,
    listSessions: noop,
    getConfig: noop,
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
describe("M02 server execute routing", () => {
  it("routes project_test through guarded EXECUTE dispatcher", async () => {
    const upstream = fakeExecuteUpstream();
    runtime = await createGatewayServer({ apiKey: "m02-key", upstream, port: 0 });
    const address = await runtime.listen();

    client = new Client({ name: "m02-routing-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(address.url), {
      requestInit: { headers: { "X-API-Key": "m02-key" } },
    });
    await client.connect(transport);

    const response = await client.callTool({ name: "project_test", arguments: {} });
    const content = response.content as Array<{ type: string; text?: string }>;
    const text = content.map((item) => item.text ?? "").join("\n");

    expect(text).toContain('"decision":"ALLOW"');
    expect(text).toContain("TEST_OK");
    expect(upstream.starts).toHaveLength(3);
  });
});
