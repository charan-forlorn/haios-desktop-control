import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("B6_CONFIG_PATH_REQUIRED");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preparePath = join(repoRoot, "scripts", "prepare-b6-runtime-build.mjs");
const prepared = await run(process.execPath, [preparePath], { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const build = JSON.parse(prepared.stdout.trim().split(/\r?\n/u).at(-1));
if (build?.schema !== "HAIOS_B6_RUNTIME_BUILD_R1" || !/^[a-f0-9]{64}$/u.test(build.candidateManifestSha256 ?? "")
  || !/^[a-f0-9]{64}$/u.test(build.compiledOutputSha256 ?? "") || !Number.isSafeInteger(build.compiledFileCount)) {
  throw new Error("B6_RUNTIME_BUILD_ATTESTATION_INVALID");
}
let buildRoot = resolve(build.buildRoot);
const runtimeRoot = resolve(repoRoot, "runtime");
const runtimeReal = await realpath(runtimeRoot);
buildRoot = await realpath(buildRoot);
const buildRel = relative(runtimeReal, buildRoot);
if (buildRel === "" || isAbsolute(buildRel) || buildRel === ".." || buildRel.startsWith(`..${sep}`)) {
  throw new Error("B6_RUNTIME_BUILD_ROOT_DENIED");
}
const buildMetadata = JSON.parse(await readFile(join(buildRoot, "b6-runtime-build.json"), "utf8"));
if (buildMetadata.candidateHeadSha !== build.candidateHeadSha || buildMetadata.candidateManifestSha256 !== build.candidateManifestSha256
  || buildMetadata.compiledOutputSha256 !== build.compiledOutputSha256 || buildMetadata.compiledFileCount !== build.compiledFileCount) {
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
      "-CandidateManifestSha256", build.candidateManifestSha256,
      "-EvidencePath", resolve(stageOneRoot, "stage1-live-qualification.json"),
      "-CertificationPath", resolve(stageOneRoot, "stage1-final-certification.json"), "-ValidateOnly"],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch { throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED"); }
}
const runtimeModule = await import(pathToFileURL(join(buildRoot, "src", "operator", "b6-active-runtime.js")).href);
const started = await runtimeModule.createB6ActiveRuntime(config);
await started.listen();
const readiness = runtimeModule.createB6ReadinessMetadata(config);
const attestationPath = resolve(localAppData, "HAIOS", "B6", "runtime-build-attestation.json");
const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const unsignedAttestation = Object.freeze({ schema: "HAIOS_B6_RUNTIME_BUILD_ATTESTATION_R1", pid: process.pid,
  candidateHeadSha: build.candidateHeadSha, candidateTrackedCount: build.candidateTrackedCount,
  candidateManifestSha256: build.candidateManifestSha256, compiledFileCount: build.compiledFileCount,
  compiledOutputSha256: build.compiledOutputSha256, buildRoot, stage: readiness.stage,
  activationScope: readiness.activationScope, protocolMode: readiness.protocolMode, port: readiness.port });
const attestation = Object.freeze({ ...unsignedAttestation, attestationSha256: sha256(Buffer.from(stableJson(unsignedAttestation), "utf8")) });
const tempAttestationPath = `${attestationPath}.tmp-${process.pid}`;
await writeFile(tempAttestationPath, `${JSON.stringify(attestation)}\n`, { encoding: "utf8", flag: "wx" });
await rename(tempAttestationPath, attestationPath);
process.stdout.write(`${JSON.stringify({ ...readiness, candidateHeadSha: build.candidateHeadSha,
  candidateManifestSha256: build.candidateManifestSha256, compiledOutputSha256: build.compiledOutputSha256 })}\n`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await started.close();
  try {
    const current = JSON.parse(await readFile(attestationPath, "utf8"));
    if (current.pid === process.pid && current.attestationSha256 === attestation.attestationSha256) await rm(attestationPath, { force: false });
  } catch {}
  await rm(buildRoot, { recursive: true, force: true });
  process.exitCode = 0;
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
