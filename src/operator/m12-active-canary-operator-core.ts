import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { createOperatorControlRuntime, type OperatorControlRuntime } from "./control-runtime.js";
import { LocalOperatorGit, readLocalGitCurrentBranch } from "./local-git.js";
import {
  M12StabilityCoordinator,
  createM12StabilityTaskApi,
  type M12StabilityFacts,
  type M12StabilityFactsProvider,
} from "./m12-stability-coordinator.js";
import {
  M12_ACTIVE_CANARY_PROJECT_ROOT,
  validateM12ActiveCanaryConfig,
  type M12ActiveCanaryConfig,
} from "./m12-active-canary-config.js";
import {
  createQualifiedOperatorControlRuntime,
  M08_QUALIFIED_RUNTIME_IDENTITY,
  type QualifiedOperatorControlRuntime,
} from "./qualified-control-runtime.js";
import { RecoveryLeaseManager, type ProcessIdentityProbe } from "./recovery-lease.js";
import { RemediationController } from "./remediation-controller.js";
import { RemediationStore } from "./remediation-store.js";
import { classifyRecovery, type RecoveryClassificationInput } from "./recovery-classifier.js";
import type { SandboxExecutionRequest, SandboxExecutionResult } from "./sandbox-executor.js";
import { loadTaskRegistryV2 } from "./task-contract-v2.js";
import { loadTaskEffectPolicy } from "./task-effects.js";
import { OperatorTaskRunner, type OperatorTaskRunRequest } from "./task-runner.js";
import type { OperatorTransactionRecord } from "./transaction-types.js";
import type {
  OperatorTransactionRecoveryCoordinator,
  OperatorTransactionRecoveryDecision,
} from "./transaction-isolation.js";
import { OperatorTransactionService } from "./transaction-isolation.js";

const RECOVERY_SCHEMA = "HAIOS_M12_TRANSACTION_RECOVERY_R1" as const;
const RECOVERY_TTL_MS = 300_000;
const RECOVERY_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_GIT_COMMON_DIR_ENTRIES = 4_096;
const MAX_GIT_COMMON_DIR_DEPTH = 32;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const TX = /^txn_[a-f0-9]{32}$/u;
const M12_CORE_RUNTIMES = new WeakSet<object>();

export interface M12ActiveCanaryReadinessMetadata {
  readonly host: "127.0.0.1";
  readonly port: 8769;
  readonly mode: "ACTIVE";
  readonly protocolMode: "operator13";
  readonly activationScope: "M12_B5_CANARY_STABILITY_ONLY";
  readonly projectIds: readonly ["operator-canary"];
  readonly runtimeProfile: typeof M08_QUALIFIED_RUNTIME_IDENTITY.profile;
  readonly registrySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256;
  readonly effectPolicySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256;
  readonly s2Enabled: false;
  readonly genericExec: false;
  readonly genericShell: false;
  readonly destructive: "LOCKED";
  readonly remediationBudget: 5;
  readonly cleanStateReplanLimit: 1;
}

export interface M12ActiveCanaryOperatorRuntime extends OperatorControlRuntime {
  readonly attestation: typeof M08_QUALIFIED_RUNTIME_IDENTITY;
}

