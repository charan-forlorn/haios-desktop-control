import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadCurrentB6RuntimeBinding } from "./b6-runtime-attestation.mjs";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv[2];
const candidateManifestExpected = process.argv[3];
const evidencePath = process.argv[4];
const stageOneCertificationSha256 = process.argv[5];
if (stage !== "SKILL_FABRIC" && stage !== "HERMES_OS") throw new Error("B6_LIVE_STAGE_REQUIRED");
if (!/^[a-f0-9]{64}$/u.test(candidateManifestExpected ?? "")) throw new Error("B6_LIVE_CANDIDATE_MANIFEST_REQUIRED");
if (!evidencePath) throw new Error("B6_LIVE_EVIDENCE_PATH_REQUIRED");
const expectedEvidenceName = stage === "SKILL_FABRIC" ? "stage1-live-qualification.json" : "stage2-live-qualification.json";
if (basename(evidencePath).split(".candidate-")[0] !== expectedEvidenceName) throw new Error("B6_LIVE_EVIDENCE_PATH_DENIED");
if (stage === "HERMES_OS" && !/^[a-f0-9]{64}$/u.test(stageOneCertificationSha256 ?? "")) throw new Error("B6_LIVE_STAGE_ONE_CERTIFICATION_REQUIRED");

const roots = Object.freeze({
  "operator-canary": "C:\\Workspace\\haios-operator-canary",
  "skill-fabric": "C:\\Workspace\\haios-skill-fabric",
  "hermes-os": "C:\\Workspace\\hermes-ai-operating-system-b6-canonical",
});
const target = stage === "SKILL_FABRIC" ? "skill-fabric" : "hermes-os";
const canonical = roots[target];
const fixtureRelPath = "test/b6-admission-fixture.test.mjs";
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("B6_LIVE_LOCALAPPDATA_REQUIRED");
const apiKeyFile = resolve(localAppData, "HAIOS", "M10", "operator-api-key");
const b6StateRoot = resolve(localAppData, "HAIOS", "B6");
const worktreeRoot = resolve(b6StateRoot, "worktrees");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const payload = (result) => JSON.parse(result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"));
const exactTools = (tools) => tools.length === OPERATOR_V1_TOOL_NAMES.length && tools.every((name, index) => name === OPERATOR_V1_TOOL_NAMES[index]);
const git = async (root, args) => (await run("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();
async function repositoryFacts(root) {
  const paths = (await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const rows = [];
  for (const relPath of paths) rows.push(`${sha256(await readFile(join(root, relPath)))}  ${relPath.replaceAll("\\", "/")}`);
  return { head: await git(root, ["rev-parse", "HEAD"]), trackedCount: paths.length,
    manifestSha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")), clean: (await git(root, ["status", "--porcelain=v1"])) === "" };
}
async function residueCount() {
  let total = 0;
  for (const name of ["worktrees", "transaction-recovery", "leases", "remediation"]) {
    const path = resolve(b6StateRoot, name);
    try {
      const [stat, canonical] = await Promise.all([lstat(path), realpath(path)]);
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path) throw new Error("B6_LIVE_OWNED_STATE_RESIDUE");
      total += (await readdir(path)).length;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof Error && error.message === "B6_LIVE_OWNED_STATE_RESIDUE") throw error;
      throw new Error("B6_LIVE_OWNED_STATE_RESIDUE");
    }
  }
  return total;
}
const candidateFacts = await repositoryFacts(repoRoot);
if (!candidateFacts.clean || candidateFacts.manifestSha256 !== candidateManifestExpected) throw new Error("B6_LIVE_CANDIDATE_NOT_CURRENT");
const before = await repositoryFacts(canonical);
if (!before.clean) throw new Error("B6_LIVE_CANONICAL_NOT_CLEAN");
const skillFacts = await repositoryFacts(roots["skill-fabric"]);
const taskRegistry = JSON.parse(await readFile(join(repoRoot, "task-registry.m07.json"), "utf8"));
const nodeTask = taskRegistry.tasks?.["node.test.run"];
if (nodeTask?.sandboxProfile !== "S0" || nodeTask?.networkAuthority !== "NONE") throw new Error("B6_LIVE_NODE_TASK_POLICY_DRIFT");
const runtimeBinding = await loadCurrentB6RuntimeBinding(stage);
if (runtimeBinding.current.candidateManifestSha256 !== candidateFacts.manifestSha256 || runtimeBinding.current.candidateHeadSha !== candidateFacts.head) throw new Error("B6_LIVE_RUNTIME_BUILD_NOT_CURRENT");
const { loadHostApiKey, OPERATOR_V1_TOOL_NAMES } = runtimeBinding;
const apiKey = await loadHostApiKey(apiKeyFile);
const client = new Client({ name: "b6-live-stage-qualifier", version: "2.0.0" });
const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));
let txId;
const regressionCleanupTxIds = new Set();
async function beginRollback(projectId) {
  const opened = await call("operator_begin_transaction", { projectId, canonicalRoot: roots[projectId] });
  if (opened.decision !== "ALLOW" || !opened.transaction?.txId) return false;
  const regressionTxId = opened.transaction.txId;
  regressionCleanupTxIds.add(regressionTxId);
  try {
    const rolled = await call("operator_rollback_transaction", { txId: regressionTxId });
    const clean = rolled.decision === "ALLOW" && rolled.state === "ROLLED_BACK";
    if (clean) regressionCleanupTxIds.delete(regressionTxId);
    return clean;
  } catch { return false; }
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8769/mcp"), { requestInit: { headers: { "X-API-Key": apiKey } } }));
  const listed = await client.listTools();
  const status = await call("operator_status");
  const caps = await call("operator_capabilities");
  if (!exactTools(listed.tools.map((tool) => tool.name)) || status.mode !== "ACTIVE" || status.protocol !== "operator13"
    || status.mutationActive !== true || status.destructive !== "LOCKED" || caps.s2Enabled !== false || caps.genericExec !== false || caps.genericShell !== false) {
    throw new Error("B6_LIVE_AUTHORITY_DRIFT");
  }
  const unknown = await call("operator_begin_transaction", { projectId: "b6-denied", canonicalRoot: "C:\\Workspace\\b6-denied" });
  const unknownProjectDenied = unknown.decision === "DENY";
  const wrongRoot = await call("operator_begin_transaction", { projectId: target, canonicalRoot: "C:\\Workspace\\b6-wrong-root" });
  const wrongRootDenied = wrongRoot.decision === "DENY";
  if (!unknownProjectDenied || !wrongRootDenied) throw new Error("B6_LIVE_NEGATIVE_ADMISSION_FAILED");
  let hermesOsDenied = true;
  if (stage === "SKILL_FABRIC") {
    const denied = await call("operator_begin_transaction", { projectId: "hermes-os", canonicalRoot: roots["hermes-os"] });
    hermesOsDenied = denied.decision === "DENY" && denied.reason === "PROJECT_NOT_ALLOWED";
    if (!hermesOsDenied) throw new Error("B6_LIVE_HERMES_NOT_DENIED");
  }
  const operatorCanaryRegression = await beginRollback("operator-canary");
  const skillFabricRegression = stage === "HERMES_OS" ? await beginRollback("skill-fabric") : true;
  if (!operatorCanaryRegression || !skillFabricRegression) throw new Error("B6_LIVE_REGRESSION_ADMISSION_FAILED");
  const begin = await call("operator_begin_transaction", { projectId: target, canonicalRoot: canonical });
  if (begin.decision !== "ALLOW" || !begin.transaction?.txId) throw new Error("B6_LIVE_TARGET_NOT_ADMITTED");
  txId = begin.transaction.txId;
  const fixture = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('b6 admission fixture', () => assert.equal(2 + 2, 4));\n";
  if ((await call("operator_stage_create", { txId, relPath: fixtureRelPath, contentBase64: Buffer.from(fixture, "utf8").toString("base64") })).decision !== "ALLOW") throw new Error("B6_LIVE_STAGE_CREATE_DENIED");
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
  if (!after.clean || after.head !== before.head || after.manifestSha256 !== before.manifestSha256 || ownedResidueCount !== 0) throw new Error(ownedResidueCount !== 0 ? "B6_LIVE_OWNED_STATE_RESIDUE" : "B6_LIVE_POST_ROLLBACK_DRIFT");
  const common = { stage, targetProjectId: target, result: "PASS", b6CandidateHeadSha: candidateFacts.head,
    b6CandidateManifestSha256: candidateFacts.manifestSha256, exact13Tools: true, projectAdmitted: true,
    canonicalPreHeadSha: before.head, canonicalPostHeadSha: after.head, canonicalPreStatusClean: before.clean,
    canonicalPostStatusClean: after.clean, ownedResidueCount, effectPolicyVerified, networkAuthority: "NONE",
    rollbackRecoveryClassification: "SAFE_TO_ROLLBACK" };
  const evidence = stage === "SKILL_FABRIC"
    ? { schema: "HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1", ...common, skillFabricHeadSha: before.head,
        skillFabricManifestSha256: before.manifestSha256, hermesOsDenied }
    : { schema: "HAIOS_B6_STAGE2_LIVE_QUALIFICATION_R1", ...common, stageOneCertificationSha256,
        skillFabricHeadSha: skillFacts.head, skillFabricManifestSha256: skillFacts.manifestSha256,
        hermesOsHeadSha: before.head, hermesOsManifestSha256: before.manifestSha256,
        skillFabricRegression, operatorCanaryRegression, wrongRootDenied, unknownProjectDenied };
  await mkdir(dirname(evidencePath), { recursive: true });
  const tempPath = `${evidencePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, evidencePath);
  process.stdout.write(`${JSON.stringify({ result: "PASS", evidencePath, stage })}\n`);
} finally {
  if (txId) { try { await call("operator_rollback_transaction", { txId }); } catch {} }
  for (const regressionTxId of regressionCleanupTxIds) {
    try { await call("operator_rollback_transaction", { txId: regressionTxId }); } catch {}
  }
  await client.close().catch(() => undefined);
  await rm(`${evidencePath}.tmp-${process.pid}`, { force: true }).catch(() => undefined);
}
