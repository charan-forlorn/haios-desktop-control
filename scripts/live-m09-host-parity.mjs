import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createHostOperatorRuntime } from "../dist/src/operator/host-runtime.js";
import { LocalOperatorGit } from "../dist/src/operator/local-git.js";
import { OPERATOR_V1_TOOL_NAMES } from "../dist/src/operator/protocol.js";

const run = promisify(execFile);
const runtimeRoot = process.argv[2];
const resultPath = process.argv[3];
const directPort = Number(process.argv[4]);
if (!runtimeRoot || !resultPath || !Number.isInteger(directPort)) throw new Error("M09_LIVE_ARGS_REQUIRED");
if (directPort < 1024 || directPort > 65535 || directPort === 8768 || directPort === 8769) {
  throw new Error("M09_DIRECT_PORT_DENIED");
}

const canonical = join(runtimeRoot, "canonical");
const worktreeRoot = join(runtimeRoot, "worktrees");
const apiKeyFile = join(runtimeRoot, "m09-api-key.txt");
const apiKey = randomBytes(24).toString("hex");
await mkdir(canonical, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
await writeFile(apiKeyFile, apiKey, "utf8");

const gitExec = async (args, cwd = canonical) => (
  await run("git", args, { cwd, windowsHide: true, encoding: "utf8" })
).stdout.trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");

await mkdir(join(canonical, "src"), { recursive: true });
await mkdir(join(canonical, "tests"), { recursive: true });
await mkdir(join(canonical, "scripts"), { recursive: true });
await writeFile(join(canonical, "package.json"), JSON.stringify({
  name: "m09-synthetic",
  private: true,
  type: "module",
  scripts: {
    test: "node --test tests/sample.test.mjs",
    build: "node scripts/build.mjs",
    typecheck: "node scripts/typecheck.mjs",
  },
}, null, 2) + "\n", "utf8");
await writeFile(join(canonical, "src/value.txt"), "BASELINE\n", "utf8");
await writeFile(join(canonical, "tests/sample.test.mjs"), [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'test("m09 synthetic", () => assert.equal(2 + 2, 4));',
].join("\n") + "\n", "utf8");
await writeFile(join(canonical, "scripts/build.mjs"), 'console.log("M09_BUILD_PASS");\n', "utf8");
await writeFile(join(canonical, "scripts/typecheck.mjs"), 'console.log("M09_TYPECHECK_PASS");\n', "utf8");
await gitExec(["init", "-b", "main"]);
await gitExec(["add", "-A"]);
await gitExec(["-c", "user.email=haios-m09@local", "-c", "user.name=HAIOS M09", "commit", "-m", "baseline"]);

const git = new LocalOperatorGit();
const gateway = await createHostOperatorRuntime({
  apiKeyFile,
  worktreeRoot,
  allowedProjects: { demo: canonical },
  port: directPort,
  mode: "ACTIVE",
  activationScope: "M09_TEST_ONLY",
});
const address = await gateway.listen();
const client = new Client({ name: "m09-live-host", version: "1.0.0" });
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
const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));

let exactToolSurface = false;
let activeStatusPassed = false;
let canonicalUnchangedBeforePromotion = false;
let taskPassed = false;
let promotionPassed = false;
let rollbackPassed = false;
let staleCasDenied = false;
let stalePromotionNoMutation = false;
let worktreeResidueZero = false;
let apiKeyFileRemoved = false;
let baselineHead;
let checkpointId;
let tunnelExactToolSurface = false;
let tunnelStatusPassed = false;
let tunnelCapabilitiesPassed = false;
let tunnelParityPassed = false;
let tunnelContainerRemoved = false;
let tunnelLogsSecretFree = false;
let tunnelProcess;
let tunnelStdout = "";
let tunnelStderr = "";
const tunnelImage = "ghcr.io/openai/tunnel-client:v0.0.11";
const syntheticTunnelId = "tunnel_22222222222222222222222222222222";
const tunnelProxyPort = 18773;
const tunnelContainerName = `haios-m09-tunnel-parity-${process.pid}-${randomBytes(4).toString("hex")}`;
const tunnelTargetUrl = `http://host.docker.internal:${directPort}/mcp`;
const tunnelProxyUrl = `http://127.0.0.1:${tunnelProxyPort}/v1/mcp/${syntheticTunnelId}`;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const appendBounded = (current, chunk) => (current + chunk.toString("utf8")).slice(-1024 * 1024);

