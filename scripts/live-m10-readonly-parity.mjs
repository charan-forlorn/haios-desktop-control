import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createHostOperatorRuntime } from "../dist/src/operator/host-runtime.js";
import { OPERATOR_V1_TOOL_NAMES } from "../dist/src/operator/protocol.js";

const run = promisify(execFile);
const runtimeRoot = resolve(process.argv[2] ?? "");
const resultPath = resolve(process.argv[3] ?? "");
const directPort = Number(process.argv[4] ?? 8774);
const tunnelProxyPort = Number(process.argv[5] ?? 18774);
if (!process.argv[2] || !process.argv[3]) throw new Error("M10_PARITY_ARGS_REQUIRED");
if (directPort !== 8774 || tunnelProxyPort !== 18774) throw new Error("M10_PARITY_PORT_DENIED");

const worktreeRoot = join(runtimeRoot, "worktrees");
const apiKeyFile = join(runtimeRoot, "m10-api-key.txt");
const apiKey = randomBytes(24).toString("hex");
await mkdir(worktreeRoot, { recursive: true });
await writeFile(apiKeyFile, apiKey, "utf8");
const gateway = await createHostOperatorRuntime({
  apiKeyFile,
  worktreeRoot,
  allowedProjects: {},
  port: directPort,
  mode: "READ_ONLY_EMERGENCY",
});
const address = await gateway.listen();
const client = new Client({ name: "m10-readonly-direct", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(address.url), {
  requestInit: { headers: { "X-API-Key": apiKey } },
}));

const payload = (result) => {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return JSON.parse(text);
};
const call = async (target, name, args = {}) => payload(await target.callTool({ name, arguments: args }));
const exactTools = (tools) => tools.length === OPERATOR_V1_TOOL_NAMES.length
  && tools.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
const validStatus = (status) => status.mode === "READ_ONLY_EMERGENCY"
  && status.mutationActive === false
  && status.destructive === "LOCKED";
const validCapabilities = (caps) => caps.mutationActive === false
  && caps.s2Enabled === false
  && caps.genericExec === false
  && caps.genericShell === false;
const validDenial = (denied) => denied.decision === "DENY"
  && denied.reason === "TOOL_DENIED_INACTIVE_MODE";

let directExactToolSurface = false;
let directStatusPassed = false;
let directCapabilitiesPassed = false;
let directMutationDenied = false;
let tunnelExactToolSurface = false;
let tunnelStatusPassed = false;
let tunnelCapabilitiesPassed = false;
let tunnelMutationDenied = false;
let tunnelContainerRemoved = false;
let tunnelLogsSecretFree = false;
let apiKeyFileRemoved = false;
let tunnelProcess;
let tunnelStdout = "";
let tunnelStderr = "";

const tunnelImage = "ghcr.io/openai/tunnel-client:v0.0.11";
const syntheticTunnelId = "tunnel_33333333333333333333333333333333";
const tunnelContainerName = `haios-m10-readonly-${process.pid}-${randomBytes(4).toString("hex")}`;
const tunnelTargetUrl = `http://host.docker.internal:${directPort}/mcp`;
const tunnelProxyUrl = `http://127.0.0.1:${tunnelProxyPort}/v1/mcp/${syntheticTunnelId}`;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const appendBounded = (current, chunk) => (current + chunk.toString("utf8")).slice(-1024 * 1024);

