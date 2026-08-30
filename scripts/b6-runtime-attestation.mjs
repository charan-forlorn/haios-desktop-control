import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(repoRoot, "runtime");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
async function git(args) { return (await run("git", ["-C", repoRoot, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim(); }
export async function currentCandidateFacts() {
  const paths = (await git(["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const rows = [];
  for (const relPath of paths) rows.push(`${sha256(await readFile(join(repoRoot, relPath)))}  ${relPath.replaceAll("\\", "/")}`);
  return Object.freeze({ candidateHeadSha: await git(["rev-parse", "HEAD"]), candidateTrackedCount: paths.length,
    candidateManifestSha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")), clean: (await git(["status", "--porcelain=v1"])) === "" });
}
async function compiledDigest(buildRoot) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== "b6-runtime-build.json") files.push(path);
      else if (!entry.isFile()) throw new Error("B6_RUNTIME_BUILD_OUTPUT_TYPE_DENIED");
    }
  }
  await visit(buildRoot);
  files.sort((a, b) => relative(buildRoot, a).split(sep).join("/").localeCompare(relative(buildRoot, b).split(sep).join("/"), "en"));
  const rows = [];
  for (const path of files) rows.push(`${sha256(await readFile(path))}  ${relative(buildRoot, path).split(sep).join("/")}`);
  return Object.freeze({ compiledFileCount: files.length, compiledOutputSha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")) });
}
async function independentlyRebuildCurrentRuntime(current) {
  const prepared = await run(process.execPath, [join(repoRoot, "scripts", "prepare-b6-runtime-build.mjs")],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const verifier = JSON.parse(prepared.stdout.trim().split(/\r?\n/u).at(-1));
  if (verifier?.schema !== "HAIOS_B6_RUNTIME_BUILD_R1" || verifier.candidateHeadSha !== current.candidateHeadSha
    || verifier.candidateTrackedCount !== current.candidateTrackedCount || verifier.candidateManifestSha256 !== current.candidateManifestSha256
    || !Number.isSafeInteger(verifier.compiledFileCount) || !/^[a-f0-9]{64}$/u.test(verifier.compiledOutputSha256 ?? "")) {
    throw new Error("B6_RUNTIME_BUILD_REPRODUCTION_FAILED");
  }
  const verifierBuildRoot = resolve(verifier.buildRoot);
  const verifierRel = relative(runtimeRoot, verifierBuildRoot);
  if (verifierRel === "" || verifierRel === ".." || verifierRel.startsWith(`..${sep}`)) throw new Error("B6_RUNTIME_BUILD_REPRODUCTION_FAILED");
  const reproduced = await compiledDigest(verifierBuildRoot);
  if (reproduced.compiledFileCount !== verifier.compiledFileCount || reproduced.compiledOutputSha256 !== verifier.compiledOutputSha256) {
    throw new Error("B6_RUNTIME_BUILD_REPRODUCTION_FAILED");
  }
  return Object.freeze({ ...verifier, buildRoot: verifierBuildRoot });
}
export async function loadCurrentB6RuntimeBinding(expectedStage) {
  if (expectedStage !== "SKILL_FABRIC" && expectedStage !== "HERMES_OS") throw new Error("B6_RUNTIME_BINDING_STAGE_REQUIRED");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("B6_RUNTIME_LOCALAPPDATA_REQUIRED");
  const attestationPath = resolve(localAppData, "HAIOS", "B6", "runtime-build-attestation.json");
  const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
  const { attestationSha256, ...unsigned } = attestation;
  if (attestation.schema !== "HAIOS_B6_RUNTIME_BUILD_ATTESTATION_R1" || attestation.stage !== expectedStage
    || attestation.port !== 8769 || attestation.protocolMode !== "operator13" || !Number.isSafeInteger(attestation.pid)
    || attestation.pid <= 0 || !/^[a-f0-9]{64}$/u.test(attestation.candidateManifestSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(attestation.compiledOutputSha256 ?? "")
    || attestationSha256 !== sha256(Buffer.from(stableJson(unsigned), "utf8"))) throw new Error("B6_RUNTIME_BUILD_ATTESTATION_INVALID");
  const expectedScope = expectedStage === "SKILL_FABRIC" ? "B6_SKILL_FABRIC_ADMISSION" : "B6_HERMES_OS_ADMISSION";
  if (attestation.activationScope !== expectedScope) throw new Error("B6_RUNTIME_BUILD_ATTESTATION_INVALID");
  const buildRoot = resolve(attestation.buildRoot);
  const rel = relative(runtimeRoot, buildRoot);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("B6_RUNTIME_BUILD_ROOT_DENIED");
  const current = await currentCandidateFacts();
  if (!current.clean || attestation.candidateHeadSha !== current.candidateHeadSha || attestation.candidateTrackedCount !== current.candidateTrackedCount
    || attestation.candidateManifestSha256 !== current.candidateManifestSha256) throw new Error("B6_RUNTIME_BUILD_SOURCE_NOT_CURRENT");
  const metadata = JSON.parse(await readFile(join(buildRoot, "b6-runtime-build.json"), "utf8"));
  if (metadata.schema !== "HAIOS_B6_RUNTIME_BUILD_R1" || metadata.candidateHeadSha !== attestation.candidateHeadSha
    || metadata.candidateManifestSha256 !== attestation.candidateManifestSha256 || metadata.compiledOutputSha256 !== attestation.compiledOutputSha256
    || metadata.compiledFileCount !== attestation.compiledFileCount) throw new Error("B6_RUNTIME_BUILD_METADATA_DRIFT");
  const compiled = await compiledDigest(buildRoot);
  if (compiled.compiledFileCount !== attestation.compiledFileCount || compiled.compiledOutputSha256 !== attestation.compiledOutputSha256) {
    throw new Error("B6_RUNTIME_COMPILED_OUTPUT_DRIFT");
  }
  let verifier;
  try {
    verifier = await independentlyRebuildCurrentRuntime(current);
    if (verifier.compiledFileCount !== attestation.compiledFileCount || verifier.compiledOutputSha256 !== attestation.compiledOutputSha256) {
      throw new Error("B6_RUNTIME_BUILD_REPRODUCTION_FAILED");
    }
    try { process.kill(attestation.pid, 0); } catch { throw new Error("B6_RUNTIME_PROCESS_NOT_CURRENT"); }
    const hostConfig = await import(pathToFileURL(join(verifier.buildRoot, "src", "operator", "host-runtime-config.js")).href);
    const protocol = await import(pathToFileURL(join(verifier.buildRoot, "src", "operator", "protocol.js")).href);
    return Object.freeze({ attestation: Object.freeze(attestation), current, loadHostApiKey: hostConfig.loadHostApiKey,
      OPERATOR_V1_TOOL_NAMES: protocol.OPERATOR_V1_TOOL_NAMES });
  } finally {
    if (verifier?.buildRoot) await rm(verifier.buildRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
