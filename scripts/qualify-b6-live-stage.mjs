import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHostApiKey } from "../dist/src/operator/host-runtime-config.js";
import { OPERATOR_V1_TOOL_NAMES } from "../dist/src/operator/protocol.js";

const run = promisify(execFile);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "..");
const stage = process.argv[2];
const candidateManifestExpected = process.argv[3];
const evidencePath = process.argv[4];
if (stage !== "SKILL_FABRIC") throw new Error("B6_LIVE_STAGE_UNSUPPORTED");
if (!/^[a-f0-9]{64}$/u.test(candidateManifestExpected ?? "")) throw new Error("B6_LIVE_CANDIDATE_MANIFEST_REQUIRED");
if (!evidencePath) throw new Error("B6_LIVE_EVIDENCE_PATH_REQUIRED");

const canonical = "C:\\Workspace\\haios-skill-fabric";
const projectId = "skill-fabric";
const fixtureRelPath = "test/b6-admission-fixture.test.mjs";
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("B6_LIVE_LOCALAPPDATA_REQUIRED");
const apiKeyFile = resolve(localAppData, "HAIOS", "M10", "operator-api-key");
const worktreeRoot = resolve(localAppData, "HAIOS", "B6", "worktrees");
const expectedEvidencePath = resolve(localAppData, "HAIOS", "B6", "evidence", "stage1", "stage1-live-qualification.json");
if (resolve(evidencePath) !== expectedEvidencePath) throw new Error("B6_LIVE_EVIDENCE_PATH_DENIED");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const payload = (result) => JSON.parse(result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"));
const exactTools = (tools) => tools.length === OPERATOR_V1_TOOL_NAMES.length && tools.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
const git = async (root, args) => (await run("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();
async function repositoryFacts(root) {
  const paths = (await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const rows = [];
  for (const relPath of paths) rows.push(`${sha256(await readFile(join(root, relPath)))}  ${relPath.replaceAll("\\", "/")}`);
  return {
    head: await git(root, ["rev-parse", "HEAD"]),
    trackedCount: paths.length,
    manifestSha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")),
    clean: (await git(root, ["status", "--porcelain=v1"])) === "",
  };
}
async function residueCount() {
  try { return (await readdir(worktreeRoot)).length; }
  catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
}
const candidateFacts = await repositoryFacts(repoRoot);
if (!candidateFacts.clean || candidateFacts.manifestSha256 !== candidateManifestExpected) throw new Error("B6_LIVE_CANDIDATE_NOT_CURRENT");
const before = await repositoryFacts(canonical);
if (!before.clean) throw new Error("B6_LIVE_CANONICAL_NOT_CLEAN");
const taskRegistry = JSON.parse(await readFile(join(repoRoot, "task-registry.m07.json"), "utf8"));
const nodeTask = taskRegistry.tasks?.["node.test.run"];
if (nodeTask?.sandboxProfile !== "S0" || nodeTask?.networkAuthority !== "NONE") throw new Error("B6_LIVE_NODE_TASK_POLICY_DRIFT");
const apiKey = await loadHostApiKey(apiKeyFile);
const client = new Client({ name: "b6-live-stage-qualifier", version: "1.0.0" });
const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));
let txId;
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8769/mcp"), { requestInit: { headers: { "X-API-Key": apiKey } } }));
  const listed = await client.listTools();
  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  if (!exactTools(listed.tools.map((tool) => tool.name)) || status.mode !== "ACTIVE" || status.protocol !== "operator13"
    || status.mutationActive !== true || status.destructive !== "LOCKED" || caps.s2Enabled !== false
    || caps.genericExec !== false || caps.genericShell !== false) throw new Error("B6_LIVE_AUTHORITY_DRIFT");
  const deniedUnknown = await call("operator_begin_transaction", { projectId: "b6-denied", canonicalRoot: "C:\\Workspace\\b6-denied" });
  if (deniedUnknown.decision !== "DENY" || deniedUnknown.reason !== "PROJECT_NOT_ALLOWED") throw new Error("B6_LIVE_UNKNOWN_PROJECT_NOT_DENIED");
  const deniedHermes = await call("operator_begin_transaction", { projectId: "hermes-os", canonicalRoot: "C:\\Workspace\\hermes-ai-operating-system-b6-canonical" });
  if (deniedHermes.decision !== "DENY" || deniedHermes.reason !== "PROJECT_NOT_ALLOWED") throw new Error("B6_LIVE_HERMES_NOT_DENIED");
  const begin = await call("operator_begin_transaction", { projectId, canonicalRoot: canonical });
  if (begin.decision !== "ALLOW" || !begin.transaction?.txId) throw new Error("B6_LIVE_TARGET_NOT_ADMITTED");
  txId = begin.transaction.txId;
  const fixture = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('b6 admission fixture', () => assert.equal(2 + 2, 4));\n";
  const staged = await call("operator_stage_create", { txId, relPath: fixtureRelPath, contentBase64: Buffer.from(fixture, "utf8").toString("base64") });
  if (staged.decision !== "ALLOW") throw new Error("B6_LIVE_STAGE_CREATE_DENIED");
  if ((await call("operator_validate_transaction", { txId })).decision !== "ALLOW") throw new Error("B6_LIVE_VALIDATE_DENIED");
  if ((await call("operator_apply_transaction", { txId })).decision !== "ALLOW") throw new Error("B6_LIVE_APPLY_DENIED");
  const task = await call("operator_run_task", { txId, taskId: "node.test.run", params: { testPath: fixtureRelPath } });
  const effectPolicyVerified = task.decision === "ALLOW" && task.exitCode === 0 && task.cleanupVerified === true
    && task.metadata?.sandboxProfile === "S0" && task.metadata?.effectSummary?.complete === true
    && task.metadata?.effectSummary?.protected === 0 && task.metadata?.effectSummary?.unclassified === 0;
  if (!effectPolicyVerified) throw new Error(`B6_LIVE_NODE_TEST_FAILED:${JSON.stringify(task)}`);
  const rolled = await call("operator_rollback_transaction", { txId });
  txId = undefined;
  if (rolled.decision !== "ALLOW" || rolled.state !== "ROLLED_BACK") throw new Error("B6_LIVE_ROLLBACK_DENIED");
  const after = await repositoryFacts(canonical);
  const ownedResidueCount = await residueCount();
  if (!after.clean || after.head !== before.head || after.manifestSha256 !== before.manifestSha256 || ownedResidueCount !== 0) {
    throw new Error("B6_LIVE_POST_ROLLBACK_DRIFT");
  }
  const evidence = {
    schema: "HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1", stage, targetProjectId: projectId, result: "PASS",
    b6CandidateHeadSha: candidateFacts.head, b6CandidateManifestSha256: candidateFacts.manifestSha256,
    skillFabricHeadSha: before.head, skillFabricManifestSha256: before.manifestSha256,
    exact13Tools: true, projectAdmitted: true, hermesOsDenied: true,
    canonicalPreHeadSha: before.head, canonicalPostHeadSha: after.head,
    canonicalPreStatusClean: before.clean, canonicalPostStatusClean: after.clean,
    ownedResidueCount, effectPolicyVerified, networkAuthority: "NONE", rollbackRecoveryClassification: "SAFE_TO_ROLLBACK",
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  const tempPath = `${evidencePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, evidencePath);
  process.stdout.write(`${JSON.stringify({ result: "PASS", evidencePath })}\n`);
} finally {
  if (txId) {
    try { await call("operator_rollback_transaction", { txId }); } catch { /* fail-closed caller handles error */ }
  }
  await client.close().catch(() => undefined);
  await rm(`${evidencePath}.tmp-${process.pid}`, { force: true }).catch(() => undefined);
}