try {
  const listed = await client.listTools();
  directExactToolSurface = exactTools(listed.tools.map((tool) => tool.name));
  const status = await call(client, "operator_status");
  const caps = await call(client, "operator_capabilities");
  const denied = await call(client, "operator_begin_transaction", {
    projectId: "demo",
    canonicalRoot: "C:\\m10-denied",
  });
  directStatusPassed = validStatus(status);
  directCapabilitiesPassed = validCapabilities(caps);
  directMutationDenied = validDenial(denied);
  if (!directExactToolSurface || !directStatusPassed || !directCapabilitiesPassed || !directMutationDenied) {
    throw new Error("M10_DIRECT_READONLY_PARITY_FAILED");
  }

  const tunnelArgs = [
    "run", "--rm", "--name", tunnelContainerName,
    "--label", "haios.m10.owner=readonly-parity",
    "--entrypoint", "/usr/bin/tunnel-client",
    "-p", `127.0.0.1:${tunnelProxyPort}:8783`,
    "--mount", `type=bind,source=${apiKeyFile},target=/run/secrets/m10-api-key,readonly`,
    "-e", "MCP_EXTRA_HEADERS=X-API-Key: file:/run/secrets/m10-api-key",
    tunnelImage,
    "dev", "proxy",
    "--backend", "go",
    "--listen", "0.0.0.0:8783",
    "--mcp-server-url", tunnelTargetUrl,
    "--tunnel-id", syntheticTunnelId,
    "--duration", "45s",
    "--print-json",
  ];
  tunnelProcess = spawn("docker", tunnelArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tunnelProcess.stdout?.on("data", (chunk) => { tunnelStdout = appendBounded(tunnelStdout, chunk); });
  tunnelProcess.stderr?.on("data", (chunk) => { tunnelStderr = appendBounded(tunnelStderr, chunk); });

  let tunnelClient;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && tunnelClient === undefined) {
    const candidate = new Client({ name: "m10-readonly-tunnel", version: "1.0.0" });
    try {
      await candidate.connect(new StreamableHTTPClientTransport(new URL(tunnelProxyUrl)));
      tunnelClient = candidate;
    } catch {
      await candidate.close().catch(() => undefined);
      await sleep(250);
    }
  }
  if (tunnelClient === undefined) throw new Error("M10_TUNNEL_CONNECT_FAILED");
  try {
    const listed = await tunnelClient.listTools();
    tunnelExactToolSurface = exactTools(listed.tools.map((tool) => tool.name));
    const status = await call(tunnelClient, "operator_status");
    const caps = await call(tunnelClient, "operator_capabilities");
    const denied = await call(tunnelClient, "operator_begin_transaction", {
      projectId: "demo",
      canonicalRoot: "C:\\m10-denied",
    });
    tunnelStatusPassed = validStatus(status);
    tunnelCapabilitiesPassed = validCapabilities(caps);
    tunnelMutationDenied = validDenial(denied);
    if (!tunnelExactToolSurface || !tunnelStatusPassed || !tunnelCapabilitiesPassed || !tunnelMutationDenied) {
      throw new Error("M10_TUNNEL_READONLY_PARITY_FAILED");
    }
  } finally {
    await tunnelClient.close().catch(() => undefined);
  }
} finally {
  await client.close().catch(() => undefined);
  if (tunnelProcess !== undefined) {
    await run("docker", ["rm", "-f", tunnelContainerName], { windowsHide: true }).catch(() => undefined);
  }
  const residue = await run("docker", [
    "ps", "-a", "--filter", `name=^/${tunnelContainerName}$`, "--format", "{{.ID}}",
  ], { windowsHide: true, encoding: "utf8" }).catch(() => ({ stdout: "UNKNOWN" }));
  tunnelContainerRemoved = String(residue.stdout).trim() === "";
  tunnelLogsSecretFree = !(tunnelStdout + tunnelStderr).includes(apiKey);
  await gateway.close().catch(() => undefined);
  await rm(apiKeyFile, { force: true }).catch(() => undefined);
  try {
    await readFile(apiKeyFile);
    apiKeyFileRemoved = false;
  } catch {
    apiKeyFileRemoved = true;
  }
  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
}

if (!tunnelContainerRemoved) throw new Error("M10_TUNNEL_CONTAINER_RESIDUE");
if (!tunnelLogsSecretFree) throw new Error("M10_SECRET_PERSISTENCE_DETECTED");
if (!apiKeyFileRemoved) throw new Error("M10_API_KEY_RESIDUE");

const result = Object.freeze({
  directExactToolSurface,
  directStatusPassed,
  directCapabilitiesPassed,
  directMutationDenied,
  tunnelExactToolSurface,
  tunnelStatusPassed,
  tunnelCapabilitiesPassed,
  tunnelMutationDenied,
  tunnelContainerRemoved,
  tunnelLogsSecretFree,
  apiKeyFileRemoved,
  directPort,
  tunnelProxyPort,
});

await mkdir(dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
