import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createM11DisposableFixtureRuntime } from "../dist/src/operator/m11-active-canary-runtime.js";
import { LocalOperatorGit } from "../dist/src/operator/local-git.js";
import { OPERATOR_V1_TOOL_NAMES } from "../dist/src/operator/protocol.js";

const run = promisify(execFile);
const requestedRuntimeRoot = resolve(process.argv[2] ?? "");
const resultPath = resolve(process.argv[3] ?? "");
const directPort = Number(process.argv[4]);
if (!process.argv[2] || !process.argv[3] || !Number.isInteger(directPort)) throw new Error("M11_DISPOSABLE_ARGS_REQUIRED");
if (directPort < 1024 || directPort > 65535 || directPort === 8768 || directPort === 8769) throw new Error("M11_DISPOSABLE_PORT_DENIED");

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureBase = resolve(scriptRoot, "runtime", "m11-fixture");
const evidenceBase = resolve(scriptRoot, "evidence", "m11");
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const containedBy = (base, candidate) => {
  const rel = relative(base, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
async function validateDisposablePaths() {
  await mkdir(fixtureBase, { recursive: true });
  await mkdir(evidenceBase, { recursive: true });
  const [fixtureReal, evidenceReal] = await Promise.all([realpath(fixtureBase), realpath(evidenceBase)]);
  if (!samePath(fixtureReal, fixtureBase)) throw new Error("M11_DISPOSABLE_RUNTIME_ROOT_DENIED");
  if (!samePath(evidenceReal, evidenceBase)) throw new Error("M11_DISPOSABLE_RESULT_PATH_DENIED");
  if (!samePath(dirname(requestedRuntimeRoot), fixtureBase) || basename(requestedRuntimeRoot).length === 0) {
    throw new Error("M11_DISPOSABLE_RUNTIME_ROOT_DENIED");
  }
  const resultParent = await realpath(dirname(resultPath)).catch(() => { throw new Error("M11_DISPOSABLE_RESULT_PATH_DENIED"); });
  if (!containedBy(evidenceReal, resultParent) || basename(resultPath) !== "m11-disposable-active-result.json") {
    throw new Error("M11_DISPOSABLE_RESULT_PATH_DENIED");
  }
  try {
    await lstat(resultPath);
    throw new Error("M11_DISPOSABLE_RESULT_PATH_PREEXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "M11_DISPOSABLE_RESULT_PATH_PREEXISTS") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new Error("M11_DISPOSABLE_RESULT_PATH_DENIED");
    }
  }
  return requestedRuntimeRoot;
}
const runtimeRoot = await validateDisposablePaths();

const realCanaryRoot = "C:\\Workspace\\haios-operator-canary";
const m10TaskName = "HAIOS-M10-Operator-ReadOnly";
const dedicatedTunnel = "haios-operator-dedicated-tunnel-client";
const sharedTunnel = "haios-tunnel-client";
const canonical = join(runtimeRoot, "canonical");
const worktreeRoot = join(runtimeRoot, "worktrees");
const apiKeyFile = join(runtimeRoot, "m11-api-key.txt");
const apiKey = randomBytes(24).toString("hex");
const git = new LocalOperatorGit();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
const execText = async (file, args, cwd) => (await run(file, args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
const gitExec = async (args, cwd = canonical) => execText("git", args, cwd);

async function listenerSnapshot(port) {
  const output = await execText("netstat", ["-ano", "-p", "tcp"]);
  return output.split(/\r?\n/u)
    .filter((line) => line.includes("LISTENING") && new RegExp(`[:.]${port}\\s`, "u").test(line))
    .map((line) => line.trim().replace(/\s+/gu, " ")).sort();
}
async function containerDigest(name) {
  const output = await execText("docker", ["inspect", name]);
  return sha256(output);
}
async function stateSnapshot() {
  return {
    canaryHead: await execText("git", ["-C", realCanaryRoot, "rev-parse", "HEAD"]),
    canaryStatus: await execText("git", ["-C", realCanaryRoot, "status", "--porcelain"]),
    m10Task: await execText("schtasks", ["/Query", "/TN", m10TaskName, "/XML"]),
    listener8768: await listenerSnapshot(8768),
    listener8769: await listenerSnapshot(8769),
    dedicatedTunnel: await containerDigest(dedicatedTunnel),
    sharedTunnel: await containerDigest(sharedTunnel),
  };
}
async function runQualification() {
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(join(canonical, "src"), { recursive: true });
await mkdir(join(canonical, "tests"), { recursive: true });
await mkdir(join(canonical, "scripts"), { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
await writeFile(apiKeyFile, apiKey, "utf8");
await writeFile(join(canonical, "package.json"), JSON.stringify({
  name: "m11-disposable-active", private: true, type: "module",
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
  'test("m11 disposable", () => assert.equal(2 + 2, 4));',
].join("\n") + "\n", "utf8");
await writeFile(join(canonical, "scripts/build.mjs"), 'console.log("M11_BUILD_PASS");\n', "utf8");
await writeFile(join(canonical, "scripts/typecheck.mjs"), 'console.log("M11_TYPECHECK_PASS");\n', "utf8");
await gitExec(["init", "-b", "main"]);
await gitExec(["add", "-A"]);
await gitExec(["-c", "user.email=haios-m11@local", "-c", "user.name=HAIOS M11", "commit", "-m", "baseline"]);
const productionBefore = await stateSnapshot();
const gateway = await createM11DisposableFixtureRuntime({
  apiKeyFile,
  worktreeRoot,
  canonicalRoot: canonical,
  projectId: "m11-fixture",
  port: directPort,
  mode: "ACTIVE",
  activationScope: "M11_DISPOSABLE_FIXTURE_ONLY",
});
const address = await gateway.listen();
const client = new Client({ name: "m11-disposable-active", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(address.url), {
  requestInit: { headers: { "X-API-Key": apiKey } },
}));

const payload = (result) => JSON.parse(result.content
  .filter((item) => item.type === "text")
  .map((item) => item.text ?? "").join("\n"));
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
let productionAfter;
try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  exactToolSurface = names.length === OPERATOR_V1_TOOL_NAMES.length
    && names.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
  if (!exactToolSurface) throw new Error("M11_DISPOSABLE_TOOL_SURFACE_MISMATCH");

  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  activeStatusPassed = status.mode === "ACTIVE"
    && status.mutationActive === true
    && status.destructive === "LOCKED"
    && caps.s2Enabled === false
    && caps.genericExec === false
    && caps.genericShell === false;
  if (!activeStatusPassed) throw new Error("M11_DISPOSABLE_ACTIVE_STATUS_MISMATCH");

  baselineHead = await git.head(canonical);
  const begin = await call("operator_begin_transaction", { projectId: "m11-fixture", canonicalRoot: canonical });
  if (begin.decision !== "ALLOW") throw new Error("M11_DISPOSABLE_BEGIN_DENIED");
  const txId = begin.transaction.txId;
  const beforeBytes = await readFile(join(begin.transaction.worktreePath, "src/value.txt"));
  const staged = await call("operator_stage_patch", {
    txId, relPath: "src/value.txt", preimageSha256: sha256(beforeBytes), newContentBase64: b64("M11_PROMOTED\n"),
  });
  if (staged.decision !== "ALLOW") throw new Error("M11_DISPOSABLE_STAGE_DENIED");
  if ((await call("operator_validate_transaction", { txId })).decision !== "ALLOW") throw new Error("M11_DISPOSABLE_VALIDATE_DENIED");
  if ((await call("operator_apply_transaction", { txId })).decision !== "ALLOW") throw new Error("M11_DISPOSABLE_APPLY_DENIED");

  canonicalUnchangedBeforePromotion = (await git.head(canonical)) === baselineHead
    && (await readFile(join(canonical, "src/value.txt"), "utf8")) === "BASELINE\n";
  if (!canonicalUnchangedBeforePromotion) throw new Error("M11_DISPOSABLE_CANONICAL_CHANGED_EARLY");

  const task = await call("operator_run_task", { txId, taskId: "project.test", params: {} });
  taskPassed = task.decision === "ALLOW" && task.exitCode === 0;
  if (!taskPassed) throw new Error("M11_DISPOSABLE_PROJECT_TEST_FAILED");

  const checkpoint = await call("operator_git_checkpoint", { txId, message: "m11 disposable checkpoint" });
  if (checkpoint.decision !== "ALLOW" || !checkpoint.transaction?.checkpointId) throw new Error("M11_DISPOSABLE_CHECKPOINT_DENIED");
  checkpointId = checkpoint.transaction.checkpointId;
  const promoted = await call("operator_promote_transaction", {
    txId, expectedHeadSha: baselineHead, checkpointId,
  });
  promotionPassed = promoted.decision === "ALLOW"
    && (await git.head(canonical)) === checkpointId
    && (await git.status(canonical)) === "";
  if (!promotionPassed) throw new Error("M11_DISPOSABLE_PROMOTION_FAILED");
  const rollbackBegin = await call("operator_begin_transaction", { projectId: "m11-fixture", canonicalRoot: canonical });
  if (rollbackBegin.decision !== "ALLOW") throw new Error("M11_DISPOSABLE_ROLLBACK_BEGIN_DENIED");
  const rollbackTxId = rollbackBegin.transaction.txId;
  const rollbackStage = await call("operator_stage_create", {
    txId: rollbackTxId, relPath: "src/rollback-only.txt", contentBase64: b64("rollback\n"),
  });
  if (rollbackStage.decision !== "ALLOW") throw new Error("M11_DISPOSABLE_ROLLBACK_STAGE_DENIED");
  const rolled = await call("operator_rollback_transaction", { txId: rollbackTxId });
  rollbackPassed = rolled.decision === "ALLOW" && rolled.state === "ROLLED_BACK";
  if (!rollbackPassed) throw new Error("M11_DISPOSABLE_ROLLBACK_FAILED");

  const staleBegin = await call("operator_begin_transaction", { projectId: "m11-fixture", canonicalRoot: canonical });
  if (staleBegin.decision !== "ALLOW") throw new Error("M11_DISPOSABLE_STALE_BEGIN_DENIED");
  const staleTxId = staleBegin.transaction.txId;
  const staleBase = staleBegin.transaction.baseHeadSha;
  const staleBefore = await readFile(join(staleBegin.transaction.worktreePath, "src/value.txt"));
  if ((await call("operator_stage_patch", {
    txId: staleTxId, relPath: "src/value.txt", preimageSha256: sha256(staleBefore), newContentBase64: b64("STALE\n"),
  })).decision !== "ALLOW") throw new Error("M11_DISPOSABLE_STALE_STAGE_DENIED");
  if ((await call("operator_validate_transaction", { txId: staleTxId })).decision !== "ALLOW") throw new Error("M11_DISPOSABLE_STALE_VALIDATE_DENIED");
  if ((await call("operator_apply_transaction", { txId: staleTxId })).decision !== "ALLOW") throw new Error("M11_DISPOSABLE_STALE_APPLY_DENIED");
  const staleCheckpoint = await call("operator_git_checkpoint", {
    txId: staleTxId, message: "m11 stale checkpoint",
  });
  if (staleCheckpoint.decision !== "ALLOW") throw new Error("M11_DISPOSABLE_STALE_CHECKPOINT_DENIED");

  await writeFile(join(canonical, "external.txt"), "concurrent\n", "utf8");
  await gitExec(["add", "-A"]);
  await gitExec(["-c", "user.email=haios-m11@local", "-c", "user.name=HAIOS M11", "commit", "-m", "synthetic concurrent advance"]);
  const headBeforeStalePromote = await git.head(canonical);
  const stalePromote = await call("operator_promote_transaction", {
    txId: staleTxId,
    expectedHeadSha: staleBase,
    checkpointId: staleCheckpoint.transaction.checkpointId,
  });
  const headAfterStalePromote = await git.head(canonical);
  staleCasDenied = stalePromote.decision === "DENY" && stalePromote.reason === "STALE_CANONICAL_HEAD";
  stalePromotionNoMutation = headAfterStalePromote === headBeforeStalePromote;
  if (!staleCasDenied || !stalePromotionNoMutation) throw new Error("M11_DISPOSABLE_STALE_CAS_FAILED");
  if ((await call("operator_rollback_transaction", { txId: staleTxId })).decision !== "ALLOW") {
    throw new Error("M11_DISPOSABLE_STALE_ROLLBACK_FAILED");
  }

  const remaining = await readdir(worktreeRoot);
  worktreeResidueZero = remaining.length === 0;
  if (!worktreeResidueZero) throw new Error("M11_DISPOSABLE_WORKTREE_RESIDUE");
} finally {
  await client.close().catch(() => undefined);
  await gateway.close().catch(() => undefined);
  await rm(apiKeyFile, { force: true }).catch(() => undefined);
  try {
    await readFile(apiKeyFile);
    apiKeyFileRemoved = false;
  } catch {
    apiKeyFileRemoved = true;
  }
  productionAfter = await stateSnapshot();
}

const realCanaryUnchanged = productionAfter.canaryHead === productionBefore.canaryHead
  && productionAfter.canaryStatus === productionBefore.canaryStatus;
const m10TaskUnchanged = productionAfter.m10Task === productionBefore.m10Task;
const listenersUnchanged = JSON.stringify(productionAfter.listener8768) === JSON.stringify(productionBefore.listener8768)
  && JSON.stringify(productionAfter.listener8769) === JSON.stringify(productionBefore.listener8769);
const tunnelsUnchanged = productionAfter.dedicatedTunnel === productionBefore.dedicatedTunnel
  && productionAfter.sharedTunnel === productionBefore.sharedTunnel;

if (!apiKeyFileRemoved) throw new Error("M11_DISPOSABLE_API_KEY_RESIDUE");
if (!realCanaryUnchanged) throw new Error("M11_REAL_CANARY_DRIFT");
if (!m10TaskUnchanged) throw new Error("M11_M10_TASK_DRIFT");
if (!listenersUnchanged) throw new Error("M11_PRODUCTION_LISTENER_DRIFT");
if (!tunnelsUnchanged) throw new Error("M11_TUNNEL_DRIFT");
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
  realCanaryUnchanged,
  m10TaskUnchanged,
  listenersUnchanged,
  tunnelsUnchanged,
  directPort,
  secretPersisted: false,
});

await mkdir(dirname(resultPath), { recursive: true });
const resultHandle = await open(resultPath, "wx").catch(() => { throw new Error("M11_DISPOSABLE_RESULT_CREATE_DENIED"); });
try {
  await resultHandle.writeFile(JSON.stringify(result, null, 2) + "\n", "utf8");
} finally {
  await resultHandle.close();
}
console.log(JSON.stringify(result));
}

try {
  await runQualification();
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}
