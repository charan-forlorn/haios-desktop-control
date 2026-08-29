import { createHash, randomBytes } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";

export const M12_RECOVERY_LEASE_DENIED = "M12_RECOVERY_LEASE_DENIED" as const;
export const M12_RECOVERY_LEASE_CONFLICT = "M12_RECOVERY_LEASE_CONFLICT" as const;
export const M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED = "M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED" as const;
export const RECOVERY_LEASE_SCHEMA = "HAIOS_M12_RECOVERY_LEASE_R1" as const;
export const M12_RUNTIME_IDENTITY = "HAIOS_M12_OPERATOR_RUNTIME_R1" as const;

export interface ProcessIdentityProbe {
  inspect(pid: number): Promise<{ readonly alive: boolean; readonly startTime: string } | undefined>;
}

export interface RecoveryLeaseRequest {
  readonly projectId: "operator-canary";
  readonly repositoryIdentity: string;
  readonly transactionId: string;
  readonly ownerPid: number;
  readonly ownerStartTime: string;
  readonly ttlMs: number;
}

export interface RecoveryLeaseRecord extends RecoveryLeaseRequest {
  readonly schema: typeof RECOVERY_LEASE_SCHEMA;
  readonly runtimeIdentity: typeof M12_RUNTIME_IDENTITY;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly hash: string;
}
export interface RecoveryLeaseInspection {
  readonly lease: RecoveryLeaseRecord;
  readonly owner: "LIVE" | "DEAD_OR_REUSED" | "UNKNOWN";
  readonly expired: boolean;
  readonly repositoryMatch: boolean;
}

export interface RecoveryLeaseManagerConfig {
  readonly stateRoot: string;
  readonly processProbe: ProcessIdentityProbe;
  readonly now?: () => number;
}

type Json = string | number | boolean | null | { readonly [key: string]: Json };
const TX = /^txn_[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function deny(code: string): never { throw new Error(code); }
function samePath(a: string, b: string): boolean {
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
}
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
function sha256(value: Json): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function validateRequest(input: RecoveryLeaseRequest): RecoveryLeaseRequest {
  if (input.projectId !== "operator-canary" || !TX.test(input.transactionId)) return deny(M12_RECOVERY_LEASE_DENIED);
  if (typeof input.repositoryIdentity !== "string" || input.repositoryIdentity.length === 0 || input.repositoryIdentity.length > 4096) {
    return deny(M12_RECOVERY_LEASE_DENIED);
  }
  if (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0) return deny(M12_RECOVERY_LEASE_DENIED);
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 300_000) return deny(M12_RECOVERY_LEASE_DENIED);
  if (typeof input.ownerStartTime !== "string" || !Number.isFinite(Date.parse(input.ownerStartTime))) return deny(M12_RECOVERY_LEASE_DENIED);
  return Object.freeze({ ...input });
}

function unsigned(record: Omit<RecoveryLeaseRecord, "hash">): Json {
  return {
    schema: record.schema, runtimeIdentity: record.runtimeIdentity, projectId: record.projectId,
    repositoryIdentity: record.repositoryIdentity, transactionId: record.transactionId,
    ownerPid: record.ownerPid, ownerStartTime: record.ownerStartTime, ttlMs: record.ttlMs,
    acquiredAt: record.acquiredAt, heartbeatAt: record.heartbeatAt, expiresAt: record.expiresAt,
  };
}
function withHash(record: Omit<RecoveryLeaseRecord, "hash">): RecoveryLeaseRecord {
  return Object.freeze({ ...record, hash: sha256(unsigned(record)) });
}
function recordJson(record: RecoveryLeaseRecord): string {
  return canonical({ ...(unsigned(record) as Record<string, Json>), hash: record.hash });
}
function parseRecord(text: string): RecoveryLeaseRecord {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
  const v = value as Record<string, unknown>;
  const expected = ["schema", "runtimeIdentity", "projectId", "repositoryIdentity", "transactionId", "ownerPid", "ownerStartTime", "ttlMs", "acquiredAt", "heartbeatAt", "expiresAt", "hash"];
  if (Object.keys(v).length !== expected.length || expected.some((key) => !(key in v))) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
  if (v.schema !== RECOVERY_LEASE_SCHEMA || v.runtimeIdentity !== M12_RUNTIME_IDENTITY || v.projectId !== "operator-canary") {
    return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
  }
  let request: RecoveryLeaseRequest;
  try {
    request = validateRequest({
      projectId: "operator-canary", repositoryIdentity: v.repositoryIdentity as string,
      transactionId: v.transactionId as string, ownerPid: v.ownerPid as number,
      ownerStartTime: v.ownerStartTime as string, ttlMs: v.ttlMs as number,
    });
  } catch { return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED); }
  for (const key of ["acquiredAt", "heartbeatAt", "expiresAt"] as const) {
    if (typeof v[key] !== "string" || !Number.isFinite(Date.parse(v[key] as string))) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
  }
  if (typeof v.hash !== "string" || !HASH.test(v.hash)) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
  const record = { ...request, schema: RECOVERY_LEASE_SCHEMA, runtimeIdentity: M12_RUNTIME_IDENTITY,
    acquiredAt: v.acquiredAt as string, heartbeatAt: v.heartbeatAt as string, expiresAt: v.expiresAt as string };
  if (v.hash !== sha256(unsigned(record))) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
  return Object.freeze({ ...record, hash: v.hash });
}
export class RecoveryLeaseManager {
  readonly #stateRoot: string;
  readonly #processProbe: ProcessIdentityProbe;
  readonly #now: () => number;

