import { createHash, randomBytes } from "node:crypto";
import { open, lstat, mkdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const REMEDIATION_EPISODE_SCHEMA = "HAIOS_M12_REMEDIATION_EPISODE_R1" as const;
export const M12_REMEDIATION_STATE_DENIED = "M12_REMEDIATION_STATE_DENIED" as const;
export const M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED = "M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED" as const;

export type RemediationRecovery = "SAFE_TO_CONTINUE" | "SAFE_TO_ROLLBACK" | "MANUAL_RECONCILIATION_REQUIRED";

export interface RemediationEpisodeSnapshot {
  readonly schema: typeof REMEDIATION_EPISODE_SCHEMA;
  readonly episodeId: string;
  readonly projectId: "operator-canary";
  readonly repositoryIdentity: string;
  readonly transactionId: string;
  readonly baseHeadSha: string;
  readonly attempt: number;
  readonly replanUsed: boolean;
  readonly coarseFingerprint: string;
  readonly fineFingerprint: string;
  readonly progressFact: string;
  readonly recovery: RemediationRecovery;
}

export interface RemediationEpisodeRecord extends RemediationEpisodeSnapshot {
  readonly hash: string;
}

type JsonValue = string | number | boolean | null | { readonly [key: string]: JsonValue };

const SNAPSHOT_FIELDS = new Set([
  "schema",
  "episodeId",
  "projectId",
  "repositoryIdentity",
  "transactionId",
  "baseHeadSha",
  "attempt",
  "replanUsed",
  "coarseFingerprint",
  "fineFingerprint",
  "progressFact",
  "recovery",
]);
const RECORD_FIELDS = new Set([...SNAPSHOT_FIELDS, "hash"]);
const RECOVERY_VALUES = new Set<RemediationRecovery>([
  "SAFE_TO_CONTINUE",
  "SAFE_TO_ROLLBACK",
  "MANUAL_RECONCILIATION_REQUIRED",
]);

function deny(code: string): never {
  throw new Error(code);
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  errorCode: string,
): ReadonlyMap<string, unknown> {
  if (!isPlainDataObject(value)) return deny(errorCode);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return deny(errorCode);
  }
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return deny(errorCode);

  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") return deny(errorCode);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return deny(errorCode);
    }
    if (descriptor === undefined || !("value" in descriptor)) return deny(errorCode);
    fields.set(key, descriptor.value);
  }
  for (const key of required) if (!fields.has(key)) return deny(errorCode);
  return fields;
}

function identifier(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) return deny(errorCode);
  return value;
}

function repositoryIdentity(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) {
    return deny(errorCode);
  }
  return value;
}

function sha(value: unknown, length: 40 | 64, errorCode: string): string {
  const pattern = length === 40 ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  if (typeof value !== "string" || !pattern.test(value)) return deny(errorCode);
  return value;
}

function headSha(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) return deny(errorCode);
  return value;
}

function attempt(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 5) return deny(errorCode);
  return value;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function payloadHash(snapshot: RemediationEpisodeSnapshot): string {
  return createHash("sha256").update(canonicalJson({
    schema: snapshot.schema,
    episodeId: snapshot.episodeId,
    projectId: snapshot.projectId,
    repositoryIdentity: snapshot.repositoryIdentity,
    transactionId: snapshot.transactionId,
    baseHeadSha: snapshot.baseHeadSha,
    attempt: snapshot.attempt,
    replanUsed: snapshot.replanUsed,
    coarseFingerprint: snapshot.coarseFingerprint,
    fineFingerprint: snapshot.fineFingerprint,
    progressFact: snapshot.progressFact,
    recovery: snapshot.recovery,
  }), "utf8").digest("hex");
}

function snapshotFromFields(fields: ReadonlyMap<string, unknown>, errorCode: string): RemediationEpisodeSnapshot {
  const schema = fields.get("schema");
  if (schema !== REMEDIATION_EPISODE_SCHEMA) return deny(errorCode);
  const projectId = fields.get("projectId");
  if (projectId !== "operator-canary") return deny(errorCode);
  const replanUsed = fields.get("replanUsed");
  if (typeof replanUsed !== "boolean") return deny(errorCode);
  const recovery = fields.get("recovery");
  if (typeof recovery !== "string" || !RECOVERY_VALUES.has(recovery as RemediationRecovery)) return deny(errorCode);

  return Object.freeze({
    schema: REMEDIATION_EPISODE_SCHEMA,
    episodeId: identifier(fields.get("episodeId"), errorCode),
    projectId: "operator-canary" as const,
    repositoryIdentity: repositoryIdentity(fields.get("repositoryIdentity"), errorCode),
    transactionId: identifier(fields.get("transactionId"), errorCode),
    baseHeadSha: headSha(fields.get("baseHeadSha"), errorCode),
    attempt: attempt(fields.get("attempt"), errorCode),
    replanUsed,
    coarseFingerprint: sha(fields.get("coarseFingerprint"), 64, errorCode),
    fineFingerprint: sha(fields.get("fineFingerprint"), 64, errorCode),
    progressFact: identifier(fields.get("progressFact"), errorCode),
    recovery: recovery as RemediationRecovery,
  });
}

