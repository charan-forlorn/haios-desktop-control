import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHostApiKey } from "../dist/src/operator/host-runtime-config.js";
import { OPERATOR_V1_TOOL_NAMES } from "../dist/src/operator/protocol.js";

const expectedStage = process.argv[2];
if (expectedStage !== "SKILL_FABRIC" && expectedStage !== "HERMES_OS") throw new Error("B6_PROBE_STAGE_REQUIRED");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("B6_PROBE_LOCALAPPDATA_REQUIRED");
const configPath = resolve(localAppData, "HAIOS", "B6", "host-config.json");
const apiKeyFile = resolve(localAppData, "HAIOS", "M10", "operator-api-key");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.stage !== expectedStage) throw new Error("B6_PROBE_STAGE_DRIFT");
const expectedScope = expectedStage === "SKILL_FABRIC" ? "B6_SKILL_FABRIC_ADMISSION" : "B6_HERMES_OS_ADMISSION";
if (config.activationScope !== expectedScope) throw new Error("B6_PROBE_SCOPE_DRIFT");
const apiKey = await loadHostApiKey(apiKeyFile);
const client = new Client({ name: "b6-project-expansion-host-probe", version: "1.0.0" });
const payload = (result) => JSON.parse(result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"));
const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));
const exactTools = (tools) => tools.length === OPERATOR_V1_TOOL_NAMES.length && tools.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8769/mcp"), { requestInit: { headers: { "X-API-Key": apiKey } } }));
  const listed = await client.listTools();
  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  const denied = await call("operator_begin_transaction", { projectId: "b6-denied", canonicalRoot: "C:\\Workspace\\b6-denied" });
  let hermesOsDenied = true;
  if (expectedStage === "SKILL_FABRIC") {
    const hermesDenied = await call("operator_begin_transaction", { projectId: "hermes-os", canonicalRoot: "C:\\Workspace\\hermes-ai-operating-system-b6-canonical" });
    hermesOsDenied = hermesDenied.decision === "DENY" && hermesDenied.reason === "PROJECT_NOT_ALLOWED";
  }
  const result = {
    exact_13_tools: exactTools(listed.tools.map((tool) => tool.name)), mode: status.mode, protocol: status.protocol,
    mutation_active: status.mutationActive, s2_enabled: caps.s2Enabled, generic_exec: caps.genericExec, generic_shell: caps.genericShell,
    destructive: status.destructive, stage: expectedStage, activation_scope: config.activationScope,
    unknown_project_denied: denied.decision === "DENY" && denied.reason === "PROJECT_NOT_ALLOWED", hermes_os_denied: hermesOsDenied,
  };
  if (!result.exact_13_tools || result.mode !== "ACTIVE" || result.protocol !== "operator13" || result.mutation_active !== true
    || result.s2_enabled !== false || result.generic_exec !== false || result.generic_shell !== false || result.destructive !== "LOCKED"
    || !result.unknown_project_denied || !result.hermes_os_denied) throw new Error("B6_HOST_CAPABILITY_DRIFT");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await client.close().catch(() => undefined);
}
