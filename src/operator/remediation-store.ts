import { createHash, randomBytes } from "node:crypto";
import { type Stats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
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

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface PinnedFile {
  readonly content: string;
  readonly identity: FileIdentity;
}

interface StoredRecord {
  readonly record: RemediationEpisodeRecord;
  readonly identity: FileIdentity;
}

interface RemovedEpisode {
  readonly schema: "HAIOS_M12_REMEDIATION_REMOVED_R1";
  readonly episodeId: string;
  readonly recordHash: string;
  readonly hash: string;
}

const SNAPSHOT_FIELDS = new Set([
  "schema", "episodeId", "projectId", "repositoryIdentity", "transactionId", "baseHeadSha", "attempt", "replanUsed",
  "coarseFingerprint", "fineFingerprint", "progressFact", "recovery",
]);
const RECORD_FIELDS = new Set([...SNAPSHOT_FIELDS, "hash"]);
const REMOVED_FIELDS = new Set(["schema", "episodeId", "recordHash", "hash"]);
const RECOVERY_VALUES = new Set<RemediationRecovery>([
  "SAFE_TO_CONTINUE", "SAFE_TO_ROLLBACK", "MANUAL_RECONCILIATION_REQUIRED",
]);
const RESERVED_WINDOWS_NAMES = new Set([
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const MUTATION_TAILS = new Map<string, Promise<void>>();

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

function ownDataFields(value: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string>, errorCode: string): ReadonlyMap<string, unknown> {
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

function episodeIdentifier(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value)) return deny(errorCode);
  const baseName = value.split(".", 1)[0]!;
  if (RESERVED_WINDOWS_NAMES.has(baseName)) return deny(errorCode);
  return value;
}

function identifier(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) return deny(errorCode);
  return value;
}

function repositoryIdentity(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return deny(errorCode);
  return value;
}

function hash(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return deny(errorCode);
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

function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function payloadHash(snapshot: RemediationEpisodeSnapshot): string {
  return sha256({
    schema: snapshot.schema, episodeId: snapshot.episodeId, projectId: snapshot.projectId,
    repositoryIdentity: snapshot.repositoryIdentity, transactionId: snapshot.transactionId, baseHeadSha: snapshot.baseHeadSha,
    attempt: snapshot.attempt, replanUsed: snapshot.replanUsed, coarseFingerprint: snapshot.coarseFingerprint,
    fineFingerprint: snapshot.fineFingerprint, progressFact: snapshot.progressFact, recovery: snapshot.recovery,
  });
}

function recordJson(record: RemediationEpisodeRecord): string {
  return canonicalJson({
    schema: record.schema, episodeId: record.episodeId, projectId: record.projectId,
    repositoryIdentity: record.repositoryIdentity, transactionId: record.transactionId, baseHeadSha: record.baseHeadSha,
    attempt: record.attempt, replanUsed: record.replanUsed, coarseFingerprint: record.coarseFingerprint,
    fineFingerprint: record.fineFingerprint, progressFact: record.progressFact, recovery: record.recovery, hash: record.hash,
  });
}

function removedHash(episodeId: string, recordHash: string): string {
  return sha256({ schema: "HAIOS_M12_REMEDIATION_REMOVED_R1", episodeId, recordHash });
}

function snapshotFromFields(fields: ReadonlyMap<string, unknown>, errorCode: string): RemediationEpisodeSnapshot {
  if (fields.get("schema") !== REMEDIATION_EPISODE_SCHEMA || fields.get("projectId") !== "operator-canary") return deny(errorCode);
  const replanUsed = fields.get("replanUsed");
  const recovery = fields.get("recovery");
  if (typeof replanUsed !== "boolean" || typeof recovery !== "string" || !RECOVERY_VALUES.has(recovery as RemediationRecovery)) {
    return deny(errorCode);
  }
  return Object.freeze({
    schema: REMEDIATION_EPISODE_SCHEMA,
    episodeId: episodeIdentifier(fields.get("episodeId"), errorCode),
    projectId: "operator-canary" as const,
    repositoryIdentity: repositoryIdentity(fields.get("repositoryIdentity"), errorCode),
    transactionId: identifier(fields.get("transactionId"), errorCode),
    baseHeadSha: headSha(fields.get("baseHeadSha"), errorCode),
    attempt: attempt(fields.get("attempt"), errorCode),
    replanUsed,
    coarseFingerprint: hash(fields.get("coarseFingerprint"), errorCode),
    fineFingerprint: hash(fields.get("fineFingerprint"), errorCode),
    progressFact: identifier(fields.get("progressFact"), errorCode),
    recovery: recovery as RemediationRecovery,
  });
}

function normalizeSnapshot(value: unknown, errorCode: string): RemediationEpisodeSnapshot {
  const fields = ownDataFields(value, RECORD_FIELDS, SNAPSHOT_FIELDS, errorCode);
  const snapshot = snapshotFromFields(fields, errorCode);
  if (fields.has("hash") && hash(fields.get("hash"), errorCode) !== payloadHash(snapshot)) return deny(errorCode);
  return snapshot;
}

function normalizeRecord(value: unknown, errorCode: string): RemediationEpisodeRecord {
  const fields = ownDataFields(value, RECORD_FIELDS, RECORD_FIELDS, errorCode);
  const snapshot = snapshotFromFields(fields, errorCode);
  const recordHash = hash(fields.get("hash"), errorCode);
  if (recordHash !== payloadHash(snapshot)) return deny(errorCode);
  return Object.freeze({ ...snapshot, hash: recordHash });
}

function normalizeRemoved(value: unknown, errorCode: string): RemovedEpisode {
  const fields = ownDataFields(value, REMOVED_FIELDS, REMOVED_FIELDS, errorCode);
  if (fields.get("schema") !== "HAIOS_M12_REMEDIATION_REMOVED_R1") return deny(errorCode);
  const episodeId = episodeIdentifier(fields.get("episodeId"), errorCode);
  const recordHash = hash(fields.get("recordHash"), errorCode);
  const removedRecordHash = hash(fields.get("hash"), errorCode);
  if (removedRecordHash !== removedHash(episodeId, recordHash)) return deny(errorCode);
  return Object.freeze({ schema: "HAIOS_M12_REMEDIATION_REMOVED_R1" as const, episodeId, recordHash, hash: removedRecordHash });
}

function identity(stats: Stats): FileIdentity {
  return Object.freeze({
    dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameMovedFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
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

function errorCode(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = MUTATION_TAILS.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = prior.catch(() => undefined).then(() => gate);
  MUTATION_TAILS.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await action();
  } finally {
    release?.();
    if (MUTATION_TAILS.get(key) === tail) MUTATION_TAILS.delete(key);
  }
}

export class RemediationStore {
  readonly #configuredStateRoot: string;

  constructor(stateRoot: string) {
    if (typeof stateRoot !== "string" || stateRoot.length === 0) deny(M12_REMEDIATION_STATE_DENIED);
    this.#configuredStateRoot = resolve(stateRoot);
  }

  async load(episodeId: string): Promise<RemediationEpisodeRecord | undefined> {
    const { directory, recordPath, removedPath } = await this.#paths(episodeId);
    await this.#assertNoResidue(directory);
    const removed = await this.#readRemoved(removedPath, directory);
    const stored = await this.#readRecord(recordPath, directory, episodeId);
    if (removed !== undefined) {
      if (removed.episodeId !== episodeId || stored !== undefined) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      return undefined;
    }
    return stored?.record;
  }

  async save(snapshot: RemediationEpisodeSnapshot | RemediationEpisodeRecord): Promise<RemediationEpisodeRecord> {
    const normalized = normalizeSnapshot(snapshot, M12_REMEDIATION_STATE_DENIED);
    const record = Object.freeze({ ...normalized, hash: payloadHash(normalized) });
    const paths = await this.#paths(normalized.episodeId);
    return this.#withMutation(paths.directory, normalized.episodeId, "save", async () => {
      if (await this.#readRemoved(paths.removedPath, paths.directory) !== undefined) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const existing = await this.#readRecord(paths.recordPath, paths.directory, normalized.episodeId);
      if (existing !== undefined) {
        this.#assertMonotonic(existing.record, record);
        if (existing.record.hash === record.hash) return existing.record;
        const prior = await this.#moveToPrior(paths.recordPath, paths.directory, normalized.episodeId, existing);
        await this.#publishRecord(paths.recordPath, paths.directory, record);
        await this.#removePinned(prior.path, paths.directory, prior.identity);
      } else {
        await this.#publishRecord(paths.recordPath, paths.directory, record);
      }
      return record;
    });
  }

  async remove(episodeId: string): Promise<void> {
    const paths = await this.#paths(episodeId);
    await this.#withMutation(paths.directory, episodeId, "remove", async () => {
      const removed = await this.#readRemoved(paths.removedPath, paths.directory);
      const existing = await this.#readRecord(paths.recordPath, paths.directory, episodeId);
      if (removed !== undefined) {
        if (removed.episodeId !== episodeId || existing !== undefined) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
        return;
      }
      if (existing === undefined) return;
      const prior = await this.#moveToPrior(paths.recordPath, paths.directory, episodeId, existing);
      const tombstone = Object.freeze({
        schema: "HAIOS_M12_REMEDIATION_REMOVED_R1" as const,
        episodeId,
        recordHash: existing.record.hash,
        hash: removedHash(episodeId, existing.record.hash),
      });
      await this.#writeExclusive(paths.removedPath, canonicalJson(tombstone));
      const validatedTombstone = await this.#readRemoved(paths.removedPath, paths.directory);
      if (validatedTombstone === undefined || validatedTombstone.hash !== tombstone.hash) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      await this.#removePinned(prior.path, paths.directory, prior.identity);
    });
  }

  #assertMonotonic(previous: RemediationEpisodeRecord, next: RemediationEpisodeRecord): void {
    if (
      previous.episodeId !== next.episodeId
      || previous.projectId !== next.projectId
      || previous.repositoryIdentity !== next.repositoryIdentity
      || previous.transactionId !== next.transactionId
      || previous.baseHeadSha !== next.baseHeadSha
      || next.attempt < previous.attempt
      || (previous.replanUsed && !next.replanUsed)
    ) deny(M12_REMEDIATION_STATE_DENIED);
  }

  async #withMutation<T>(directory: string, episodeId: string, operation: "save" | "remove", action: () => Promise<T>): Promise<T> {
    return serialized(directory, async () => {
      await this.#assertNoResidue(directory);
      const lockPath = join(directory, ".m12-remediation-lock");
      const journalPath = join(directory, ".m12-remediation-operation");
      let lockCreated = false;
      let journalCreated = false;
      let cleanup = false;
      try {
        await this.#writeExclusive(lockPath, canonicalJson({ schema: "HAIOS_M12_REMEDIATION_LOCK_R1", episodeId, operation }));
        lockCreated = true;
        await this.#writeExclusive(journalPath, canonicalJson({ schema: "HAIOS_M12_REMEDIATION_OPERATION_R1", episodeId, operation }));
        journalCreated = true;
        const result = await action();
        cleanup = true;
        return result;
      } catch (error) {
        if (errorCode(error) === M12_REMEDIATION_STATE_DENIED) cleanup = true;
        if (errorCode(error) === M12_REMEDIATION_STATE_DENIED || errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      } finally {
        if (cleanup) {
          let cleanupFailed = false;
          if (journalCreated) {
            try { await unlink(journalPath); } catch { cleanupFailed = true; }
          }
          if (lockCreated) {
            try { await unlink(lockPath); } catch { cleanupFailed = true; }
          }
          if (cleanupFailed) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
        }
      }
    });
  }

  async #paths(episodeId: string): Promise<{ readonly directory: string; readonly recordPath: string; readonly removedPath: string }> {
    const safeEpisodeId = episodeIdentifier(episodeId, M12_REMEDIATION_STATE_DENIED);
    const directory = await this.#stateDirectory();
    const recordPath = resolve(directory, `${safeEpisodeId}.json`);
    const removedPath = resolve(directory, `${safeEpisodeId}.removed.json`);
    if (!containedBy(directory, recordPath) || !containedBy(directory, removedPath)) deny(M12_REMEDIATION_STATE_DENIED);
    return Object.freeze({ directory, recordPath, removedPath });
  }

  async #stateDirectory(): Promise<string> {
    try {
      await mkdir(this.#configuredStateRoot, { recursive: true });
      const rootReal = await this.#pinDirectory(this.#configuredStateRoot, this.#configuredStateRoot);
      if (!samePath(this.#configuredStateRoot, rootReal)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const requestedDirectory = join(rootReal, "remediation");
      await mkdir(requestedDirectory, { recursive: true });
      return await this.#pinDirectory(requestedDirectory, rootReal);
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #pinDirectory(path: string, containedRoot: string): Promise<string> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const opened = identity(await handle.stat());
      const before = await lstat(path);
      if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(opened, identity(before))) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      const realBefore = await realpath(path);
      if (!containedBy(containedRoot, realBefore)) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const final = await lstat(path);
      const finalReal = await realpath(path);
      if (!final.isDirectory() || final.isSymbolicLink() || !sameIdentity(opened, identity(final)) || !samePath(realBefore, finalReal)) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      await handle.close();
      handle = undefined;
      return realBefore;
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { }
      }
    }
  }

  async #assertNoResidue(directory: string): Promise<void> {
    try {
      const names = await readdir(directory);
      if (names.some((name) => name.startsWith(".m12-"))) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #readPinned(path: string, directory: string, allowMissing: boolean): Promise<PinnedFile | undefined> {
    let handle: FileHandle | undefined;
    let opened = false;
    try {
      handle = await open(path, "r");
      opened = true;
      const openedIdentity = identity(await handle.stat());
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || !sameIdentity(openedIdentity, identity(before))) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      const realBefore = await realpath(path);
      if (!containedBy(directory, realBefore)) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const content = await handle.readFile({ encoding: "utf8" });
      const finalIdentity = identity(await handle.stat());
      const final = await lstat(path);
      const realAfter = await realpath(path);
      if (
        !final.isFile() || final.isSymbolicLink() || !sameIdentity(openedIdentity, finalIdentity)
        || !sameIdentity(finalIdentity, identity(final)) || !samePath(realBefore, realAfter) || !containedBy(directory, realAfter)
      ) return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      await handle.close();
      handle = undefined;
      return Object.freeze({ content, identity: finalIdentity });
    } catch (error) {
      if (isMissing(error) && !opened && allowMissing) return undefined;
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { }
      }
    }
  }

  async #readRecord(path: string, directory: string, episodeId: string): Promise<StoredRecord | undefined> {
    const pinned = await this.#readPinned(path, directory, true);
    if (pinned === undefined) return undefined;
    try {
      const record = normalizeRecord(JSON.parse(pinned.content) as unknown, M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      if (record.episodeId !== episodeId) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      return Object.freeze({ record, identity: pinned.identity });
    } catch {
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #readRemoved(path: string, directory: string): Promise<RemovedEpisode | undefined> {
    const pinned = await this.#readPinned(path, directory, true);
    if (pinned === undefined) return undefined;
    try {
      return normalizeRemoved(JSON.parse(pinned.content) as unknown, M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } catch {
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #writeExclusive(path: string, content: string): Promise<FileIdentity> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const written = identity(await handle.stat());
      await handle.close();
      handle = undefined;
      return written;
    } catch (error) {
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { }
      }
    }
  }

  async #publishRecord(recordPath: string, directory: string, record: RemediationEpisodeRecord): Promise<void> {
    const temporaryPath = join(directory, `.m12-new-${randomBytes(32).toString("hex")}`);
    await this.#writeExclusive(temporaryPath, recordJson(record));
    try {
      await link(temporaryPath, recordPath);
      const target = await this.#readRecord(recordPath, directory, record.episodeId);
      const temporary = await this.#readPinned(temporaryPath, directory, false);
      if (target === undefined || temporary === undefined || target.record.hash !== record.hash
        || !sameFileObject(temporary.identity, target.identity)) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      await this.#removePinned(temporaryPath, directory, temporary.identity);
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #moveToPrior(
    recordPath: string,
    directory: string,
    episodeId: string,
    expected: StoredRecord,
  ): Promise<{ readonly path: string; readonly identity: FileIdentity }> {
    const current = await this.#readRecord(recordPath, directory, episodeId);
    if (current === undefined || current.record.hash !== expected.record.hash || !sameIdentity(current.identity, expected.identity)) {
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
    const priorPath = join(directory, `.m12-prior-${randomBytes(32).toString("hex")}`);
    try {
      await rename(recordPath, priorPath);
      const prior = await this.#readPinned(priorPath, directory, false);
      if (prior === undefined || !sameMovedFile(prior.identity, expected.identity)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const moved = normalizeRecord(JSON.parse(prior.content) as unknown, M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      if (moved.episodeId !== episodeId || moved.hash !== expected.record.hash) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      return Object.freeze({ path: priorPath, identity: prior.identity });
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #removePinned(path: string, directory: string, expected: FileIdentity): Promise<void> {
    try {
      const pinned = await this.#readPinned(path, directory, false);
      if (pinned === undefined || !sameIdentity(pinned.identity, expected)) {
        return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      await unlink(path);
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }
}
