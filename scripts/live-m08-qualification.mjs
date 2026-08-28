import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { LocalOperatorGit } from "../dist/src/operator/local-git.js";
import { createQualifiedOperatorControlRuntime } from "../dist/src/operator/qualified-control-runtime.js";
import { createGatewayServer } from "../dist/src/server.js";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.argv[2];
const resultPath = process.argv[3];
if (!runtimeRoot || !resultPath) throw new Error("M08_LIVE_ARGS_REQUIRED");

const canonical = join(runtimeRoot, "canonical");
const worktreeRoot = join(runtimeRoot, "worktrees");
await mkdir(canonical, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
const gitExec = async (args, cwd = canonical) => (await run("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");

await mkdir(join(canonical, "src"), { recursive: true });
await mkdir(join(canonical, "tests"), { recursive: true });
await mkdir(join(canonical, "scripts"), { recursive: true });
await writeFile(join(canonical, "package.json"), JSON.stringify({
  name: "m08-synthetic", private: true, type: "module",
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
  'test("m08 synthetic", () => assert.equal(2 + 2, 4));',
].join("\n") + "\n", "utf8");
await writeFile(join(canonical, "scripts/build.mjs"), 'console.log("M08_BUILD_PASS");\n', "utf8");
await writeFile(join(canonical, "scripts/typecheck.mjs"), 'console.log("M08_TYPECHECK_PASS");\n', "utf8");
await gitExec(["init", "-b", "main"]);
await gitExec(["add", "-A"]);
await gitExec(["-c", "user.email=haios-m08@local", "-c", "user.name=HAIOS M08", "commit", "-m", "baseline"]);

const git = new LocalOperatorGit();
const operatorRuntime = await createQualifiedOperatorControlRuntime({
  worktreeRoot, allowedProjects: { demo: canonical },
  registryPath: join(repoRoot, "task-registry.m07.json"),
  effectPolicyPath: join(repoRoot, "task-effects.m07.json"),
});
const upstream = {
  listDirectory: async () => ({}), readFile: async () => ({}), readMultipleFiles: async () => ({}),
  getFileInfo: async () => ({}), startSearch: async () => ({}), getMoreSearchResults: async () => ({}),
  stopSearch: async () => ({}), listSearches: async () => ({}), listProcesses: async () => ({}),
  listSessions: async () => ({}), getConfig: async () => ({}), close: async () => undefined,
};
const apiKey = "m08-disposable-local-key";
const gateway = await createGatewayServer({
  apiKey, upstream, protocolMode: "operator13", operatorMode: "ACTIVE", operatorRuntime,
  host: "127.0.0.1", port: 8772,
});
const address = await gateway.listen();
const client = new Client({ name: "m08-live-qualification", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(address.url), {
  requestInit: { headers: { "X-API-Key": apiKey } },
}));
const payload = (result) => {
  const text = result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  return JSON.parse(text);
};
const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));

let promotionPassed = false;
let rollbackPassed = false;
let staleCasDenied = false;
let canonicalUnchangedBeforePromotion = false;
let worktreeResidueZero = false;
let exactToolSurface = false;
let activeStatusPassed = false;
let taskPassed = false;
let stalePromotionNoMutation = false;
let rollbackTxId;
let staleTxId;
let baselineHead;
let checkpointId;
try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  exactToolSurface = names.length === 13 && names[0] === "operator_status" && names.at(-1) === "operator_promote_transaction" && !names.includes("transaction_apply");
  if (!exactToolSurface) throw new Error(`M08_TOOL_SURFACE:${JSON.stringify(names)}`);
  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  activeStatusPassed = status.mode === "ACTIVE" && status.destructive === "LOCKED" && caps.s2Enabled === false && caps.genericExec === false;
  if (!activeStatusPassed) throw new Error(`M08_ACTIVE_STATUS:${JSON.stringify({ status, caps })}`);

  baselineHead = await git.head(canonical);
  const begin = await call("operator_begin_transaction", { projectId: "demo", canonicalRoot: canonical });
  if (begin.decision !== "ALLOW") throw new Error(`M08_BEGIN:${JSON.stringify(begin)}`);
  const txId = begin.transaction.txId;
  const beforeBytes = await readFile(join(begin.transaction.worktreePath, "src/value.txt"));
  const staged = await call("operator_stage_patch", {
    txId, relPath: "src/value.txt", preimageSha256: sha256(beforeBytes), newContentBase64: b64("M08_PROMOTED\n"),
  });
  if (staged.decision !== "ALLOW") throw new Error(`M08_STAGE:${JSON.stringify(staged)}`);
  if ((await call("operator_validate_transaction", { txId })).decision !== "ALLOW") throw new Error("M08_VALIDATE");
  if ((await call("operator_apply_transaction", { txId })).decision !== "ALLOW") throw new Error("M08_APPLY");
  canonicalUnchangedBeforePromotion = (await git.head(canonical)) === baselineHead && (await readFile(join(canonical, "src/value.txt"), "utf8")) === "BASELINE\n";
  if (!canonicalUnchangedBeforePromotion) throw new Error("M08_CANONICAL_CHANGED_BEFORE_PROMOTION");
  const task = await call("operator_run_task", { txId, taskId: "project.test", params: {} });
  taskPassed = task.decision === "ALLOW" && task.exitCode === 0;
  if (!taskPassed) throw new Error(`M08_TASK:${JSON.stringify(task)}`);
  const checkpoint = await call("operator_git_checkpoint", { txId, message: "m08 synthetic checkpoint" });
  if (checkpoint.decision !== "ALLOW" || !checkpoint.transaction?.checkpointId) throw new Error(`M08_CHECKPOINT:${JSON.stringify(checkpoint)}`);
  checkpointId = checkpoint.transaction.checkpointId;
  const promoted = await call("operator_promote_transaction", { txId, expectedHeadSha: baselineHead, checkpointId });
  promotionPassed = promoted.decision === "ALLOW" && (await git.head(canonical)) === checkpointId && (await git.status(canonical)) === "";
  if (!promotionPassed) throw new Error(`M08_PROMOTE:${JSON.stringify(promoted)}`);

  const rollbackBegin = await call("operator_begin_transaction", { projectId: "demo", canonicalRoot: canonical });
  if (rollbackBegin.decision !== "ALLOW") throw new Error("M08_ROLLBACK_BEGIN");
  rollbackTxId = rollbackBegin.transaction.txId;
  const rollbackStage = await call("operator_stage_create", { txId: rollbackTxId, relPath: "src/rollback-only.txt", contentBase64: b64("rollback\n") });
  if (rollbackStage.decision !== "ALLOW") throw new Error("M08_ROLLBACK_STAGE");
  const rolled = await call("operator_rollback_transaction", { txId: rollbackTxId });
  rollbackPassed = rolled.decision === "ALLOW" && rolled.state === "ROLLED_BACK";
  if (!rollbackPassed) throw new Error(`M08_ROLLBACK:${JSON.stringify(rolled)}`);

  const staleBegin = await call("operator_begin_transaction", { projectId: "demo", canonicalRoot: canonical });
  if (staleBegin.decision !== "ALLOW") throw new Error("M08_STALE_BEGIN");
  staleTxId = staleBegin.transaction.txId;
  const staleBase = staleBegin.transaction.baseHeadSha;
  const staleBefore = await readFile(join(staleBegin.transaction.worktreePath, "src/value.txt"));
  if ((await call("operator_stage_patch", { txId: staleTxId, relPath: "src/value.txt", preimageSha256: sha256(staleBefore), newContentBase64: b64("STALE\n") })).decision !== "ALLOW") throw new Error("M08_STALE_STAGE");
  if ((await call("operator_validate_transaction", { txId: staleTxId })).decision !== "ALLOW") throw new Error("M08_STALE_VALIDATE");
  if ((await call("operator_apply_transaction", { txId: staleTxId })).decision !== "ALLOW") throw new Error("M08_STALE_APPLY");
  const staleCheckpoint = await call("operator_git_checkpoint", { txId: staleTxId, message: "m08 stale checkpoint" });
  if (staleCheckpoint.decision !== "ALLOW") throw new Error("M08_STALE_CHECKPOINT");

  await writeFile(join(canonical, "external.txt"), "concurrent\n", "utf8");
  await gitExec(["add", "-A"]);
  await gitExec(["-c", "user.email=haios-m08@local", "-c", "user.name=HAIOS M08", "commit", "-m", "synthetic concurrent advance"]);
  const headBeforeStalePromote = await git.head(canonical);
  const stalePromote = await call("operator_promote_transaction", {
    txId: staleTxId, expectedHeadSha: staleBase, checkpointId: staleCheckpoint.transaction.checkpointId,
  });
  const headAfterStalePromote = await git.head(canonical);
  staleCasDenied = stalePromote.decision === "DENY" && stalePromote.reason === "STALE_CANONICAL_HEAD";
  stalePromotionNoMutation = headAfterStalePromote === headBeforeStalePromote;
  if (!staleCasDenied || !stalePromotionNoMutation) throw new Error(`M08_STALE_CAS:${JSON.stringify(stalePromote)}`);
  const staleRollback = await call("operator_rollback_transaction", { txId: staleTxId });
  if (staleRollback.decision !== "ALLOW") throw new Error(`M08_STALE_ROLLBACK:${JSON.stringify(staleRollback)}`);

  const remaining = await readdir(worktreeRoot);
  worktreeResidueZero = remaining.length === 0;
  if (!worktreeResidueZero) throw new Error(`M08_WORKTREE_RESIDUE:${remaining.join(",")}`);
} finally {
  await client.close().catch(() => undefined);
  await gateway.close().catch(() => undefined);
}

const result = {
  exactToolSurface,
  activeStatusPassed,
  baselineHead,
  checkpointId,
  canonicalUnchangedBeforePromotion,
  taskPassed,
  promotionPassed,
  rollbackPassed,
  rollbackTxId,
  staleCasDenied,
  stalePromotionNoMutation,
  staleTxId,
  worktreeResidueZero,
  port: 8772,
};
await mkdir(dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result));