try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  exactToolSurface = names.length === OPERATOR_V1_TOOL_NAMES.length
    && names.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
  if (!exactToolSurface) throw new Error("M09_LIVE_TOOL_SURFACE_MISMATCH");

  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  activeStatusPassed = status.mode === "ACTIVE"
    && status.destructive === "LOCKED"
    && caps.s2Enabled === false
    && caps.genericExec === false
    && caps.genericShell === false;
  if (!activeStatusPassed) throw new Error("M09_LIVE_ACTIVE_STATUS_MISMATCH");

  baselineHead = await git.head(canonical);
  const begin = await call("operator_begin_transaction", { projectId: "demo", canonicalRoot: canonical });
  if (begin.decision !== "ALLOW") throw new Error("M09_LIVE_BEGIN_DENIED");
  const txId = begin.transaction.txId;
  const beforeBytes = await readFile(join(begin.transaction.worktreePath, "src/value.txt"));
  const staged = await call("operator_stage_patch", {
    txId,
    relPath: "src/value.txt",
    preimageSha256: sha256(beforeBytes),
    newContentBase64: b64("M09_PROMOTED\n"),
  });
  if (staged.decision !== "ALLOW") throw new Error("M09_LIVE_STAGE_DENIED");
  if ((await call("operator_validate_transaction", { txId })).decision !== "ALLOW") {
    throw new Error("M09_LIVE_VALIDATE_DENIED");
  }
  if ((await call("operator_apply_transaction", { txId })).decision !== "ALLOW") {
    throw new Error("M09_LIVE_APPLY_DENIED");
  }

  canonicalUnchangedBeforePromotion = (await git.head(canonical)) === baselineHead
    && (await readFile(join(canonical, "src/value.txt"), "utf8")) === "BASELINE\n";
  if (!canonicalUnchangedBeforePromotion) throw new Error("M09_LIVE_CANONICAL_CHANGED_EARLY");

  const task = await call("operator_run_task", { txId, taskId: "project.test", params: {} });
  taskPassed = task.decision === "ALLOW" && task.exitCode === 0;
  if (!taskPassed) throw new Error("M09_LIVE_PROJECT_TEST_FAILED");

  const checkpoint = await call("operator_git_checkpoint", { txId, message: "m09 synthetic checkpoint" });
  if (checkpoint.decision !== "ALLOW" || !checkpoint.transaction?.checkpointId) {
    throw new Error("M09_LIVE_CHECKPOINT_DENIED");
  }
  checkpointId = checkpoint.transaction.checkpointId;
  const promoted = await call("operator_promote_transaction", {
    txId,
    expectedHeadSha: baselineHead,
    checkpointId,
  });
  promotionPassed = promoted.decision === "ALLOW"
    && (await git.head(canonical)) === checkpointId
    && (await git.status(canonical)) === "";
  if (!promotionPassed) throw new Error("M09_LIVE_PROMOTION_FAILED");

  const rollbackBegin = await call("operator_begin_transaction", { projectId: "demo", canonicalRoot: canonical });
  if (rollbackBegin.decision !== "ALLOW") throw new Error("M09_LIVE_ROLLBACK_BEGIN_DENIED");
  const rollbackTxId = rollbackBegin.transaction.txId;
  const rollbackStage = await call("operator_stage_create", {
    txId: rollbackTxId,
    relPath: "src/rollback-only.txt",
    contentBase64: b64("rollback\n"),
  });
  if (rollbackStage.decision !== "ALLOW") throw new Error("M09_LIVE_ROLLBACK_STAGE_DENIED");
  const rolled = await call("operator_rollback_transaction", { txId: rollbackTxId });
  rollbackPassed = rolled.decision === "ALLOW" && rolled.state === "ROLLED_BACK";
  if (!rollbackPassed) throw new Error("M09_LIVE_ROLLBACK_FAILED");

  const staleBegin = await call("operator_begin_transaction", { projectId: "demo", canonicalRoot: canonical });
  if (staleBegin.decision !== "ALLOW") throw new Error("M09_LIVE_STALE_BEGIN_DENIED");
  const staleTxId = staleBegin.transaction.txId;
  const staleBase = staleBegin.transaction.baseHeadSha;
  const staleBefore = await readFile(join(staleBegin.transaction.worktreePath, "src/value.txt"));
  if ((await call("operator_stage_patch", {
    txId: staleTxId,
    relPath: "src/value.txt",
    preimageSha256: sha256(staleBefore),
    newContentBase64: b64("STALE\n"),
  })).decision !== "ALLOW") throw new Error("M09_LIVE_STALE_STAGE_DENIED");
  if ((await call("operator_validate_transaction", { txId: staleTxId })).decision !== "ALLOW") {
    throw new Error("M09_LIVE_STALE_VALIDATE_DENIED");
  }
  if ((await call("operator_apply_transaction", { txId: staleTxId })).decision !== "ALLOW") {
    throw new Error("M09_LIVE_STALE_APPLY_DENIED");
  }
  const staleCheckpoint = await call("operator_git_checkpoint", {
    txId: staleTxId,
    message: "m09 stale checkpoint",
  });
  if (staleCheckpoint.decision !== "ALLOW") throw new Error("M09_LIVE_STALE_CHECKPOINT_DENIED");

  await writeFile(join(canonical, "external.txt"), "concurrent\n", "utf8");
  await gitExec(["add", "-A"]);
  await gitExec(["-c", "user.email=haios-m09@local", "-c", "user.name=HAIOS M09", "commit", "-m", "synthetic concurrent advance"]);
  const headBeforeStalePromote = await git.head(canonical);
  const stalePromote = await call("operator_promote_transaction", {
    txId: staleTxId,
    expectedHeadSha: staleBase,
    checkpointId: staleCheckpoint.transaction.checkpointId,
  });
  const headAfterStalePromote = await git.head(canonical);
  staleCasDenied = stalePromote.decision === "DENY" && stalePromote.reason === "STALE_CANONICAL_HEAD";
  stalePromotionNoMutation = headAfterStalePromote === headBeforeStalePromote;
  if (!staleCasDenied || !stalePromotionNoMutation) throw new Error("M09_LIVE_STALE_CAS_FAILED");
  if ((await call("operator_rollback_transaction", { txId: staleTxId })).decision !== "ALLOW") {
    throw new Error("M09_LIVE_STALE_ROLLBACK_FAILED");
  }

  const remaining = await readdir(worktreeRoot);
  worktreeResidueZero = remaining.length === 0;
  if (!worktreeResidueZero) throw new Error("M09_LIVE_WORKTREE_RESIDUE");

  const tunnelArgs = [
    "run", "--rm",
    "--name", tunnelContainerName,
    "--label", "haios.m09.owner=host-parity",
    "-p", `127.0.0.1:${tunnelProxyPort}:8783`,
    "--mount", `type=bind,source=${apiKeyFile},target=/run/secrets/m09-api-key,readonly`,
    "-e", "MCP_EXTRA_HEADERS=X-API-Key: file:/run/secrets/m09-api-key",
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
  let tunnelLastError;
  const tunnelDeadline = Date.now() + 20_000;
  while (Date.now() < tunnelDeadline && tunnelClient === undefined) {
    const candidate = new Client({ name: "m09-tunnel-parity", version: "1.0.0" });
    try {
      await candidate.connect(new StreamableHTTPClientTransport(new URL(tunnelProxyUrl)));
      tunnelClient = candidate;
    } catch (error) {
      tunnelLastError = error;
      await candidate.close().catch(() => undefined);
      await sleep(250);
    }
  }
  if (tunnelClient === undefined) {
    void tunnelLastError;
    throw new Error("M09_TUNNEL_PARITY_FAILED");
  }
  try {
    const tunnelListed = await tunnelClient.listTools();
    const tunnelNames = tunnelListed.tools.map((tool) => tool.name);
    tunnelExactToolSurface = tunnelNames.length === OPERATOR_V1_TOOL_NAMES.length
      && tunnelNames.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
    const tunnelCall = async (name) => payload(await tunnelClient.callTool({ name, arguments: {} }));
    const tunnelStatus = await tunnelCall("operator_status");
    const tunnelCapabilities = await tunnelCall("operator_capabilities");
    tunnelStatusPassed = tunnelStatus.mode === "ACTIVE" && tunnelStatus.destructive === "LOCKED";
    tunnelCapabilitiesPassed = tunnelCapabilities.s2Enabled === false
      && tunnelCapabilities.genericExec === false
      && tunnelCapabilities.genericShell === false
      && tunnelCapabilities.destructive === "LOCKED";
    tunnelParityPassed = tunnelExactToolSurface && tunnelStatusPassed && tunnelCapabilitiesPassed;
    if (!tunnelParityPassed) throw new Error("M09_TUNNEL_PARITY_FAILED");
  } finally {
    await tunnelClient.close().catch(() => undefined);
  }
} finally {
  await client.close().catch(() => undefined);
  if (tunnelProcess !== undefined) {
    await run("docker", ["rm", "-f", tunnelContainerName], { windowsHide: true }).catch(() => undefined);
    await new Promise((resolveExit) => {
      if (tunnelProcess.exitCode !== null) resolveExit();
      else {
        tunnelProcess.once("exit", resolveExit);
        setTimeout(resolveExit, 5_000);
      }
    });
  }
  const tunnelResidue = await run("docker", [
    "ps", "-a", "--filter", `name=^/${tunnelContainerName}$`, "--format", "{{.ID}}",
  ], { windowsHide: true, encoding: "utf8" }).catch(() => ({ stdout: "UNKNOWN" }));
  tunnelContainerRemoved = String(tunnelResidue.stdout).trim() === "";
  tunnelLogsSecretFree = !(tunnelStdout + tunnelStderr).includes(apiKey);
  await gateway.close().catch(() => undefined);
  await rm(apiKeyFile, { force: true }).catch(() => undefined);
  try {
    await readFile(apiKeyFile);
    apiKeyFileRemoved = false;
  } catch {
    apiKeyFileRemoved = true;
  }
  if (worktreeResidueZero) await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
}

if (!apiKeyFileRemoved) throw new Error("M09_LIVE_API_KEY_RESIDUE");
if (!tunnelContainerRemoved) throw new Error("M09_TUNNEL_CONTAINER_RESIDUE");
if (!tunnelLogsSecretFree) throw new Error("M09_SECRET_PERSISTENCE_DETECTED");
if (!tunnelParityPassed) throw new Error("M09_TUNNEL_PARITY_FAILED");
const result = Object.freeze({
  exactToolSurface,
  activeStatusPassed,
  baselineHead,
  checkpointId,
  canonicalUnchangedBeforePromotion,
  taskPassed,
  promotionPassed,
  rollbackPassed,
  staleCasDenied,
  stalePromotionNoMutation,
  worktreeResidueZero,
  apiKeyFileRemoved,
  tunnelExactToolSurface,
  tunnelStatusPassed,
  tunnelCapabilitiesPassed,
  tunnelParityPassed,
  tunnelContainerRemoved,
  tunnelLogsSecretFree,
  tunnelProxyPort,
  directPort,
});
await mkdir(dirname(resolve(resultPath)), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result));
