import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withLockedBuildToolchain } from "./b6-lockfile-dependencies.mjs";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(repoRoot, "runtime");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = async (args) => (await run("git", ["-C", repoRoot, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();

async function sourceFacts() {
  const paths = (await git(["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const rows = [];
  for (const relPath of paths) rows.push(`${sha256(await readFile(join(repoRoot, relPath)))}  ${relPath.replaceAll("\\", "/")}`);
  return Object.freeze({
    candidateHeadSha: await git(["rev-parse", "HEAD"]),
    candidateTrackedCount: paths.length,
    candidateManifestSha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")),
    clean: (await git(["status", "--porcelain=v1"])) === "",
  });
}
async function directoryDigest(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== "b6-runtime-build.json") files.push(path);
      else if (!entry.isFile()) throw new Error("B6_RUNTIME_BUILD_OUTPUT_TYPE_DENIED");
    }
  }
  await visit(root);
  files.sort((a, b) => relative(root, a).split(sep).join("/").localeCompare(relative(root, b).split(sep).join("/"), "en"));
  const rows = [];
  for (const path of files) rows.push(`${sha256(await readFile(path))}  ${relative(root, path).split(sep).join("/")}`);
  return Object.freeze({ compiledFileCount: files.length, compiledOutputSha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")) });
}

const before = await sourceFacts();
if (!before.clean || !/^[a-f0-9]{40,64}$/u.test(before.candidateHeadSha)) throw new Error("B6_RUNTIME_SOURCE_NOT_CURRENT");
await mkdir(runtimeRoot, { recursive: true });
const buildRoot = await mkdtemp(join(runtimeRoot, "b6-live-build-"));
let complete = false;
try {
  let toolchainFacts;
  await withLockedBuildToolchain(async (toolchainRoot, facts) => {
    const tscCli = join(toolchainRoot, "node_modules", "typescript", "bin", "tsc");
    await access(tscCli);
    await run(process.execPath, [tscCli, "--project", join(repoRoot, "tsconfig.json"), "--outDir", buildRoot], { cwd: repoRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    toolchainFacts = facts;
  });
  if (!toolchainFacts) throw new Error("B6_RUNTIME_TOOLCHAIN_ATTESTATION_REQUIRED");
  await Promise.all([
    copyFile(join(repoRoot, "task-registry.m07.json"), join(buildRoot, "task-registry.m07.json")),
    copyFile(join(repoRoot, "task-effects.m07.json"), join(buildRoot, "task-effects.m07.json")),
  ]);
  const compiled = await directoryDigest(buildRoot);
  const after = await sourceFacts();
  if (!after.clean || after.candidateHeadSha !== before.candidateHeadSha || after.candidateTrackedCount !== before.candidateTrackedCount
    || after.candidateManifestSha256 !== before.candidateManifestSha256) throw new Error("B6_RUNTIME_SOURCE_CHANGED_DURING_BUILD");
  const metadata = Object.freeze({
    schema: "HAIOS_B6_RUNTIME_BUILD_R1",
    buildRoot,
    candidateHeadSha: before.candidateHeadSha,
    candidateTrackedCount: before.candidateTrackedCount,
    candidateManifestSha256: before.candidateManifestSha256,
    compiledFileCount: compiled.compiledFileCount,
    compiledOutputSha256: compiled.compiledOutputSha256,
    toolchainPackageRootCount: toolchainFacts.dependencyPackageRootCount,
    toolchainFileCount: toolchainFacts.dependencyFileCount,
    toolchainSha256: toolchainFacts.dependencySha256,
  });
  await writeFile(join(buildRoot, "b6-runtime-build.json"), `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx" });
  complete = true;
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
} finally {
  if (!complete) await rm(buildRoot, { recursive: true, force: true }).catch(() => undefined);
}