function normalizeSnapshot(value: unknown, errorCode: string): RemediationEpisodeSnapshot {
  const fields = ownDataFields(value, RECORD_FIELDS, SNAPSHOT_FIELDS, errorCode);
  if (fields.has("hash")) sha(fields.get("hash"), 64, errorCode);
  return snapshotFromFields(fields, errorCode);
}

function normalizeRecord(value: unknown, errorCode: string): RemediationEpisodeRecord {
  const fields = ownDataFields(value, RECORD_FIELDS, RECORD_FIELDS, errorCode);
  const snapshot = snapshotFromFields(fields, errorCode);
  const hash = sha(fields.get("hash"), 64, errorCode);
  if (hash !== payloadHash(snapshot)) return deny(errorCode);
  return Object.freeze({ ...snapshot, hash });
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function containedBy(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class RemediationStore {
  readonly #configuredStateRoot: string;

  constructor(stateRoot: string) {
    if (typeof stateRoot !== "string" || stateRoot.length === 0) deny(M12_REMEDIATION_STATE_DENIED);
    this.#configuredStateRoot = resolve(stateRoot);
  }

  async load(episodeId: string): Promise<RemediationEpisodeRecord | undefined> {
    const { directory, recordPath } = await this.#recordPath(episodeId);
    let recordExisted = false;
    try {
      const initial = await lstat(recordPath);
      recordExisted = true;
      if (!initial.isFile() || initial.isSymbolicLink()) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const initialReal = await realpath(recordPath);
      if (!containedBy(directory, initialReal)) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);

      const content = await readFile(recordPath, "utf8");
      const final = await lstat(recordPath);
      const finalReal = await realpath(recordPath);
      if (!final.isFile() || final.isSymbolicLink() || !samePath(initialReal, finalReal) || !containedBy(directory, finalReal)) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      try {
        return normalizeRecord(JSON.parse(content) as unknown, M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      } catch {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
    } catch (error) {
      if (isMissing(error) && !recordExisted) return undefined;
      if (error instanceof Error && error.message === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async save(snapshot: RemediationEpisodeSnapshot | RemediationEpisodeRecord): Promise<RemediationEpisodeRecord> {
    const normalized = normalizeSnapshot(snapshot, M12_REMEDIATION_STATE_DENIED);
    const record = Object.freeze({ ...normalized, hash: payloadHash(normalized) });
    const { directory, recordPath } = await this.#recordPath(normalized.episodeId);
    await this.load(normalized.episodeId);
    await this.#assertExistingRecordSafe(recordPath, directory);
    await this.#writeAtomic(recordPath, canonicalJson(record));
    await this.#assertExistingRecordSafe(recordPath, directory);
    return record;
  }

  async remove(episodeId: string): Promise<void> {
    const { directory, recordPath } = await this.#recordPath(episodeId);
    try {
      await this.#assertExistingRecordSafe(recordPath, directory);
      await unlink(recordPath);
    } catch (error) {
      if (isMissing(error)) return;
      if (error instanceof Error && error.message === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #recordPath(episodeId: string): Promise<{ readonly directory: string; readonly recordPath: string }> {
    const safeEpisodeId = identifier(episodeId, M12_REMEDIATION_STATE_DENIED);
    const directory = await this.#stateDirectory();
    const recordPath = resolve(directory, `${safeEpisodeId}.json`);
    if (!containedBy(directory, recordPath)) deny(M12_REMEDIATION_STATE_DENIED);
    return Object.freeze({ directory, recordPath });
  }

  async #stateDirectory(): Promise<string> {
    try {
      await mkdir(this.#configuredStateRoot, { recursive: true });
      const rootStats = await lstat(this.#configuredStateRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const rootReal = await realpath(this.#configuredStateRoot);
      if (!samePath(this.#configuredStateRoot, rootReal)) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);

      const requestedDirectory = join(rootReal, "remediation");
      await mkdir(requestedDirectory, { recursive: true });
      const directoryStats = await lstat(requestedDirectory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const directoryReal = await realpath(requestedDirectory);
      if (!containedBy(rootReal, directoryReal) || !samePath(requestedDirectory, directoryReal)) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      return directoryReal;
    } catch (error) {
      if (isMissing(error)) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      if (error instanceof Error && error.message === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #assertExistingRecordSafe(recordPath: string, directory: string): Promise<void> {
    try {
      const stats = await lstat(recordPath);
      if (!stats.isFile() || stats.isSymbolicLink()) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const real = await realpath(recordPath);
      if (!containedBy(directory, real)) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } catch (error) {
      if (isMissing(error)) return;
      if (error instanceof Error && error.message === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #writeAtomic(recordPath: string, content: string): Promise<void> {
    const temporaryPath = `${recordPath}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, recordPath);
      renamed = true;
    } catch (error) {
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { }
      }
      if (!renamed) {
        try { await unlink(temporaryPath); } catch { }
      }
    }
  }
}
