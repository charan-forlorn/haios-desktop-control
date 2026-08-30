import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compiledDigest, verifyPreparedB6RuntimeBuild } from "./b6-runtime-attestation.mjs";

const run = promisify(execFile);
async function currentUserSid() {
  const result = await run("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  const match = result.stdout.match(/S-\d-\d+(?:-\d+)+/u);
  if (!match) throw new Error("B6_RUNTIME_EXECUTION_IDENTITY_REQUIRED");
  return match[0];
}
async function lockExecutionRoot(executionRoot, sid) {
  await run("icacls", [executionRoot, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)RX`, `*${sid}:RX`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-18:F", "/T", "/C"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
async function unlockExecutionRoot(executionRoot, _sid) {
  await run("icacls", [executionRoot, "/reset", "/T", "/C"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("B6_CONFIG_PATH_REQUIRED");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preparePath = join(repoRoot, "scripts", "prepare-b6-runtime-build.mjs");
const preparedProcess = await run(process.execPath, [preparePath], { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const prepared = JSON.parse(preparedProcess.stdout.trim().split(/\r?\n/u).at(-1));
if (prepared?.schema !== "HAIOS_B6_RUNTIME_BUILD_R1" || !/^[a-f0-9]{64}$/u.test(prepared.candidateManifestSha256 ?? "")
  || !/^[a-f0-9]{64}$/u.test(prepared.compiledOutputSha256 ?? "") || !Number.isSafeInteger(prepared.compiledFileCount)) {
  throw new Error("B6_RUNTIME_BUILD_ATTESTATION_INVALID");
}
let buildRoot = resolve(prepared.buildRoot);
const runtimeRoot = resolve(repoRoot, "runtime");
const runtimeReal = await realpath(runtimeRoot);
buildRoot = await realpath(buildRoot);
const buildRel = relative(runtimeReal, buildRoot);
if (buildRel === "" || isAbsolute(buildRel) || buildRel === ".." || buildRel.startsWith(`..${sep}`)) {
  throw new Error("B6_RUNTIME_BUILD_ROOT_DENIED");
}
const preparedBuildRoot = buildRoot;
let executionRoot; let executionSid; let started; let attestationPath; let tempAttestationPath; let attestation;
try {
  const buildMetadata = JSON.parse(await readFile(join(buildRoot, "b6-runtime-build.json"), "utf8"));
if (buildMetadata.candidateHeadSha !== prepared.candidateHeadSha || buildMetadata.candidateManifestSha256 !== prepared.candidateManifestSha256
  || buildMetadata.compiledOutputSha256 !== prepared.compiledOutputSha256 || buildMetadata.compiledFileCount !== prepared.compiledFileCount) {
  throw new Error("B6_RUNTIME_BUILD_METADATA_DRIFT");
}
const config = JSON.parse(await readFile(args[0], "utf8"));
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("B6_RUNTIME_LOCALAPPDATA_REQUIRED");
if (config.stage === "HERMES_OS") {
  const preflightPath = join(repoRoot, "scripts", "preflight-b6-project-expansion.ps1");
  const stageOneRoot = resolve(localAppData, "HAIOS", "B6", "evidence", "stage1");
  try {
    await run("pwsh", ["-NoProfile", "-File", preflightPath, "-Stage", "SKILL_FABRIC",
      "-CandidateManifestSha256", prepared.candidateManifestSha256,
      "-EvidencePath", resolve(stageOneRoot, "stage1-live-qualification.json"),
      "-CertificationPath", resolve(stageOneRoot, "stage1-final-certification.json"), "-ValidateOnly"],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch { throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED"); }
}
buildRoot = await verifyPreparedB6RuntimeBuild(prepared);
const executionParent = resolve(localAppData, "HAIOS", "B6", "runtime-exec");
await mkdir(executionParent, { recursive: true });
executionRoot = await mkdtemp(join(executionParent, "b6-exec-"));
await cp(buildRoot, executionRoot, { recursive: true, force: false, errorOnExist: false });
const executionMetadataPath = join(executionRoot, "b6-runtime-build.json");
await writeFile(executionMetadataPath, `${JSON.stringify({ ...buildMetadata, buildRoot: executionRoot })}\n`, "utf8");
executionSid = await currentUserSid();
await lockExecutionRoot(executionRoot, executionSid);
const executionMetadata = JSON.parse(await readFile(executionMetadataPath, "utf8"));
const executionDigest = await compiledDigest(executionRoot);
if (resolve(executionMetadata.buildRoot) !== executionRoot || executionMetadata.candidateHeadSha !== prepared.candidateHeadSha
  || executionMetadata.candidateManifestSha256 !== prepared.candidateManifestSha256
  || executionMetadata.compiledOutputSha256 !== prepared.compiledOutputSha256 || executionMetadata.compiledFileCount !== prepared.compiledFileCount
  || executionDigest.compiledFileCount !== prepared.compiledFileCount || executionDigest.compiledOutputSha256 !== prepared.compiledOutputSha256) {
  throw new Error("B6_RUNTIME_EXECUTION_COPY_DRIFT");
}
await rm(preparedBuildRoot, { recursive: true, force: false });
buildRoot = executionRoot;
const runtimeModule = await import(pathToFileURL(join(executionRoot, "src", "operator", "b6-active-runtime.js")).href);
started = await runtimeModule.createB6ActiveRuntime(config);
await started.listen();
const readiness = runtimeModule.createB6ReadinessMetadata(config);
attestationPath = resolve(localAppData, "HAIOS", "B6", "runtime-build-attestation.json");
const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const unsignedAttestation = Object.freeze({ schema: "HAIOS_B6_RUNTIME_BUILD_ATTESTATION_R1", pid: process.pid,
  candidateHeadSha: prepared.candidateHeadSha, candidateTrackedCount: prepared.candidateTrackedCount,
  candidateManifestSha256: prepared.candidateManifestSha256, compiledFileCount: prepared.compiledFileCount,
  compiledOutputSha256: prepared.compiledOutputSha256, buildRoot, stage: readiness.stage,
  activationScope: readiness.activationScope, protocolMode: readiness.protocolMode, port: readiness.port });
attestation = Object.freeze({ ...unsignedAttestation, attestationSha256: sha256(Buffer.from(stableJson(unsignedAttestation), "utf8")) });
tempAttestationPath = `${attestationPath}.tmp-${process.pid}`;
await writeFile(tempAttestationPath, `${JSON.stringify(attestation)}\n`, { encoding: "utf8", flag: "wx" });
await rename(tempAttestationPath, attestationPath);
process.stdout.write(`${JSON.stringify({ ...readiness, candidateHeadSha: prepared.candidateHeadSha,
  candidateManifestSha256: prepared.candidateManifestSha256, compiledOutputSha256: prepared.compiledOutputSha256 })}\n`);
} catch (error) {
  if (started) await started.close().catch(() => undefined);
  if (tempAttestationPath) await rm(tempAttestationPath, { force: true }).catch(() => undefined);
  if (attestationPath && attestation) {
    try {
      const current = JSON.parse(await readFile(attestationPath, "utf8"));
      if (current.pid === process.pid && current.attestationSha256 === attestation.attestationSha256) await rm(attestationPath, { force: false });
    } catch {}
  }
  await rm(preparedBuildRoot, { recursive: true, force: true }).catch(() => undefined);
  if (executionRoot) {
    if (executionSid) await unlockExecutionRoot(executionRoot, executionSid).catch(() => undefined);
    await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  throw error;
}
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await started.close();
  try {
    const current = JSON.parse(await readFile(attestationPath, "utf8"));
    if (current.pid === process.pid && current.attestationSha256 === attestation.attestationSha256) await rm(attestationPath, { force: false });
  } catch {}
  if (executionRoot && executionSid) await unlockExecutionRoot(executionRoot, executionSid);
  if (executionRoot) await rm(executionRoot, { recursive: true, force: true });
  process.exitCode = 0;
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
