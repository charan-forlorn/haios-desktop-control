import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { loadHostApiKey } from "../dist/src/operator/host-runtime-config.js";
import { OPERATOR_V1_TOOL_NAMES } from "../dist/src/operator/protocol.js";

const apiKeyFile = resolve(process.argv[2] ?? "");
const resultPath = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) throw new Error("M10_HOST_PROBE_ARGS_REQUIRED");

const endpoint = new URL("http://127.0.0.1:8769/mcp");
const apiKey = await loadHostApiKey(apiKeyFile);
const client = new Client({ name: "m10-production-host-probe", version: "1.0.0" });

const payload = (result) => {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return JSON.parse(text);
};
const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));
const exactTools = (tools) => tools.length === OPERATOR_V1_TOOL_NAMES.length
  && tools.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { "X-API-Key": apiKey } },
  }));
  const listed = await client.listTools();
  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  const denied = await call("operator_begin_transaction", {
    projectId: "m10-denied",
    canonicalRoot: "C:\\m10-denied",
  });

  const result = {
    exact_13_tools: exactTools(listed.tools.map((tool) => tool.name)),
    mode: status.mode,
    mutation_active: status.mutationActive,
    s2_enabled: caps.s2Enabled,
    generic_exec: caps.genericExec,
    generic_shell: caps.genericShell,
    destructive: status.destructive,
    mutation_denied: denied.decision === "DENY" && denied.reason === "TOOL_DENIED_INACTIVE_MODE",
  };
  const pass = result.exact_13_tools
    && result.mode === "READ_ONLY_EMERGENCY"
    && result.mutation_active === false
    && result.s2_enabled === false
    && result.generic_exec === false
    && result.generic_shell === false
    && result.destructive === "LOCKED"
    && result.mutation_denied;
  if (!pass) throw new Error("M10_HOST_PROBE_POLICY_FAILED");

  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
} catch {
  process.exitCode = 2;
} finally {
  await client.close().catch(() => undefined);
}