  constructor(config: RecoveryLeaseManagerConfig) {
    if (typeof config.stateRoot !== "string" || config.stateRoot.length === 0) deny(M12_RECOVERY_LEASE_DENIED);
    this.#stateRoot = resolve(config.stateRoot);
    this.#processProbe = config.processProbe;
    this.#now = config.now ?? (() => Date.now());
  }

  async #directory(): Promise<string> {
    const root = await realpath(this.#stateRoot);
    const path = join(root, "leases");
    try { await mkdir(path, { recursive: false }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
    const actual = await realpath(path);
    if (!samePath(actual, path)) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
    return actual;
  }

  async #path(transactionId: string): Promise<string> {
    if (!TX.test(transactionId)) return deny(M12_RECOVERY_LEASE_DENIED);
    return join(await this.#directory(), `${transactionId}.json`);
  }

  async #read(transactionId: string): Promise<RecoveryLeaseRecord | undefined> {
    const path = await this.#path(transactionId);
    try { return parseRecord(await readFile(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async acquire(input: RecoveryLeaseRequest): Promise<RecoveryLeaseRecord> {
    const request = validateRequest(input);
    let owner: Awaited<ReturnType<ProcessIdentityProbe["inspect"]>>;
    try { owner = await this.#processProbe.inspect(request.ownerPid); } catch { owner = undefined; }
    if (owner === undefined || !owner.alive || owner.startTime !== request.ownerStartTime) return deny(M12_RECOVERY_LEASE_DENIED);
    const now = this.#now();
    const timestamp = new Date(now).toISOString();
    const record = withHash({ ...request, schema: RECOVERY_LEASE_SCHEMA, runtimeIdentity: M12_RUNTIME_IDENTITY,
      acquiredAt: timestamp, heartbeatAt: timestamp, expiresAt: new Date(now + request.ttlMs).toISOString() });
    const path = await this.#path(request.transactionId);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(recordJson(record), "utf8");
      await handle.sync();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return deny(M12_RECOVERY_LEASE_CONFLICT);
      throw error;
    } finally { await handle?.close().catch(() => undefined); }
  }

  async inspect(transactionId: string, expectedRepositoryIdentity?: string): Promise<RecoveryLeaseInspection | undefined> {
    const lease = await this.#read(transactionId);
    if (lease === undefined) return undefined;
    let process: Awaited<ReturnType<ProcessIdentityProbe["inspect"]>>;
    try { process = await this.#processProbe.inspect(lease.ownerPid); } catch { process = undefined; }
    const owner = process === undefined ? "UNKNOWN"
      : process.alive && process.startTime === lease.ownerStartTime ? "LIVE" : "DEAD_OR_REUSED";
    return Object.freeze({
      lease,
      owner,
      expired: this.#now() >= Date.parse(lease.expiresAt),
      repositoryMatch: expectedRepositoryIdentity === undefined || samePath(lease.repositoryIdentity, expectedRepositoryIdentity),
    });
  }

  async #replaceExact(path: string, expectedText: string, nextText: string): Promise<void> {
    const temp = join(await this.#directory(), `.m12-lease-${randomBytes(18).toString("hex")}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(nextText, "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      if (await readFile(path, "utf8") !== expectedText) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
      await rename(temp, path);
      if (await readFile(path, "utf8") !== nextText) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  }

  async heartbeat(transactionId: string, owner: { readonly ownerPid: number; readonly ownerStartTime: string }): Promise<RecoveryLeaseRecord> {
    const path = await this.#path(transactionId);
    const currentText = await readFile(path, "utf8").catch(() => deny(M12_RECOVERY_LEASE_DENIED));
    const current = parseRecord(currentText);
    if (current.ownerPid !== owner.ownerPid || current.ownerStartTime !== owner.ownerStartTime) return deny(M12_RECOVERY_LEASE_DENIED);
    const inspection = await this.inspect(transactionId, current.repositoryIdentity);
    if (inspection === undefined || inspection.owner !== "LIVE" || inspection.expired || !inspection.repositoryMatch) {
      return deny(M12_RECOVERY_LEASE_DENIED);
    }
    const now = this.#now();
    const next = withHash({ ...current, heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + current.ttlMs).toISOString() });
    await this.#replaceExact(path, currentText, recordJson(next));
    return next;
  }

  async release(transactionId: string, owner: { readonly ownerPid: number; readonly ownerStartTime: string }): Promise<void> {
    const path = await this.#path(transactionId);
    const text = await readFile(path, "utf8").catch(() => deny(M12_RECOVERY_LEASE_DENIED));
    const current = parseRecord(text);
    if (current.ownerPid !== owner.ownerPid || current.ownerStartTime !== owner.ownerStartTime) return deny(M12_RECOVERY_LEASE_DENIED);
    let process: Awaited<ReturnType<ProcessIdentityProbe["inspect"]>>;
    try { process = await this.#processProbe.inspect(current.ownerPid); } catch { process = undefined; }
    if (process === undefined || !process.alive || process.startTime !== current.ownerStartTime) return deny(M12_RECOVERY_LEASE_DENIED);
    if (await readFile(path, "utf8") !== text) return deny(M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED);
    await unlink(path);
  }
}