interface RecoverySnapshot {
  readonly schema: typeof RECOVERY_SCHEMA;
  readonly record: Omit<OperatorTransactionRecord, "intents" | "checkpointId">;
  readonly repositoryIdentity: string;
  readonly hash: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
function samePath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}
function contained(parent: string, candidate: string): boolean {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${win32.sep}`) && !win32.isAbsolute(rel);
}
function runtimeIdentityPaths() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(moduleDir, "../.."), resolve(moduleDir, "../../..")]) {
    const registryPath = join(root, "task-registry.m07.json");
    const effectPolicyPath = join(root, "task-effects.m07.json");
    if (existsSync(registryPath) && existsSync(effectPolicyPath)) return Object.freeze({ root, registryPath, effectPolicyPath });
  }
  throw new Error("M12_ACTIVE_CANARY_RUNTIME_IDENTITY_FILES_NOT_FOUND");
}

interface M12RuntimeProcessProbe extends ProcessIdentityProbe {
  current(): Promise<{ readonly ownerPid: number; readonly ownerStartTime: string }>;
}

class RuntimeProcessProbe implements M12RuntimeProcessProbe {
  readonly #pid = process.pid;
  readonly #startTime = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
  async inspect(pid: number): Promise<{ readonly alive: boolean; readonly startTime: string } | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (pid === this.#pid) return Object.freeze({ alive: true, startTime: this.#startTime });
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return Object.freeze({ alive: false, startTime: "1970-01-01T00:00:00.000Z" });
      }
      return undefined;
    }
  }
  async current(): Promise<{ readonly ownerPid: number; readonly ownerStartTime: string }> {
    const value = await this.inspect(this.#pid);
    if (value === undefined || !value.alive) throw new Error("M12_RECOVERY_PROCESS_IDENTITY_UNAVAILABLE");
    return Object.freeze({ ownerPid: this.#pid, ownerStartTime: value.startTime });
  }
}

export interface M12RecoveryLeaseHeartbeatConfig {
  readonly leases: RecoveryLeaseManager;
  readonly transactionId: string;
  readonly owner: Readonly<{ readonly ownerPid: number; readonly ownerStartTime: string }>;
  readonly intervalMs: number;
  readonly schedule: (callback: () => void, intervalMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
}

/** Bounded renewal tied to one live in-memory transaction owner. */
export class M12RecoveryLeaseHeartbeat {
  readonly #leases: RecoveryLeaseManager;
  readonly #transactionId: string;
  readonly #owner: M12RecoveryLeaseHeartbeatConfig["owner"];
  readonly #intervalMs: number;
  readonly #schedule: M12RecoveryLeaseHeartbeatConfig["schedule"];
  readonly #cancel: M12RecoveryLeaseHeartbeatConfig["cancel"];
  #handle: unknown;
  #active = false;
  #failure: unknown;
  #tail: Promise<void> = Promise.resolve();

  constructor(config: M12RecoveryLeaseHeartbeatConfig) {
    if (!TX.test(config.transactionId)
      || !Number.isSafeInteger(config.intervalMs)
      || config.intervalMs < 1_000
      || config.intervalMs > RECOVERY_HEARTBEAT_INTERVAL_MS) {
      throw new Error("M12_RECOVERY_HEARTBEAT_DENIED");
    }
    this.#leases = config.leases;
    this.#transactionId = config.transactionId;
    this.#owner = Object.freeze({ ...config.owner });
    this.#intervalMs = config.intervalMs;
    this.#schedule = config.schedule;
    this.#cancel = config.cancel;
  }

  start(): void {
    if (this.#active || this.#failure !== undefined) return;
    this.#active = true;
    this.#handle = this.#schedule(() => { void this.pulse(); }, this.#intervalMs);
  }

  async pulse(): Promise<void> {
    if (!this.#active || this.#failure !== undefined) return;
    this.#tail = this.#tail.then(async () => {
      if (!this.#active || this.#failure !== undefined) return;
      try { await this.#leases.heartbeat(this.#transactionId, this.#owner); }
      catch (error) {
        this.#failure = error;
        this.stop();
      }
    });
    await this.#tail;
  }

  async flush(): Promise<void> { await this.#tail; }

  assertHealthy(): void {
    if (this.#failure !== undefined) throw new Error("M12_RECOVERY_HEARTBEAT_FAILED");
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#cancel(this.#handle);
    this.#handle = undefined;
  }
}

export async function scanM12CanonicalGitCommonDirForLocks(commonDir: string): Promise<boolean> {
  type PendingDirectory = Readonly<{ path: string; depth: number }>;
  const queue: PendingDirectory[] = [{ path: commonDir, depth: 0 }];
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    let directory;
    let entries;
    try {
      directory = await lstat(current.path);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await realpath(current.path), current.path)) return true;
      entries = await readdir(current.path, { withFileTypes: true });
    } catch { return true; }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_GIT_COMMON_DIR_ENTRIES || entry.name.toLowerCase().endsWith(".lock")) return true;
      const candidate = join(current.path, entry.name);
      let stat;
      try {
        stat = await lstat(candidate);
        if (stat.isSymbolicLink() || !samePath(await realpath(candidate), candidate)) return true;
      } catch { return true; }
      if (stat.isDirectory()) {
        if (current.depth >= MAX_GIT_COMMON_DIR_DEPTH) return true;
        queue.push({ path: candidate, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

interface M12RecoveryRuntimeConfig {
  readonly stateRoot: string;
  readonly worktreeRoot: string;
  readonly allowedProjectIds?: readonly ("operator-canary" | "skill-fabric" | "hermes-os")[];
  readonly probe?: M12RuntimeProcessProbe;
  readonly now?: () => number;
}

class M12RuntimeRecoveryCoordinator implements OperatorTransactionRecoveryCoordinator {
  readonly #stateRoot: string;
  readonly #worktreeRoot: string;
  readonly #git = new LocalOperatorGit();
  readonly #probe: M12RuntimeProcessProbe;
  readonly #leases: RecoveryLeaseManager;
  readonly #heartbeats = new Map<string, M12RecoveryLeaseHeartbeat>();
  readonly #allowedProjectIds: ReadonlySet<string>;
  constructor(config: M12RecoveryRuntimeConfig) {
    this.#stateRoot = resolve(config.stateRoot);
    this.#worktreeRoot = win32.resolve(config.worktreeRoot);
    this.#probe = config.probe ?? new RuntimeProcessProbe();
    this.#allowedProjectIds = new Set(config.allowedProjectIds ?? ["operator-canary"]);
    if (this.#allowedProjectIds.size === 0 || [...this.#allowedProjectIds].some((id) => id !== "operator-canary" && id !== "skill-fabric" && id !== "hermes-os")) {
      throw new Error("M12_RECOVERY_PROJECT_POLICY_DENIED");
    }
    this.#leases = new RecoveryLeaseManager({
      stateRoot: this.#stateRoot, processProbe: this.#probe, ...(config.now === undefined ? {} : { now: config.now }),
    });
  }
  projectAllowed(projectId: string): projectId is "operator-canary" | "skill-fabric" | "hermes-os" {
    return this.#allowedProjectIds.has(projectId);
  }
  #matchesSnapshot(snapshot: RecoverySnapshot, record: OperatorTransactionRecord): boolean {
    const saved = snapshot.record;
    return saved.txId === record.txId && saved.projectId === record.projectId && saved.canonicalRoot === record.canonicalRoot
      && saved.worktreePath === record.worktreePath && saved.branchName === record.branchName && saved.baseHeadSha === record.baseHeadSha;
  }
  async #directory(): Promise<string> {
    await mkdir(this.#stateRoot, { recursive: true });
    const root = await realpath(this.#stateRoot);
    if (!samePath(root, this.#stateRoot)) throw new Error("M12_RECOVERY_STATE_ROOT_RECONCILIATION_REQUIRED");
    const directory = join(root, "transaction-recovery");
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    const actual = await realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(actual, directory)) {
      throw new Error("M12_RECOVERY_STATE_ROOT_RECONCILIATION_REQUIRED");
    }
    return actual;
  }
  async #path(txId: string): Promise<string> {
    if (!TX.test(txId)) throw new Error("M12_RECOVERY_TRANSACTION_ID_DENIED");
    return join(await this.#directory(), `${txId}.json`);
  }
  #snapshot(record: OperatorTransactionRecord, repositoryIdentity: string): RecoverySnapshot {
    if (!this.#allowedProjectIds.has(record.projectId) || record.intents.length !== 0 || !contained(this.#worktreeRoot, record.worktreePath)) {
      throw new Error("M12_RECOVERY_RECORD_DENIED");
    }
    const base = Object.freeze({
      schema: RECOVERY_SCHEMA,
      record: Object.freeze({
        txId: record.txId, projectId: record.projectId, canonicalRoot: record.canonicalRoot,
        worktreePath: record.worktreePath, branchName: record.branchName, baseHeadSha: record.baseHeadSha,
        createdAt: record.createdAt, state: record.state,
      }),
      repositoryIdentity,
    });
    return Object.freeze({ ...base, hash: sha256(base) });
  }
  async #read(txId: string): Promise<RecoverySnapshot> {
    const path = await this.#path(txId);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) {
      throw new Error("M12_RECOVERY_RECORD_RECONCILIATION_REQUIRED");
    }
    const value = JSON.parse(await readFile(path, "utf8")) as RecoverySnapshot;
    if (value.schema !== RECOVERY_SCHEMA || value.record?.txId !== txId || !this.#allowedProjectIds.has(value.record.projectId)) {
      throw new Error("M12_RECOVERY_RECORD_RECONCILIATION_REQUIRED");
    }
    const base = { schema: value.schema, record: value.record, repositoryIdentity: value.repositoryIdentity };
    if (!/^[a-f0-9]{64}$/u.test(value.hash) || value.hash !== sha256(base)) {
      throw new Error("M12_RECOVERY_RECORD_RECONCILIATION_REQUIRED");
    }
    return Object.freeze(value);
  }
  async #writeExclusive(snapshot: RecoverySnapshot): Promise<void> {
    const path = await this.#path(snapshot.record.txId);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(stableJson(snapshot), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  }
  async #removeSnapshot(snapshot: RecoverySnapshot): Promise<void> {
    const path = await this.#path(snapshot.record.txId);
    const current = await this.#read(snapshot.record.txId);
    if (current.hash !== snapshot.hash) throw new Error("M12_RECOVERY_RECORD_RECONCILIATION_REQUIRED");
    await unlink(path);
  }
  async onBegin(record: OperatorTransactionRecord, repositoryIdentity: string): Promise<void> {
    const owner = await this.#probe.current();
    const lease = await this.#leases.acquire({
      projectId: record.projectId as "operator-canary" | "skill-fabric" | "hermes-os", repositoryIdentity, transactionId: record.txId,
      ownerPid: owner.ownerPid, ownerStartTime: owner.ownerStartTime, ttlMs: RECOVERY_TTL_MS,
    });
    const snapshot = this.#snapshot(record, repositoryIdentity);
    try {
      await this.#writeExclusive(snapshot);
      const heartbeat = new M12RecoveryLeaseHeartbeat({
        leases: this.#leases, transactionId: record.txId,
        owner: { ownerPid: lease.ownerPid, ownerStartTime: lease.ownerStartTime },
        intervalMs: RECOVERY_HEARTBEAT_INTERVAL_MS,
        schedule: (callback, intervalMs) => setInterval(callback, intervalMs),
        cancel: (handle) => clearInterval(handle as NodeJS.Timeout),
      });
      heartbeat.start();
      this.#heartbeats.set(record.txId, heartbeat);
    }
    catch (error) {
      await this.#leases.release(record.txId, { ownerPid: lease.ownerPid, ownerStartTime: lease.ownerStartTime }).catch(() => undefined);
      throw error;
    }
  }
  async onTerminal(record: OperatorTransactionRecord): Promise<void> {
    const heartbeat = this.#heartbeats.get(record.txId);
    heartbeat?.stop();
    this.#heartbeats.delete(record.txId);
    heartbeat?.assertHealthy();
    const snapshot = await this.#read(record.txId);
    if (!this.#matchesSnapshot(snapshot, record)) throw new Error("M12_RECOVERY_RECORD_RECONCILIATION_REQUIRED");
    const inspection = await this.#leases.inspect(record.txId, snapshot.repositoryIdentity);
    if (inspection === undefined || inspection.owner !== "LIVE" || inspection.expired || !inspection.repositoryMatch) {
      throw new Error("M12_RECOVERY_TERMINAL_RECONCILIATION_REQUIRED");
    }
    await this.#leases.release(record.txId, {
      ownerPid: inspection.lease.ownerPid,
      ownerStartTime: inspection.lease.ownerStartTime,
    });
    await this.#removeSnapshot(snapshot);
  }
  async collectOwnedResidue(): Promise<readonly OperatorTransactionRecord[]> {
    const directory = await this.#directory();
    const names = await readdir(directory);
    const records: OperatorTransactionRecord[] = [];
    for (const name of names.sort()) {
      if (!/^txn_[a-f0-9]{32}\.json$/u.test(name)) throw new Error("M12_RECOVERY_FOREIGN_RESIDUE_RECONCILIATION_REQUIRED");
      const snapshot = await this.#read(name.slice(0, -5));
      records.push(Object.freeze({ ...snapshot.record, intents: Object.freeze([]) }));
    }
    return Object.freeze(records);
  }
  async classificationInput(record: OperatorTransactionRecord): Promise<RecoveryClassificationInput> {
    const snapshot = await this.#read(record.txId);
    if (!this.#matchesSnapshot(snapshot, record)) throw new Error("M12_RECOVERY_RECORD_RECONCILIATION_REQUIRED");
    const lease = await this.#leases.inspect(record.txId, snapshot.repositoryIdentity);
    if (lease === undefined) throw new Error("M12_RECOVERY_LEASE_MISSING");
    let canonicalIdentity: string;
    let worktreeIdentity: string;
    let canonicalHead: string;
    let canonicalStatus: string;
    let worktreeHead: string;
    let worktreeStatus: string;
    try {
      canonicalIdentity = win32.normalize(win32.isAbsolute(await this.#git.commonDir(record.canonicalRoot))
        ? await this.#git.commonDir(record.canonicalRoot)
        : win32.resolve(record.canonicalRoot, await this.#git.commonDir(record.canonicalRoot)));
      worktreeIdentity = win32.normalize(win32.isAbsolute(await this.#git.commonDir(record.worktreePath))
        ? await this.#git.commonDir(record.worktreePath)
        : win32.resolve(record.worktreePath, await this.#git.commonDir(record.worktreePath)));
      [canonicalHead, canonicalStatus, worktreeHead, worktreeStatus] = await Promise.all([
        this.#git.head(record.canonicalRoot), this.#git.status(record.canonicalRoot),
        this.#git.head(record.worktreePath), this.#git.status(record.worktreePath),
      ]);
    } catch {
      return Object.freeze({
        projectId: record.projectId as "operator-canary" | "skill-fabric" | "hermes-os", repositoryIdentity: snapshot.repositoryIdentity, transactionId: record.txId,
        leaseOwner: lease.owner, leaseExpired: lease.expired, repositoryMatch: false, ownership: "AMBIGUOUS",
        transactionState: "AMBIGUOUS", unresolvedEffects: true, foreignGitLock: true,
      });
    }
    const repoMatch = samePath(canonicalIdentity, snapshot.repositoryIdentity)
      && samePath(worktreeIdentity, snapshot.repositoryIdentity) && lease.repositoryMatch;
    const canonicalCurrent = canonicalHead === record.baseHeadSha && canonicalStatus.trim() === "";
    const transactionState = FULL_GIT_SHA.test(worktreeHead)
      ? worktreeHead === record.baseHeadSha && worktreeStatus.trim() === "" ? "CLEAN" : "MUTATED"
      : "AMBIGUOUS";
    return Object.freeze({
      projectId: record.projectId as "operator-canary" | "skill-fabric" | "hermes-os", repositoryIdentity: snapshot.repositoryIdentity, transactionId: record.txId,
      leaseOwner: lease.owner, leaseExpired: lease.expired,
      repositoryMatch: repoMatch && canonicalCurrent,
      ownership: repoMatch && contained(this.#worktreeRoot, record.worktreePath) ? "EXACT" : "AMBIGUOUS",
      transactionState,
      unresolvedEffects: false,
      foreignGitLock: await scanM12CanonicalGitCommonDirForLocks(canonicalIdentity),
    });
  }
  async recoverOwnedTransaction(record: OperatorTransactionRecord): Promise<OperatorTransactionRecoveryDecision> {
    let input: RecoveryClassificationInput;
    try { input = await this.classificationInput(record); }
    catch { return "MANUAL_RECONCILIATION_REQUIRED"; }
    const decision = classifyRecovery(input);
    if (input.leaseOwner !== "LIVE") {
      this.#heartbeats.get(record.txId)?.stop();
      this.#heartbeats.delete(record.txId);
    }
    if (decision !== "SAFE_TO_ROLLBACK") return decision;
    const snapshot = await this.#read(record.txId).catch(() => undefined);
    const lease = await this.#leases.inspect(record.txId, input.repositoryIdentity).catch(() => undefined);
    if (snapshot === undefined || !this.#matchesSnapshot(snapshot, record) || lease === undefined || lease.owner !== "DEAD_OR_REUSED" || !lease.expired || !lease.repositoryMatch) {
      return "MANUAL_RECONCILIATION_REQUIRED";
    }
    try {
      if ((await this.#git.head(record.canonicalRoot)) !== record.baseHeadSha || (await this.#git.status(record.canonicalRoot)).trim() !== "") {
        return "MANUAL_RECONCILIATION_REQUIRED";
      }
      const branch = await readLocalGitCurrentBranch(record.worktreePath);
      if (branch !== record.branchName) return "MANUAL_RECONCILIATION_REQUIRED";
      await this.#git.worktreeRemove(record.canonicalRoot, record.worktreePath);
      await this.#git.deleteBranch(record.canonicalRoot, record.branchName);
      await removeExpiredLeaseExact(this.#stateRoot, lease.lease.hash, record.txId);
      await this.#removeSnapshot(snapshot);
      return "SAFE_TO_ROLLBACK";
    } catch {
      return "MANUAL_RECONCILIATION_REQUIRED";
    }
  }
}

async function removeExpiredLeaseExact(stateRoot: string, expectedHash: string, txId: string): Promise<void> {
  const leasePath = join(resolve(stateRoot), "leases", `${txId}.json`);
  const stat = await lstat(leasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(leasePath), leasePath)) {
    throw new Error("M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED");
  }
  const parsed = JSON.parse(await readFile(leasePath, "utf8")) as { hash?: unknown };
  if (parsed.hash !== expectedHash) throw new Error("M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED");
  await unlink(leasePath);
}

class RuntimeFactsProvider implements M12StabilityFactsProvider {
  readonly #runtime: QualifiedOperatorControlRuntime;
  readonly #recovery: M12RuntimeRecoveryCoordinator;
  readonly #git = new LocalOperatorGit();
  constructor(runtime: QualifiedOperatorControlRuntime, recovery: M12RuntimeRecoveryCoordinator) {
    this.#runtime = runtime; this.#recovery = recovery;
  }
  async inspect(transactionId: string): Promise<M12StabilityFacts | undefined> {
    const status = await this.#runtime.transactions.status(transactionId) as {
      decision: "ALLOW" | "DENY"; transaction?: OperatorTransactionRecord; state?: string;
    };
    if (status.decision !== "ALLOW" || status.transaction === undefined) return undefined;
    const record = status.transaction;
    let canonicalHead = "";
    let canonicalStatus = "";
    let worktreeHead = "";
    let worktreeStatus = "";
    let repositoryIdentity = "";
    let currentness: "CURRENT" | "STALE" | "UNKNOWN" = "UNKNOWN";
    try {
      [canonicalHead, canonicalStatus, worktreeHead, worktreeStatus] = await Promise.all([
        this.#git.head(record.canonicalRoot), this.#git.status(record.canonicalRoot),
        this.#git.head(record.worktreePath), this.#git.status(record.worktreePath),
      ]);
      const common = await this.#git.commonDir(record.canonicalRoot);
      repositoryIdentity = win32.normalize(win32.isAbsolute(common) ? common : win32.resolve(record.canonicalRoot, common));
      currentness = canonicalHead === record.baseHeadSha && canonicalStatus.trim() === "" ? "CURRENT" : "STALE";
    } catch { currentness = "UNKNOWN"; }
    let recovery: RecoveryClassificationInput;
    try { recovery = await this.#recovery.classificationInput(record); }
    catch {
      recovery = Object.freeze({
        projectId: record.projectId as "operator-canary" | "skill-fabric" | "hermes-os", repositoryIdentity: repositoryIdentity || "UNKNOWN", transactionId,
        leaseOwner: "UNKNOWN", leaseExpired: false, repositoryMatch: false, ownership: "AMBIGUOUS",
        transactionState: "AMBIGUOUS", unresolvedEffects: true, foreignGitLock: true,
      });
    }
    const invariantValue = sha256({ state: status.state ?? record.state, canonicalHead, canonicalStatus, worktreeHead, worktreeStatus });
    return Object.freeze({
      projectId: record.projectId as "operator-canary" | "skill-fabric" | "hermes-os", repositoryIdentity: recovery.repositoryIdentity, baseHeadSha: record.baseHeadSha,
      authority: this.#recovery.projectAllowed(record.projectId) ? "AUTHORIZED" : "DENIED",
      currentness, emergency: "NONE",
      invariant: Object.freeze({ name: "transaction-state-digest", value: invariantValue }),
      recovery,
    });
  }
}

async function assertStatePaths(config: Pick<FinalB5OperatorCompositionConfig, "stateRoot" | "worktreeRoot">): Promise<void> {
  await mkdir(config.stateRoot, { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  const stateReal = await realpath(config.stateRoot);
  const worktreeReal = await realpath(config.worktreeRoot);
  if (!samePath(stateReal, config.stateRoot) || !samePath(worktreeReal, config.worktreeRoot) || !contained(stateReal, worktreeReal)) {
    throw new Error("M12_ACTIVE_CANARY_STATE_PATH_RECONCILIATION_REQUIRED");
  }
}
export interface FinalB5OperatorCompositionConfig {
  readonly worktreeRoot: string;
  readonly stateRoot: string;
  readonly allowedProjects: Readonly<Partial<Record<"operator-canary" | "skill-fabric" | "hermes-os", string>>>;
}

async function createM12Operator(
  config: FinalB5OperatorCompositionConfig,
  recoveryOptions: Omit<M12RecoveryRuntimeConfig, "stateRoot" | "worktreeRoot"> = {},
): Promise<M12ActiveCanaryOperatorRuntime> {
  await assertStatePaths(config);
  const paths = runtimeIdentityPaths();
  const recovery = new M12RuntimeRecoveryCoordinator({
    stateRoot: config.stateRoot, worktreeRoot: config.worktreeRoot, allowedProjectIds: Object.keys(config.allowedProjects) as ("operator-canary" | "skill-fabric" | "hermes-os")[], ...recoveryOptions,
  });
  const base = await createQualifiedOperatorControlRuntime({
    worktreeRoot: config.worktreeRoot, allowedProjects: config.allowedProjects,
    registryPath: paths.registryPath, effectPolicyPath: paths.effectPolicyPath, recovery,
  });
  const remediation = new RemediationController(new RemediationStore(config.stateRoot));
  const facts = new RuntimeFactsProvider(base, recovery);
  const coordinator = new M12StabilityCoordinator({ remediation, facts, recovery });
  const startup = await coordinator.recoverStartup();
  if (startup.some((entry) => entry.classification !== "SAFE_TO_ROLLBACK")) {
    throw new Error("M12_ACTIVE_CANARY_RECOVERY_RECONCILIATION_REQUIRED");
  }
  const runtime: M12ActiveCanaryOperatorRuntime = Object.freeze({
    ...createOperatorControlRuntime({
      transactions: base.transactions,
      tasks: createM12StabilityTaskApi(base.tasks, coordinator),
      registry: base.registry,
      effects: base.effects,
    }),
    attestation: M08_QUALIFIED_RUNTIME_IDENTITY,
  });
  M12_CORE_RUNTIMES.add(runtime);
  return runtime;
}

export function createM12ActiveCanaryReadinessMetadata(config: unknown): M12ActiveCanaryReadinessMetadata {
  validateM12ActiveCanaryConfig(config);
  return Object.freeze({
    host: "127.0.0.1", port: 8769, mode: "ACTIVE", protocolMode: "operator13",
    activationScope: "M12_B5_CANARY_STABILITY_ONLY",
    projectIds: Object.freeze(["operator-canary"] as const),
    runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile,
    registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
    effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
    s2Enabled: false, genericExec: false, genericShell: false, destructive: "LOCKED",
    remediationBudget: 5, cleanStateReplanLimit: 1,
  });
}
export async function createM12ActiveCanaryOperatorRuntime(config: unknown): Promise<M12ActiveCanaryOperatorRuntime> {
  return createM12Operator(validateM12ActiveCanaryConfig(config));
}
/** Internal final-B5 composition seam used by the strictly closed B6 successor only. */
export async function createFinalB5OperatorRuntime(config: FinalB5OperatorCompositionConfig): Promise<M12ActiveCanaryOperatorRuntime> {
  const ids = Object.keys(config.allowedProjects);
  if (ids.length === 0 || ids.some((id) => id !== "operator-canary" && id !== "skill-fabric" && id !== "hermes-os")) {
    throw new Error("M12_FINAL_B5_PROJECT_POLICY_DENIED");
  }
  return createM12Operator(config);
}
export function isM12ActiveCanaryOperatorRuntime(value: unknown): value is M12ActiveCanaryOperatorRuntime {
  return typeof value === "object" && value !== null && M12_CORE_RUNTIMES.has(value as object);
}

const M12_DISPOSABLE_B5_MARKER = "HAIOS_M12_DISPOSABLE_B5_FIXTURE_R1\n";
const M12_DISPOSABLE_B5_RECOVERY_TTL_MS = 300_001;

export interface M12DisposableB5FixtureRuntime {
  readonly runtime: M12ActiveCanaryOperatorRuntime;
  readonly inspectFixtureResidue: () => Readonly<{
    readonly ownedProcesses: number;
    readonly ownedContainers: number;
    readonly ownedNetworks: number;
    readonly completedFixedNodeTasks: number;
  }>;
  /** Fixture-only crash/restart recovery; it never accepts a caller-selected transaction or path. */
  recoverAfterSimulatedOwnerDeath(): Promise<readonly { readonly transactionId: string; readonly classification: string }[]>;
  /** Fixture-only sealed transition: accepts the sole pending replan using inspected facts and applies its fixed correction. */
  acceptPendingRemediationReplanAndApplyCorrection(): Promise<Readonly<{ readonly accepted: boolean; readonly episodeId: string; readonly transactionId: string }>>;
  /** Fixture-only controller/store exercise with fixed observations and no caller-selected remediation facts. */
  measureRemediationNegativeTerminals(): Promise<Readonly<{
    readonly stagnation: Readonly<{ readonly directive: string; readonly durable: boolean }>;
    readonly budget: Readonly<{ readonly directive: string; readonly durable: boolean }>;
  }>>;
}

interface M12DisposableB5FixtureConfig {
  readonly fixtureRoot: string;
  readonly canonicalRoot: string;
}

function disposableFixtureDeny(): never {
  throw new Error("M12_DISPOSABLE_B5_FIXTURE_DENIED");
}

function disposableFixtureData(value: unknown): M12DisposableB5FixtureConfig {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) disposableFixtureDeny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || keys.some((key) => key !== "fixtureRoot" && key !== "canonicalRoot")) disposableFixtureDeny();
  for (const key of ["fixtureRoot", "canonicalRoot"] as const) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") disposableFixtureDeny();
  }
  return Object.freeze({
    fixtureRoot: (descriptors.fixtureRoot!.value as string),
    canonicalRoot: (descriptors.canonicalRoot!.value as string),
  });
}

function isProtectedCanaryPath(candidate: string): boolean {
  return samePath(candidate, M12_ACTIVE_CANARY_PROJECT_ROOT)
    || contained(M12_ACTIVE_CANARY_PROJECT_ROOT, candidate);
}

class DisposableFixtureProcessProbe implements M12RuntimeProcessProbe {
  #alive = true;
  readonly #startTime = "2026-08-30T00:00:00.000Z";
  async inspect(pid: number): Promise<{ readonly alive: boolean; readonly startTime: string } | undefined> {
    return pid === 4242 ? Object.freeze({ alive: this.#alive, startTime: this.#startTime }) : undefined;
  }
  async current(): Promise<{ readonly ownerPid: number; readonly ownerStartTime: string }> {
    if (!this.#alive) throw new Error("M12_DISPOSABLE_B5_FIXTURE_OWNER_DEAD");
    return Object.freeze({ ownerPid: 4242, ownerStartTime: this.#startTime });
  }
  simulateDeath(): void { this.#alive = false; }
}

/** A fixture-only S0 adapter: immutable repository runner, no worktree code execution. */
class DisposableB5FixedRunnerSandbox {
  readonly #worktreeRoot: string;
  readonly #runnerPath: string;
  #ownedProcesses = 0;
  #completedFixedNodeTasks = 0;
  constructor(worktreeRoot: string, runnerPath: string) {
    this.#worktreeRoot = worktreeRoot;
    this.#runnerPath = runnerPath;
  }
  inspectFixtureResidue(): Readonly<{
    readonly ownedProcesses: number;
    readonly ownedContainers: number;
    readonly ownedNetworks: number;
    readonly completedFixedNodeTasks: number;
  }> {
    return Object.freeze({ ownedProcesses: this.#ownedProcesses, ownedContainers: 0, ownedNetworks: 0,
      completedFixedNodeTasks: this.#completedFixedNodeTasks });
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const deny = (reason: string): SandboxExecutionResult => Object.freeze({ decision: "DENY", reason,
      stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, timedOut: false,
      stdoutTruncated: false, stderrTruncated: false, cleanupVerified: true, durationMs: Date.now() - startedAt });
    const execution = request.execution;
    if (execution.taskId !== "project.test" || execution.executable !== "npm"
      || execution.argv.length !== 1 || execution.argv[0] !== "test" || execution.sandboxProfile !== "S0"
      || execution.networkAuthority !== "NONE" || !samePath(request.worktreePath, execution.worktreePath)
      || !contained(this.#worktreeRoot, request.worktreePath)
      || Object.keys(request.safeEnvironment).some((key) => key !== "CI")) return deny("M12_DISPOSABLE_B5_FIXED_RUNNER_DENIED");
    const statePath = join(request.worktreePath, "fixture-state.json");
    const artifactPath = join(request.worktreePath, "coverage", "qualification-artifact.txt");
    this.#ownedProcesses += 1;
    let outcome: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
    try {
      outcome = await new Promise((resolveOutcome, rejectOutcome) => execFile(process.execPath,
        [this.#runnerPath, statePath, artifactPath], { cwd: request.worktreePath, windowsHide: true,
          encoding: "utf8", env: { CI: request.safeEnvironment.CI ?? "1" } }, (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== "number") rejectOutcome(error);
          else resolveOutcome(Object.freeze({ exitCode: error === null ? 0 : error.code as number,
            stdout: String(stdout), stderr: String(stderr) }));
        }));
    } catch { return deny("M12_DISPOSABLE_B5_FIXED_RUNNER_FAILED"); }
    finally { this.#ownedProcesses -= 1; this.#completedFixedNodeTasks += 1; }

    const stdoutBytes = Buffer.byteLength(outcome.stdout, "utf8");
    const stderrBytes = Buffer.byteLength(outcome.stderr, "utf8");
    const base = Object.freeze({ stdout: outcome.stdout, stderr: outcome.stderr, stdoutBytes, stderrBytes,
      timedOut: false, stdoutTruncated: false, stderrTruncated: false, cleanupVerified: true,
      durationMs: Date.now() - startedAt });
    return outcome.exitCode === 0
      ? Object.freeze({ decision: "ALLOW" as const, exitCode: 0, ...base })
      : Object.freeze({ decision: "DENY" as const, reason: "SANDBOX_EXIT_NONZERO", exitCode: outcome.exitCode, ...base });
  }
}


/**
 * Strictly fixture-contained M12 construction for Task 8 qualification. This does not mint
 * general provenance: it accepts only the marker-backed canonical child of one disposable root.
 */
export async function createM12DisposableB5FixtureRuntime(value: unknown): Promise<M12DisposableB5FixtureRuntime> {
  const input = disposableFixtureData(value);
  const fixtureRoot = resolve(input.fixtureRoot);
  const canonicalRoot = resolve(input.canonicalRoot);
  const paths = runtimeIdentityPaths();
  const fixtureBase = join(paths.root, "runtime", "m12-disposable-b5");
  if (!samePath(dirname(fixtureRoot), fixtureBase)
    || isProtectedCanaryPath(fixtureRoot) || isProtectedCanaryPath(canonicalRoot)
    || !samePath(canonicalRoot, join(fixtureRoot, "canonical"))) disposableFixtureDeny();
  const [fixtureReal, canonicalReal, marker] = await Promise.all([
    realpath(fixtureRoot).catch(disposableFixtureDeny),
    realpath(canonicalRoot).catch(disposableFixtureDeny),
    readFile(join(fixtureRoot, ".m12-disposable-b5.fixture"), "utf8").catch(disposableFixtureDeny),
  ]);
  if (!samePath(fixtureReal, fixtureRoot) || !samePath(canonicalReal, canonicalRoot)
    || !contained(fixtureReal, canonicalReal) || marker !== M12_DISPOSABLE_B5_MARKER) disposableFixtureDeny();

  const stateRoot = join(fixtureReal, "m12-state");
  const worktreeRoot = join(stateRoot, "worktrees");
  let now = Date.parse("2026-08-30T00:00:00.000Z");
  const probe = new DisposableFixtureProcessProbe();
  const recovery = new M12RuntimeRecoveryCoordinator({ stateRoot, worktreeRoot, probe, now: () => now });
  await assertStatePaths({ stateRoot, worktreeRoot });
  const [registry, effects] = await Promise.all([
    loadTaskRegistryV2(paths.registryPath), loadTaskEffectPolicy(paths.effectPolicyPath),
  ]);
  if (registry.sha256 !== M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256
    || effects.sha256 !== M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256) {
    throw new Error("M12_DISPOSABLE_B5_QUALIFIED_IDENTITY_MISMATCH");
  }
  const git = new LocalOperatorGit();
  const service = new OperatorTransactionService({
    worktreeRoot, allowedProjects: Object.freeze({ "operator-canary": canonicalReal }), git, recovery,
    readCurrentWorktreeBranch: readLocalGitCurrentBranch,
  });
  const runnerPath = join(paths.root, "scripts", "m12-disposable-b5-fixed-runner.mjs");
  const runnerReal = await realpath(runnerPath).catch(disposableFixtureDeny);
  if (!samePath(runnerReal, runnerPath) || contained(worktreeRoot, runnerReal) || contained(fixtureReal, runnerReal)) disposableFixtureDeny();
  const directSandbox = new DisposableB5FixedRunnerSandbox(worktreeRoot, runnerReal);
  const tasks = new OperatorTaskRunner({
    transactions: service, git, registry, effects,
    qualifiedEffectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
    sandbox: directSandbox,
    safeEnvironment: Object.freeze({ CI: "1" }),
  });
  const transactions = Object.freeze({
    begin: service.begin.bind(service), stagePatch: service.stagePatch.bind(service),
    stageCreate: service.stageCreate.bind(service), stageMove: service.stageMove.bind(service),
    stageRemove: service.stageRemove.bind(service), validate: service.validate.bind(service),
    apply: service.apply.bind(service), rollback: service.rollback.bind(service), checkpoint: service.checkpoint.bind(service),
    promote: service.promote.bind(service),
    status: service.status.bind(service),
  });
  const base = Object.freeze({
    ...createOperatorControlRuntime({
      transactions, tasks: Object.freeze({ run: tasks.run.bind(tasks) }), registry, effects,
    }),
    attestation: M08_QUALIFIED_RUNTIME_IDENTITY,
  }) as QualifiedOperatorControlRuntime;
  const remediationStore = new RemediationStore(stateRoot);
  const remediation = new RemediationController(remediationStore);
  const facts = new RuntimeFactsProvider(base, recovery);
  const coordinator = new M12StabilityCoordinator({
    remediation, facts, recovery,
  });
  const stabilityTasks = createM12StabilityTaskApi(base.tasks, coordinator);
  let latestRemediationTask: Awaited<ReturnType<typeof stabilityTasks.run>> | undefined;
  let latestRemediationRequest: { readonly txId: string; readonly taskId: string } | undefined;
  const runtime: M12ActiveCanaryOperatorRuntime = Object.freeze({
    ...createOperatorControlRuntime({
      transactions: base.transactions,
      tasks: Object.freeze({
        run: async (request: OperatorTaskRunRequest) => {
          const result = await stabilityTasks.run(request);
          latestRemediationTask = result;
          latestRemediationRequest = Object.freeze({ txId: request.txId, taskId: request.taskId });
          return result;
        },
      }),
      registry: base.registry, effects: base.effects,
    }),
    attestation: M08_QUALIFIED_RUNTIME_IDENTITY,
  });
  M12_CORE_RUNTIMES.add(runtime);
  return Object.freeze({
    runtime,
    inspectFixtureResidue: () => directSandbox.inspectFixtureResidue(),
    recoverAfterSimulatedOwnerDeath: async () => {
      probe.simulateDeath();
      now += M12_DISPOSABLE_B5_RECOVERY_TTL_MS;
      return coordinator.recoverStartup();
    },
    acceptPendingRemediationReplanAndApplyCorrection: async () => {
      const task = latestRemediationTask;
      const request = latestRemediationRequest;
      if (task === undefined || request === undefined || task.stability.directive !== "REPLAN_REQUIRED") disposableFixtureDeny();
      const currentFacts = await facts.inspect(request.txId);
      const activeMutableCodeProcess = directSandbox.inspectFixtureResidue().ownedProcesses !== 0;
      const unresolvedTaskEffects = currentFacts?.recovery.unresolvedEffects ?? true;
      const ownership = currentFacts?.recovery.ownership === "EXACT" ? "UNAMBIGUOUS" as const : "AMBIGUOUS" as const;
      const recoveryClassification = currentFacts === undefined ? undefined : classifyRecovery(currentFacts.recovery);
      if (currentFacts === undefined || activeMutableCodeProcess
        || currentFacts.recovery.ownership !== "EXACT"
        || unresolvedTaskEffects || currentFacts.currentness !== "CURRENT" || recoveryClassification !== "SAFE_TO_CONTINUE") disposableFixtureDeny();
      const episodeId = `episode-${createHash("sha256").update(`${request.txId}|${request.taskId}`, "utf8").digest("hex").slice(0, 32)}`;
      const accepted = await remediation.acceptCleanStateReplan(episodeId, {
        activeMutableCodeProcess, unresolvedTaskEffects, ownership, recovery: recoveryClassification,
      });
      const transaction = await service.status(request.txId);
      if (transaction.decision !== "ALLOW" || transaction.transaction === undefined || transaction.state !== "APPLIED") disposableFixtureDeny();
      const statePath = join(transaction.transaction.worktreePath, "fixture-state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      if (state.schema !== "HAIOS_M12_DISPOSABLE_B5_STATE_R1" || state.ready !== "broken"
        || !Number.isSafeInteger(state.revision)) disposableFixtureDeny();
      const corrected = Object.freeze({ ...state, ready: "ready", revision: Number(state.revision) + 1 });
      await writeFile(statePath, `${JSON.stringify(corrected, null, 2)}\n`, "utf8");
      return Object.freeze({ accepted: accepted.replanUsed, episodeId, transactionId: request.txId });
    },
    measureRemediationNegativeTerminals: async () => {
      const baseHeadSha = await git.head(canonicalReal);
      const observation = (episodeId: string, transactionId: string, coarse: string, fine: string) => Object.freeze({
        episodeId, projectId: "operator-canary" as const, repositoryIdentity: canonicalReal, transactionId, baseHeadSha,
        failure: "REMEDIATION_ELIGIBLE_FAILURE" as const, fingerprint: Object.freeze({ coarse, fine }),
        invariant: Object.freeze({ name: "FIXTURE_STATE", value: "UNCHANGED" }), authority: "AUTHORIZED" as const,
        currentness: "CURRENT" as const, emergency: "NONE" as const, recovery: "SAFE_TO_CONTINUE" as const,
      });
      const stagnationEpisode = "fixture-stagnation";
      const stagnationObservation = observation(stagnationEpisode, "txn_fixture_stagnation", "a".repeat(64), "b".repeat(64));
      await remediation.record(stagnationObservation);
      await remediation.record(stagnationObservation);
      await remediation.acceptCleanStateReplan(stagnationEpisode, {
        activeMutableCodeProcess: false, unresolvedTaskEffects: false, ownership: "UNAMBIGUOUS", recovery: "SAFE_TO_CONTINUE",
      });
      const stagnation = await remediation.record(stagnationObservation);
      const stagnationStored = await remediationStore.load(stagnationEpisode);
      const budgetEpisode = "fixture-budget";
      let budget = await remediation.record(observation(budgetEpisode, "txn_fixture_budget", "c".repeat(64), "d".repeat(64)));
      for (const coarse of ["e", "f", "0", "1"]) {
        budget = await remediation.record(observation(budgetEpisode, "txn_fixture_budget", coarse.repeat(64), "d".repeat(64)));
      }
      const budgetStored = await remediationStore.load(budgetEpisode);
      return Object.freeze({
        stagnation: Object.freeze({ directive: stagnation.directive, durable: stagnationStored?.attempt === 3 && stagnationStored.replanUsed }),
        budget: Object.freeze({ directive: budget.directive, durable: budgetStored?.attempt === 5 && !budgetStored.replanUsed }),
      });
    },
  });
}
