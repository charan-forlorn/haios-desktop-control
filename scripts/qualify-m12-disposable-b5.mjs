import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RESULT_NAME = "m12-disposable-b5-result.json";
const FIXTURE_MARKER = "HAIOS_M12_DISPOSABLE_B5_FIXTURE_R1\n";
const OBSERVED_TOOL_DISPATCHES = new Set();
let runtimeModules;

function fail(code) { throw new Error(code); }
function digest(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function base64(value) { return Buffer.from(value, "utf8").toString("base64"); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function samePath(left, right) { return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase(); }
function isProtectedCanaryPath(candidate) {
  if (runtimeModules === undefined) fail("M12_DISPOSABLE_RUNTIME_NOT_PREPARED");
  const rel = win32.relative(win32.resolve(runtimeModules.M12_ACTIVE_CANARY_PROJECT_ROOT), win32.resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${win32.sep}`) && !win32.isAbsolute(rel));
}
function contained(base, candidate) {
  const rel = relative(base, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function executeGit(args, cwd) {
  return new Promise((resolveResult, rejectResult) => {
    execFile("git", args, { cwd, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) return rejectResult(new Error(`M12_DISPOSABLE_GIT_FAILED:${args[0] ?? ""}:${String(stderr)}`));
      resolveResult(String(stdout).trim());
    });
  });
}
async function git(args, cwd) { return executeGit(args, cwd); }
function executeFixed(command, args, cwd, label) {
  return new Promise((resolveResult, rejectResult) => {
    execFile(command, args, { cwd, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) return rejectResult(new Error(`M12_DISPOSABLE_${label}_FAILED:${String(stderr)}`));
      resolveResult(String(stdout));
    });
  });
}
async function deterministicTrackedSourceManifest() {
  const listed = await git(["ls-files", "-z"], ROOT);
  const files = listed.split("\0").filter(Boolean).sort();
  const rows = [];
  for (const rel of files) {
    const bytes = await readFile(join(ROOT, rel));
    rows.push(`${rel.replaceAll("\\", "/")}\t${createHash("sha256").update(bytes).digest("hex")}`);
  }
  const text = `${rows.join("\n")}\n`;
  return Object.freeze({ sha256: digest(text), fileCount: files.length });
}
async function deterministicDirectoryDigest(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else fail("M12_DISPOSABLE_COMPILED_OUTPUT_TYPE_DENIED");
    }
  }
  await visit(root);
  files.sort();
  if (files.length === 0) fail("M12_DISPOSABLE_COMPILED_OUTPUT_EMPTY");
  const rows = [];
  for (const path of files) {
    const rel = relative(root, path).split(sep).join("/");
    rows.push(`${rel}\t${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return Object.freeze({ sha256: digest(`${rows.join("\n")}\n`), fileCount: files.length });
}
async function prepareFreshRuntime() {
  const headSha = await git(["rev-parse", "HEAD"], ROOT);
  if (!/^[a-f0-9]{40}$/u.test(headSha)) fail("M12_DISPOSABLE_HEAD_INVALID");
  const source = await deterministicTrackedSourceManifest();
  const distRoot = join(ROOT, "dist");
  await rm(distRoot, { recursive: true, force: true });
  const tscCli = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!(await exists(tscCli))) fail("M12_DISPOSABLE_BUILD_TOOL_MISSING");
  await executeFixed(process.execPath, [tscCli, "--project", join(ROOT, "tsconfig.json")], ROOT, "FRESH_BUILD");
  const compiled = await deterministicDirectoryDigest(distRoot);
  const [control, config, active, localGit, protocol] = await Promise.all([
    import(pathToFileURL(join(distRoot, "src", "operator", "control-runtime.js")).href),
    import(pathToFileURL(join(distRoot, "src", "operator", "m12-active-canary-config.js")).href),
    import(pathToFileURL(join(distRoot, "src", "operator", "m12-active-canary-runtime.js")).href),
    import(pathToFileURL(join(distRoot, "src", "operator", "local-git.js")).href),
    import(pathToFileURL(join(distRoot, "src", "operator", "protocol.js")).href),
  ]);
  runtimeModules = Object.freeze({
    dispatchOperatorControlTool: control.dispatchOperatorControlTool,
    M12_ACTIVE_CANARY_PROJECT_ROOT: config.M12_ACTIVE_CANARY_PROJECT_ROOT,
    createM12DisposableB5FixtureRuntime: active.createM12DisposableB5FixtureRuntime,
    LocalOperatorGit: localGit.LocalOperatorGit,
    OPERATOR_V1_TOOL_NAMES: protocol.OPERATOR_V1_TOOL_NAMES,
  });
  return Object.freeze({ headSha, sourceManifestSha256: source.sha256, sourceFileCount: source.fileCount,
    compiledOutputSha256: compiled.sha256, compiledFileCount: compiled.fileCount, freshBuild: true });
}
async function assertRuntimeProvenanceStable(provenance) {
  const [headSha, source, compiled] = await Promise.all([
    git(["rev-parse", "HEAD"], ROOT), deterministicTrackedSourceManifest(), deterministicDirectoryDigest(join(ROOT, "dist")),
  ]);
  if (headSha !== provenance.headSha || source.sha256 !== provenance.sourceManifestSha256
    || source.fileCount !== provenance.sourceFileCount || compiled.sha256 !== provenance.compiledOutputSha256
    || compiled.fileCount !== provenance.compiledFileCount) fail("M12_DISPOSABLE_RUNTIME_PROVENANCE_DRIFT");
}
function allow(result, label) {
  if (result.decision !== "ALLOW" || result.transaction === undefined) fail(`M12_DISPOSABLE_DISPATCH_DENIED:${label}:${result.reason ?? "UNKNOWN"}`);
  return result.transaction;
}
async function dispatch(runtime, name, args) {
  const response = await runtimeModules.dispatchOperatorControlTool(name, args, runtime);
  if (response.capabilityClass === "UNKNOWN") fail(`M12_DISPOSABLE_UNKNOWN_TOOL:${name}`);
  OBSERVED_TOOL_DISPATCHES.add(name);
  return response.result;
}
function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if ((key !== "--run-id" && key !== "--port" && key !== "--output-root") || value === undefined || values.has(key)) fail("M12_DISPOSABLE_ARGUMENT_DENIED");
    values.set(key, value);
  }
  if (values.size !== 3 || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(values.get("--run-id"))) fail("M12_DISPOSABLE_RUN_ID_DENIED");
  const port = Number(values.get("--port"));
  if (!Number.isInteger(port) || port < 10240 || port > 65535 || port === 8768 || port === 8769) fail("M12_DISPOSABLE_PORT_DENIED");
  const outputRoot = values.get("--output-root");
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) fail("M12_DISPOSABLE_OUTPUT_ROOT_DENIED");
  const root = resolve(outputRoot);
  if (samePath(root, ROOT)) fail("M12_DISPOSABLE_PROTECTED_ROOT_DENIED");
  return Object.freeze({ runId: values.get("--run-id"), port, outputRoot: root });
}
async function reserveHighPort(port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen({ host: "127.0.0.1", port }, resolveListen); });
  await new Promise((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
}
async function initializeCanonical(fixtureRoot, canonical) {
  await mkdir(canonical, { recursive: true });
  await writeFile(join(fixtureRoot, ".m12-disposable-b5.fixture"), FIXTURE_MARKER, "utf8");
  await git(["init", "-b", "main"], canonical);
  await git(["config", "user.email", "haios-disposable@local"], canonical);
  await git(["config", "user.name", "HAIOS Disposable Qualification"], canonical);
  await writeFile(join(canonical, "package.json"), `${JSON.stringify({ private: true, type: "module", scripts: { test: "echo fixture-adapter-only" } }, null, 2)}\n`, "utf8");
  await writeFile(join(canonical, "fixture-state.json"), `${JSON.stringify({
    schema: "HAIOS_M12_DISPOSABLE_B5_STATE_R1", ready: "ready", revision: 0,
    emitAllowedArtifact: true, artifactValue: "baseline",
  }, null, 2)}\n`, "utf8");
  await writeFile(join(canonical, "fixture.test.mjs"), "// mutable worktree JavaScript: qualification sandbox must never execute this file\n", "utf8");
  await writeFile(join(canonical, "fixture.txt"), "baseline\n", "utf8");
  await writeFile(join(canonical, "surface-move.txt"), "move-me\n", "utf8");
  await writeFile(join(canonical, "surface-remove.txt"), "remove-me\n", "utf8");
  await git(["add", "-A"], canonical);
  await git(["commit", "-m", "disposable baseline"], canonical);
}
async function inspectOwnedResidue(fixtureRoot, fixtureRuntime) {
  const stateRoot = join(fixtureRoot, "m12-state");
  const worktreeRoot = join(stateRoot, "worktrees");
  const recoveryRoot = join(stateRoot, "transaction-recovery");
  const leaseRoot = join(stateRoot, "leases");
  const count = async (path) => (await readdir(path).catch(() => [])).length;
  const [ownedWorktrees, ownedRecoveryRecords, ownedLeaseRecords] = await Promise.all([count(worktreeRoot), count(recoveryRoot), count(leaseRoot)]);
  const runtime = fixtureRuntime.inspectFixtureResidue();
  const ownedRuntimeArtifacts = ownedRecoveryRecords + ownedLeaseRecords;
  const totalOwnedResidue = ownedWorktrees + ownedRuntimeArtifacts + runtime.ownedProcesses + runtime.ownedContainers + runtime.ownedNetworks;
  return Object.freeze({
    ownedWorktrees, ownedRecoveryRecords, ownedLeaseRecords, ownedProcesses: runtime.ownedProcesses,
    ownedContainers: runtime.ownedContainers, ownedNetworks: runtime.ownedNetworks, ownedRuntimeArtifacts,
    completedFixedNodeTasks: runtime.completedFixedNodeTasks, totalOwnedResidue,
  });
}

async function main() {
  OBSERVED_TOOL_DISPATCHES.clear();
  const provenance = await prepareFreshRuntime();
  const config = parseArguments(process.argv.slice(2));
  await mkdir(config.outputRoot, { recursive: true });
  if (isProtectedCanaryPath(config.outputRoot)) fail("M12_DISPOSABLE_PROTECTED_ROOT_DENIED");
  await reserveHighPort(config.port);
  const fixtureRoot = join(ROOT, "runtime", "m12-disposable-b5", config.runId);
  const canonical = join(fixtureRoot, "canonical");
  if (!contained(join(ROOT, "runtime", "m12-disposable-b5"), fixtureRoot) || isProtectedCanaryPath(fixtureRoot)) fail("M12_DISPOSABLE_PROTECTED_ROOT_DENIED");
  let result;
  try {
    await initializeCanonical(fixtureRoot, canonical);
    const fixtureRuntime = await runtimeModules.createM12DisposableB5FixtureRuntime({ fixtureRoot, canonicalRoot: canonical });
    const runtime = fixtureRuntime.runtime;
    const gitApi = new runtimeModules.LocalOperatorGit();
    const initialHead = await gitApi.head(canonical);
    const listedSurface = [...runtimeModules.OPERATOR_V1_TOOL_NAMES];
    const status = await dispatch(runtime, "operator_status", {});
    const capabilities = await dispatch(runtime, "operator_capabilities", {});
    const authorityExpanded = !(status.mode === "ACTIVE" && status.mutationActive === true && status.destructive === "LOCKED"
      && capabilities.s2Enabled === false && capabilities.genericExec === false && capabilities.genericShell === false);

    const surface = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "surface.begin");
    const surfaceMoveBytes = await readFile(join(surface.worktreePath, "surface-move.txt"), "utf8");
    const surfaceRemoveBytes = await readFile(join(surface.worktreePath, "surface-remove.txt"), "utf8");
    allow(await dispatch(runtime, "operator_stage_move", { txId: surface.txId, fromRel: "surface-move.txt", toRel: "surface-moved.txt", preimageSha256: digest(surfaceMoveBytes) }), "surface.move");
    allow(await dispatch(runtime, "operator_stage_remove", { txId: surface.txId, relPath: "surface-remove.txt", preimageSha256: digest(surfaceRemoveBytes) }), "surface.remove");
    const surfaceRollback = await dispatch(runtime, "operator_rollback_transaction", { txId: surface.txId });
    if (surfaceRollback.decision !== "ALLOW" || surfaceRollback.state !== "ROLLED_BACK") fail("M12_DISPOSABLE_SURFACE_ROLLBACK_DENIED");

    const benign = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "benign.begin");
    const benignHead = await gitApi.head(canonical); const benignBytes = await readFile(join(canonical, "fixture.txt"), "utf8");
    allow(await dispatch(runtime, "operator_stage_create", { txId: benign.txId, relPath: "rollback-marker.txt", contentBase64: base64("discard\n") }), "benign.stage");
    const benignRollback = await dispatch(runtime, "operator_rollback_transaction", { txId: benign.txId });
    const benignCanonicalUnchanged = benignRollback.decision === "ALLOW" && benignRollback.state === "ROLLED_BACK"
      && (await gitApi.head(canonical)) === benignHead && (await gitApi.status(canonical)) === "" && (await readFile(join(canonical, "fixture.txt"), "utf8")) === benignBytes;

    const correction = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "correction.begin");
    const correctionOriginal = await readFile(join(correction.worktreePath, "fixture-state.json"), "utf8");
    const correctionState = JSON.parse(correctionOriginal);
    const correctionContent = `${JSON.stringify({ ...correctionState, revision: correctionState.revision + 1, artifactValue: "correction" }, null, 2)}\n`;
    allow(await dispatch(runtime, "operator_stage_patch", { txId: correction.txId, relPath: "fixture-state.json", preimageSha256: digest(correctionOriginal), newContentBase64: base64(correctionContent) }), "correction.stage");
    allow(await dispatch(runtime, "operator_validate_transaction", { txId: correction.txId }), "correction.validate");
    allow(await dispatch(runtime, "operator_apply_transaction", { txId: correction.txId }), "correction.apply");
    const correctionTask = await dispatch(runtime, "operator_run_task", { txId: correction.txId, taskId: "project.test", params: {} });
    const correctionCheckpoint = allow(await dispatch(runtime, "operator_git_checkpoint", { txId: correction.txId, message: "disposable bounded correction" }), "correction.checkpoint");
    const correctionPromotion = await dispatch(runtime, "operator_promote_transaction", { txId: correction.txId, expectedHeadSha: correction.baseHeadSha, checkpointId: correctionCheckpoint.checkpointId });
    const correctionFf = correctionPromotion.decision === "ALLOW" && (await gitApi.head(canonical)) === correctionCheckpoint.checkpointId && (await gitApi.status(canonical)) === "";


    const isolation = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "isolation.begin");
    const isolationJsPath = join(isolation.worktreePath, "fixture.test.mjs");
    const isolationOriginal = await readFile(isolationJsPath, "utf8");
    const hostEscapeMarker = join(fixtureRoot, "host-code-escape-marker.txt");
    const maliciousJs = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(hostEscapeMarker)}, "executed\\n");\n`;
    allow(await dispatch(runtime, "operator_stage_patch", { txId: isolation.txId, relPath: "fixture.test.mjs", preimageSha256: digest(isolationOriginal), newContentBase64: base64(maliciousJs) }), "isolation.stage");
    allow(await dispatch(runtime, "operator_validate_transaction", { txId: isolation.txId }), "isolation.validate");
    allow(await dispatch(runtime, "operator_apply_transaction", { txId: isolation.txId }), "isolation.apply");
    const isolationTask = await dispatch(runtime, "operator_run_task", { txId: isolation.txId, taskId: "project.test", params: {} });
    const maliciousWorktreeJsNeverExecuted = !(await exists(hostEscapeMarker));
    const fixedRunnerPath = join(ROOT, "scripts", "m12-disposable-b5-fixed-runner.mjs");
    const fixedRunnerOutsideWorktree = !contained(isolation.worktreePath, fixedRunnerPath);
    const runnerArgumentsProtected = [join(isolation.worktreePath, "fixture-state.json"), join(isolation.worktreePath, "coverage", "qualification-artifact.txt")].some(isProtectedCanaryPath);
    const isolationRollback = await dispatch(runtime, "operator_rollback_transaction", { txId: isolation.txId });

    const staleA = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "stale.a.begin");
    const staleB = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "stale.b.begin");
    for (const [transaction, file, bytes] of [[staleA, "advance-a.txt", "A\n"], [staleB, "advance-b.txt", "B\n"]]) {
      allow(await dispatch(runtime, "operator_stage_create", { txId: transaction.txId, relPath: file, contentBase64: base64(bytes) }), `stale.${file}.stage`);
      allow(await dispatch(runtime, "operator_validate_transaction", { txId: transaction.txId }), `stale.${file}.validate`);
      allow(await dispatch(runtime, "operator_apply_transaction", { txId: transaction.txId }), `stale.${file}.apply`);
    }
    const staleACheckpoint = allow(await dispatch(runtime, "operator_git_checkpoint", { txId: staleA.txId, message: "disposable concurrent advance A" }), "stale.a.checkpoint");
    const staleBCheckpoint = allow(await dispatch(runtime, "operator_git_checkpoint", { txId: staleB.txId, message: "disposable concurrent advance B" }), "stale.b.checkpoint");
    const staleAPromotion = await dispatch(runtime, "operator_promote_transaction", { txId: staleA.txId, expectedHeadSha: staleA.baseHeadSha, checkpointId: staleACheckpoint.checkpointId });
    const staleDenied = await dispatch(runtime, "operator_promote_transaction", { txId: staleB.txId, expectedHeadSha: staleB.baseHeadSha, checkpointId: staleBCheckpoint.checkpointId });
    const staleRollback = await dispatch(runtime, "operator_rollback_transaction", { txId: staleB.txId });
    const staleMutationAbsent = !(await exists(join(canonical, "advance-b.txt")));

    const failing = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "remediation.fail.begin");
    const passingState = await readFile(join(failing.worktreePath, "fixture-state.json"), "utf8");
    const failingState = JSON.parse(passingState);
    const failingContent = `${JSON.stringify({ ...failingState, ready: "broken", revision: failingState.revision + 1, emitAllowedArtifact: false }, null, 2)}\n`;
    allow(await dispatch(runtime, "operator_stage_patch", { txId: failing.txId, relPath: "fixture-state.json", preimageSha256: digest(passingState), newContentBase64: base64(failingContent) }), "remediation.fail.stage");
    allow(await dispatch(runtime, "operator_validate_transaction", { txId: failing.txId }), "remediation.fail.validate");
    allow(await dispatch(runtime, "operator_apply_transaction", { txId: failing.txId }), "remediation.fail.apply");
    const failedFirst = await dispatch(runtime, "operator_run_task", { txId: failing.txId, taskId: "project.test", params: {} });
    const failedSecond = await dispatch(runtime, "operator_run_task", { txId: failing.txId, taskId: "project.test", params: {} });
    const acceptedReplan = await fixtureRuntime.acceptPendingRemediationReplanAndApplyCorrection();
    let secondReplanRejected = false;
    try { await fixtureRuntime.acceptPendingRemediationReplanAndApplyCorrection(); }
    catch { secondReplanRejected = true; }
    const continuedPass = await dispatch(runtime, "operator_run_task", { txId: failing.txId, taskId: "project.test", params: {} });
    const failedRollback = await dispatch(runtime, "operator_rollback_transaction", { txId: failing.txId });
    const negativeRemediation = await fixtureRuntime.measureRemediationNegativeTerminals();

    const lockTx = allow(await dispatch(runtime, "operator_begin_transaction", { projectId: "operator-canary", canonicalRoot: canonical }), "lock.begin");
    allow(await dispatch(runtime, "operator_stage_create", { txId: lockTx.txId, relPath: "lock-effect-marker.txt", contentBase64: base64("lock-effect\n") }), "lock.stage");
    allow(await dispatch(runtime, "operator_validate_transaction", { txId: lockTx.txId }), "lock.validate");
    allow(await dispatch(runtime, "operator_apply_transaction", { txId: lockTx.txId }), "lock.apply");
    const lockTask = await dispatch(runtime, "operator_run_task", { txId: lockTx.txId, taskId: "project.test", params: {} });
    const foreignLock = join(canonical, ".git", "foreign-preserve.lock");
    await writeFile(foreignLock, "foreign fixture lock\n", "utf8");
    const foreignRecovery = await fixtureRuntime.recoverAfterSimulatedOwnerDeath();
    const foreignLockPreserved = await exists(foreignLock);
    await rm(foreignLock, { force: false });
    const cleanupRecovery = await fixtureRuntime.recoverAfterSimulatedOwnerDeath();
    const recoveryRolledBack = cleanupRecovery.some((entry) => entry.transactionId === lockTx.txId && entry.classification === "SAFE_TO_ROLLBACK");
    const residue = await inspectOwnedResidue(fixtureRoot, fixtureRuntime);

    const remediationGates = Object.freeze({
      retrySamePlan: failedFirst.stability?.directive === "RETRY_SAME_PLAN" && failedFirst.stability?.attempt === 1,
      replanRequired: failedSecond.stability?.directive === "REPLAN_REQUIRED" && failedSecond.stability?.attempt === 2,
      stableFingerprints: failedFirst.stability?.coarseFingerprint === failedSecond.stability?.coarseFingerprint
        && failedFirst.stability?.fineFingerprint === failedSecond.stability?.fineFingerprint,
      replanAcceptedExactlyOnce: acceptedReplan.accepted && secondReplanRejected,
      sameEpisodePass: continuedPass.decision === "ALLOW" && acceptedReplan.transactionId === failing.txId
        && continuedPass.stability?.directive === "PASS" && continuedPass.stability?.replanUsed === true,
      sameAttemptLineage: continuedPass.stability?.attempt === failedSecond.stability?.attempt,
      attemptsWithinBudget: [failedFirst.stability?.attempt, failedSecond.stability?.attempt, continuedPass.stability?.attempt]
        .every((attempt) => Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 5),
      durableStagnationTerminal: negativeRemediation.stagnation.directive === "AUTONOMOUS_REMEDIATION_STAGNATED" && negativeRemediation.stagnation.durable,
      durableBudgetTerminal: negativeRemediation.budget.directive === "AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED" && negativeRemediation.budget.durable,
      rollbackCompleted: failedRollback.decision === "ALLOW" && failedRollback.state === "ROLLED_BACK",
    });
    const remediationPass = (gates) => Object.values(gates).every((value) => value === true);
    const missingGatePasses = Object.freeze(Object.fromEntries(Object.keys(remediationGates)
      .map((gate) => [gate, remediationPass({ ...remediationGates, [gate]: false })])));
    const allowedLockEffect = lockTask.decision === "ALLOW" && lockTask.metadata?.effectSummary?.allowedArtifact > 0;
    const lockEffectTransactionMatch = lockTask.metadata?.transactionId === lockTx.txId;
    const patterns = Object.freeze({
      benignRollback: Object.freeze({ passed: benignCanonicalUnchanged, canonicalUnchanged: benignCanonicalUnchanged, rollbackState: benignRollback.state }),
      correctionPromotion: Object.freeze({ passed: correctionTask.decision === "ALLOW" && correctionFf, taskId: "project.test",
        checkpointed: correctionCheckpoint.checkpointId !== undefined, promoted: correctionPromotion.decision === "ALLOW",
        ffOnly: correctionFf, casBound: correctionPromotion.decision === "ALLOW" && correctionPromotion.transaction?.baseHeadSha === correction.baseHeadSha }),
      hostCodeIsolation: Object.freeze({
        passed: isolationTask.decision === "ALLOW" && maliciousWorktreeJsNeverExecuted && fixedRunnerOutsideWorktree
          && !runnerArgumentsProtected && isolationRollback.decision === "ALLOW",
        maliciousWorktreeJsNeverExecuted, fixedRunnerOutsideWorktree,
        networkAuthority: isolationTask.decision === "ALLOW" ? "NONE" : "UNKNOWN",
        protectedWriteAttempted: runnerArgumentsProtected, taskDecision: isolationTask.decision,
      }),
      staleCas: Object.freeze({ passed: staleAPromotion.decision === "ALLOW" && staleDenied.decision === "DENY"
        && staleDenied.reason === "STALE_CANONICAL_HEAD" && staleRollback.decision === "ALLOW"
        && staleRollback.state === "ROLLED_BACK" && staleMutationAbsent,
        deniedReason: staleDenied.reason, publicRollbackAccepted: staleRollback.decision === "ALLOW",
        publicRollbackState: staleRollback.state, staleMutationAbsent, rolledBack: staleRollback.state === "ROLLED_BACK" }),
      autonomousRemediation: Object.freeze({ passed: remediationPass(remediationGates), gates: remediationGates,
        missingGatePasses, failureFingerprintStable: remediationGates.stableFingerprints,
        directives: [failedFirst.stability?.directive, failedSecond.stability?.directive, continuedPass.stability?.directive],
        replanBounded: remediationGates.retrySamePlan && remediationGates.replanRequired,
        cleanStateReplanAccepted: acceptedReplan.accepted, passContinuesReplanEpisode: remediationGates.sameEpisodePass,
        stagnation: negativeRemediation.stagnation, budget: negativeRemediation.budget,
        attemptsWithinBudget: remediationGates.attemptsWithinBudget }),
      lockEffectRecovery: Object.freeze({ passed: allowedLockEffect && lockEffectTransactionMatch
        && foreignRecovery.some((entry) => entry.transactionId === lockTx.txId && entry.classification === "MANUAL_RECONCILIATION_REQUIRED")
        && foreignLockPreserved && recoveryRolledBack,
        allowedArtifactEffect: allowedLockEffect, effectTransactionId: lockTask.metadata?.transactionId,
        recoveredTransactionId: lockTx.txId, effectTaskId: lockTask.taskId,
        foreignLockPreserved, foreignRecovery: foreignRecovery.map((entry) => entry.classification),
        cleanupRecovery: cleanupRecovery.map((entry) => entry.classification), rolledBack: recoveryRolledBack }),
    });
    const allPatternsPassed = Object.values(patterns).every((pattern) => pattern.passed);
    const zeroOwnedResidue = residue.totalOwnedResidue === 0;
    const observedToolDispatches = Object.freeze(listedSurface.filter((name) => OBSERVED_TOOL_DISPATCHES.has(name)));
    const exactToolSurface = observedToolDispatches.length === listedSurface.length && OBSERVED_TOOL_DISPATCHES.size === listedSurface.length;
    await assertRuntimeProvenanceStable(provenance);
    result = Object.freeze({
      schema: "HAIOS_M12_DISPOSABLE_B5_QUALIFICATION_R1", runId: config.runId,
      provenance,
      fixture: Object.freeze({ kind: "DISPOSABLE_GIT_CANONICAL", canonicalRoot: canonical, port: config.port, portProbe: "loopback-reserved-and-released", prohibitedPortsUsed: config.port === 8768 || config.port === 8769, initialHead }),
      authority: Object.freeze({ exactToolSurface: listedSurface, observedToolDispatches, exactToolSurfacePassed: exactToolSurface, authorityExpanded, genericExec: capabilities.genericExec, genericShell: capabilities.genericShell, s2Enabled: capabilities.s2Enabled, remoteGitMutation: false, modelGeneratedCommands: false, fixedRecipesOnly: true, runtimeProvenance: "M12_DISPOSABLE_B5_FIXTURE_CORE" }),
      patterns, residue,
      normalized: Object.freeze({ schema: "HAIOS_M12_DISPOSABLE_B5_QUALIFICATION_R1", provenance: [provenance.headSha, provenance.sourceManifestSha256, provenance.compiledOutputSha256], allPatternsPassed, correction: [correctionTask.taskId, correctionCheckpoint.checkpointId !== undefined, patterns.correctionPromotion.ffOnly, patterns.correctionPromotion.casBound], stale: patterns.staleCas.deniedReason, remediation: patterns.autonomousRemediation.directives, recovery: patterns.lockEffectRecovery.foreignRecovery, zeroOwnedResidue, authorityExpanded, exactToolSurface }),
    });
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
  if (result === undefined || !result.normalized.allPatternsPassed || !result.normalized.zeroOwnedResidue || result.normalized.authorityExpanded || !result.normalized.exactToolSurface) fail(`M12_DISPOSABLE_RESULT_DENIED:${JSON.stringify({ normalized: result?.normalized, patterns: result?.patterns, residue: result?.residue })}`);
  await writeFile(join(config.outputRoot, RESULT_NAME), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

await main();
