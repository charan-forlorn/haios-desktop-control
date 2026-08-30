import { execFile } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const run = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(repoRoot, "runtime");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function lockfilePackageRoots(includeDev, installedRoot) {
  const lock = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
  if (lock?.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null) {
    throw new Error("B6_RUNTIME_DEPENDENCY_LOCK_INVALID");
  }
  const rels = Object.entries(lock.packages)
    .filter(([relPath, metadata]) => relPath.startsWith("node_modules/") && (includeDev || metadata?.dev !== true))
    .map(([relPath, metadata]) => {
      if (metadata?.link === true || typeof metadata?.integrity !== "string" || !/^sha512-[A-Za-z0-9+/=]+$/u.test(metadata.integrity)
        || relPath.includes("\\") || relPath.split("/").some((part) => part === ".." || part === "")) {
        throw new Error("B6_RUNTIME_DEPENDENCY_LOCK_INVALID");
      }
      return relPath;
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b, "en"));
  const roots = [];
  for (const relPath of rels) if (!roots.some((root) => relPath.startsWith(`${root}/node_modules/`))) roots.push(relPath);
  const installed = [];
  for (const relPath of roots) {
    try { await realpath(resolve(installedRoot, ...relPath.split("/"))); installed.push(relPath); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (installed.length === 0) throw new Error("B6_RUNTIME_DEPENDENCY_LOCK_INVALID");
  return Object.freeze(installed);
}

async function dependencyDigest(baseRoot, roots) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("B6_RUNTIME_DEPENDENCY_OUTPUT_TYPE_DENIED");
    }
  }
  for (const relRoot of roots) {
    const expected = resolve(baseRoot, ...relRoot.split("/"));
    const actual = await realpath(expected);
    if (actual !== expected) throw new Error("B6_RUNTIME_DEPENDENCY_ROOT_DENIED");
    await visit(actual);
  }
  files.sort((a, b) => relative(baseRoot, a).split(sep).join("/").localeCompare(relative(baseRoot, b).split(sep).join("/"), "en"));
  const rows = [];
  for (const path of files) rows.push(`${sha256(await readFile(path))}  ${relative(baseRoot, path).split(sep).join("/")}`);
  return Object.freeze({ dependencyPackageRootCount: roots.length, dependencyFileCount: files.length,
    dependencySha256: sha256(Buffer.from(`${rows.join("\n")}\n`, "utf8")) });
}

async function createOfflineLockedTree(includeDev) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, includeDev ? "b6-toolchain-" : "b6-proddeps-"));
  let complete = false;
  try {
    await Promise.all([
      copyFile(join(repoRoot, "package.json"), join(root, "package.json")),
      copyFile(join(repoRoot, "package-lock.json"), join(root, "package-lock.json")),
    ]);
    const args = ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root];
    if (!includeDev) args.splice(1, 0, "--omit=dev");
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "npm";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key)));
    const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
    if (typeof home !== "string" || home.length === 0) throw new Error("B6_RUNTIME_NPM_CACHE_REQUIRED");
    const cacheCandidate = process.platform === "win32" ? join(home, "AppData", "Local", "npm-cache") : join(home, ".npm");
    const cache = await realpath(cacheCandidate).catch(() => { throw new Error("B6_RUNTIME_NPM_CACHE_REQUIRED"); });
    await run(command, commandArgs, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...cleanEnv, npm_config_cache: cache, npm_config_offline: "true", npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" } });
    const roots = await lockfilePackageRoots(includeDev, root);
    const facts = await dependencyDigest(root, roots);
    complete = true;
    return Object.freeze({ root, roots, facts });
  } finally {
    if (!complete) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function withLockedBuildToolchain(callback) {
  const locked = await createOfflineLockedTree(true);
  try { return await callback(locked.root, locked.facts); }
  finally { await rm(locked.root, { recursive: true, force: true }); }
}

export async function productionDependencyFacts(baseRoot) {
  const root = resolve(baseRoot);
  return dependencyDigest(root, await lockfilePackageRoots(false, root));
}

export async function lockedProductionDependencyFacts() {
  const locked = await createOfflineLockedTree(false);
  try { return locked.facts; }
  finally { await rm(locked.root, { recursive: true, force: true }); }
}

export async function copyLockedProductionDependencies(destinationRoot) {
  const locked = await createOfflineLockedTree(false);
  try {
    await mkdir(join(destinationRoot, "node_modules"), { recursive: true });
    for (const relRoot of locked.roots) {
      const source = resolve(locked.root, ...relRoot.split("/"));
      const destination = resolve(destinationRoot, ...relRoot.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
    }
    const sourceAfter = await dependencyDigest(locked.root, locked.roots);
    const copied = await dependencyDigest(resolve(destinationRoot), locked.roots);
    if (sourceAfter.dependencyPackageRootCount !== locked.facts.dependencyPackageRootCount
      || sourceAfter.dependencyFileCount !== locked.facts.dependencyFileCount || sourceAfter.dependencySha256 !== locked.facts.dependencySha256
      || copied.dependencyPackageRootCount !== locked.facts.dependencyPackageRootCount
      || copied.dependencyFileCount !== locked.facts.dependencyFileCount || copied.dependencySha256 !== locked.facts.dependencySha256) {
      throw new Error("B6_RUNTIME_DEPENDENCY_COPY_DRIFT");
    }
    return copied;
  } finally { await rm(locked.root, { recursive: true, force: true }); }
}
