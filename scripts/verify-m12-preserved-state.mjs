import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const M12_PRESERVED_STATE_RECONCILIATION_REQUIRED = "M12_PRESERVED_STATE_RECONCILIATION_REQUIRED";
const EPISODE = /^episode-[a-f0-9]{32}$/u;
const TX = /^txn_[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RECOVERY = new Set(["SAFE_TO_CONTINUE", "SAFE_TO_ROLLBACK", "MANUAL_RECONCILIATION_REQUIRED"]);
const RECORD_KEYS = ["attempt","baseHeadSha","coarseFingerprint","episodeId","fineFingerprint","hash","progressFact","projectId","recovery","replanUsed","repositoryIdentity","schema","transactionId"].sort();
const TOP = new Set(["host-config.json", "worktrees", "leases", "transaction-recovery", "remediation"]);
function deny() { throw new Error(M12_PRESERVED_STATE_RECONCILIATION_REQUIRED); }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function sha(value) { return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex"); }
function samePath(a, b) { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }
async function regular(path, directory = false) {
  const st = await lstat(path).catch(() => deny());
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) deny();
  if (!samePath(await realpath(path).catch(() => deny()), path)) deny();
  return st;
}
function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function validateRecord(record, filename) {
  if (!exactKeys(record, RECORD_KEYS)) deny();
  if (record.schema !== "HAIOS_M12_REMEDIATION_EPISODE_R1" || record.projectId !== "operator-canary") deny();
  if (!EPISODE.test(record.episodeId) || filename !== `${record.episodeId}.json` || !TX.test(record.transactionId)) deny();
  if (!HEAD.test(record.baseHeadSha) || !Number.isInteger(record.attempt) || record.attempt < 1 || record.attempt > 5 || typeof record.replanUsed !== "boolean") deny();
  if (!SHA.test(record.coarseFingerprint) || !SHA.test(record.fineFingerprint) || !SHA.test(record.hash)) deny();
  if (typeof record.repositoryIdentity !== "string" || record.repositoryIdentity.length < 1 || record.repositoryIdentity.length > 4096 || /[\u0000-\u001f]/u.test(record.repositoryIdentity)) deny();
  if (typeof record.progressFact !== "string" || record.progressFact.length < 1 || record.progressFact.length > 256 || /[\u0000-\u001f]/u.test(record.progressFact)) deny();
  if (!RECOVERY.has(record.recovery) || (record.attempt === 2 && record.replanUsed === false)) deny();
  const { hash: _hash, ...snapshot } = record;
  if (sha(snapshot) !== record.hash) deny();
}

function validateHostConfig(config, stateRoot, canaryRoot, apiKeyFile) {
  const configKeys = ["activationScope","allowedProjects","apiKeyFile","mode","port","stateRoot","worktreeRoot"].sort();
  if (!exactKeys(config, configKeys) || config.port !== 8769 || config.mode !== "ACTIVE" || config.activationScope !== "M12_B5_CANARY_STABILITY_ONLY") deny();
  if (!samePath(config.stateRoot, stateRoot) || !samePath(config.worktreeRoot, join(stateRoot, "worktrees")) || !samePath(config.apiKeyFile, apiKeyFile)) deny();
  if (!exactKeys(config.allowedProjects, ["operator-canary"]) || !samePath(config.allowedProjects["operator-canary"], canaryRoot)) deny();
}

export async function inspectM12ActivationOwnedPartialState(stateRootInput, expectations) {
  if (typeof stateRootInput !== "string" || typeof expectations !== "object" || expectations === null) deny();
  const stateRoot = resolve(stateRootInput); const { canaryRoot, apiKeyFile } = expectations;
  if (typeof canaryRoot !== "string" || typeof apiKeyFile !== "string") deny();
  const rootStat = await lstat(stateRoot).catch((error) => error?.code === "ENOENT" ? undefined : deny());
  if (rootStat === undefined) {
    const summary = { status: "ABSENT", cleanupSafe: true, resourceResidueCount: 0, configPresent: false, presentDirectories: [] };
    return Object.freeze({ ...summary, digest: sha(summary) });
  }
  await regular(stateRoot, true);
  const top = await readdir(stateRoot, { withFileTypes: true });
  if (top.some((entry) => !TOP.has(entry.name))) deny();
  const presentDirectories = [];
  let resourceResidueCount = 0;
  for (const name of ["worktrees", "leases", "transaction-recovery", "remediation"]) {
    const path = join(stateRoot, name); const st = await lstat(path).catch((error) => error?.code === "ENOENT" ? undefined : deny());
    if (st === undefined) continue;
    await regular(path, true); presentDirectories.push(name);
    const entries = await readdir(path); resourceResidueCount += entries.length;
    if (entries.length !== 0) deny();
  }
  const configPath = join(stateRoot, "host-config.json");
  const configStat = await lstat(configPath).catch((error) => error?.code === "ENOENT" ? undefined : deny());
  let configPresent = false;
  if (configStat !== undefined) {
    await regular(configPath); const config = JSON.parse(await readFile(configPath, "utf8"));
    validateHostConfig(config, stateRoot, canaryRoot, apiKeyFile); configPresent = true;
  }
  const summary = { status: "ACTIVATION_OWNED_PARTIAL", cleanupSafe: true, resourceResidueCount, configPresent, presentDirectories: presentDirectories.sort() };
  return Object.freeze({ ...summary, digest: sha(summary) });
}

export async function inspectM12PreservedState(stateRootInput, expectations) {
  if (typeof stateRootInput !== "string" || typeof expectations !== "object" || expectations === null) deny();
  const stateRoot = resolve(stateRootInput); const { canaryRoot, apiKeyFile } = expectations;
  if (typeof canaryRoot !== "string" || typeof apiKeyFile !== "string") deny();
  const rootStat = await lstat(stateRoot).catch((error) => error?.code === "ENOENT" ? undefined : deny());
  if (rootStat === undefined) {
    const summary = { status: "ABSENT", remediationRecordCount: 0, resourceResidueCount: 0 };
    return Object.freeze({ ...summary, digest: sha(summary) });
  }
  await regular(stateRoot, true);
  const top = await readdir(stateRoot, { withFileTypes: true });
  if (top.some((entry) => !TOP.has(entry.name))) deny();
  for (const name of ["worktrees", "leases", "transaction-recovery", "remediation"]) await regular(join(stateRoot, name), true);
  let resourceResidueCount = 0;
  for (const name of ["worktrees", "leases", "transaction-recovery"]) {
    const entries = await readdir(join(stateRoot, name)); resourceResidueCount += entries.length;
  }
  if (resourceResidueCount !== 0) deny();
  const configPath = join(stateRoot, "host-config.json"); await regular(configPath);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateHostConfig(config, stateRoot, canaryRoot, apiKeyFile);
  const remediationDir = join(stateRoot, "remediation"); const names = await readdir(remediationDir);
  const records = [];
  for (const filename of names.sort()) {
    if (!/^episode-[a-f0-9]{32}\.json$/u.test(filename)) deny();
    const path = join(remediationDir, filename); await regular(path);
    const text = await readFile(path, "utf8"); const record = JSON.parse(text); validateRecord(record, filename);
    records.push({ filename, sha256: sha(text) });
  }
  const summary = { status: "VERIFIED_PRESERVED", remediationRecordCount: records.length, resourceResidueCount, hostConfigSha256: sha(await readFile(configPath, "utf8")), records };
  return Object.freeze({ ...summary, digest: sha(summary) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const local = process.env.LOCALAPPDATA; if (!local) deny();
    const stateRoot = join(local, "HAIOS", "M12");
    const expectations = { canaryRoot: "C:\\Workspace\\haios-operator-canary", apiKeyFile: join(local, "HAIOS", "M10", "operator-api-key") };
    const result = process.argv.includes("--activation-partial")
      ? await inspectM12ActivationOwnedPartialState(stateRoot, expectations)
      : await inspectM12PreservedState(stateRoot, expectations);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : M12_PRESERVED_STATE_RECONCILIATION_REQUIRED}\n`); process.exitCode = 2;
  }
}
