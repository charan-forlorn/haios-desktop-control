import { createHash, randomBytes } from "node:crypto";
import { type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
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

interface DirectoryPin {
  readonly rootPath: string;
  readonly rootIdentity: FileIdentity;
  readonly directory: string;
  readonly directoryIdentity: FileIdentity;
}

interface PinnedFile {
  readonly content: string;
  readonly identity: FileIdentity;
}

interface StoredRecord extends PinnedFile {
  readonly record: RemediationEpisodeRecord;
}

interface RemovalTombstone {
  readonly schema: "HAIOS_M12_REMEDIATION_TOMBSTONE_R1";
  readonly episodeId: string;
  readonly recordHash: string;
  readonly hash: string;
}

interface StoredTombstone extends PinnedFile {
  readonly tombstone: RemovalTombstone;
}

interface StorePaths {
  readonly pin: DirectoryPin;
  readonly recordPath: string;
  readonly tombstonePath: string;
}

interface MutationState {
  dirty: boolean;
}

const SNAPSHOT_FIELDS = new Set([
  "schema", "episodeId", "projectId", "repositoryIdentity", "transactionId", "baseHeadSha", "attempt", "replanUsed",
  "coarseFingerprint", "fineFingerprint", "progressFact", "recovery",
]);
const RECORD_FIELDS = new Set([...SNAPSHOT_FIELDS, "hash"]);
const TOMBSTONE_FIELDS = new Set(["schema", "episodeId", "recordHash", "hash"]);
const RECOVERY_VALUES = new Set<RemediationRecovery>([
  "SAFE_TO_CONTINUE", "SAFE_TO_ROLLBACK", "MANUAL_RECONCILIATION_REQUIRED",
]);
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u;

function deny(code: string): never { throw new Error(code); }

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataFields(value: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string>, error: string): ReadonlyMap<string, unknown> {
  if (!isPlainDataObject(value)) return deny(error);
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); } catch { return deny(error); }
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return deny(error);
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") return deny(error);
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return deny(error); }
    if (descriptor === undefined || !("value" in descriptor)) return deny(error);
    fields.set(key, descriptor.value);
  }
  for (const key of required) if (!fields.has(key)) return deny(error);
  return fields;
}

function episodeIdentifier(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value) || WINDOWS_RESERVED_BASENAME.test(value)) return deny(error);
  return value;
}

function identifier(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) return deny(error);
  return value;
}

function repositoryIdentity(value: unknown, error: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return deny(error);
  return value;
}

function hash(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return deny(error);
  return value;
}

function headSha(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) return deny(error);
  return value;
}

function attempt(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 5) return deny(error);
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

function canonicalRecordJson(record: RemediationEpisodeRecord): string {
  return canonicalJson({
    schema: record.schema, episodeId: record.episodeId, projectId: record.projectId,
    repositoryIdentity: record.repositoryIdentity, transactionId: record.transactionId, baseHeadSha: record.baseHeadSha,
    attempt: record.attempt, replanUsed: record.replanUsed, coarseFingerprint: record.coarseFingerprint,
    fineFingerprint: record.fineFingerprint, progressFact: record.progressFact, recovery: record.recovery, hash: record.hash,
  });
}

function tombstoneHash(episodeId: string, recordHash: string): string {
  return sha256({ schema: "HAIOS_M12_REMEDIATION_TOMBSTONE_R1", episodeId, recordHash });
}

function tombstoneFor(record: RemediationEpisodeRecord): RemovalTombstone {
  const recordHash = record.hash;
  return Object.freeze({
    schema: "HAIOS_M12_REMEDIATION_TOMBSTONE_R1" as const,
    episodeId: record.episodeId,
    recordHash,
    hash: tombstoneHash(record.episodeId, recordHash),
  });
}

function canonicalTombstoneJson(tombstone: RemovalTombstone): string {
  return canonicalJson({
    schema: tombstone.schema, episodeId: tombstone.episodeId, recordHash: tombstone.recordHash, hash: tombstone.hash,
  });
}

function snapshotFromFields(fields: ReadonlyMap<string, unknown>, error: string): RemediationEpisodeSnapshot {
  if (fields.get("schema") !== REMEDIATION_EPISODE_SCHEMA || fields.get("projectId") !== "operator-canary") return deny(error);
  const replanUsed = fields.get("replanUsed");
  const recovery = fields.get("recovery");
  if (typeof replanUsed !== "boolean" || typeof recovery !== "string" || !RECOVERY_VALUES.has(recovery as RemediationRecovery)) return deny(error);
  return Object.freeze({
    schema: REMEDIATION_EPISODE_SCHEMA,
    episodeId: episodeIdentifier(fields.get("episodeId"), error),
    projectId: "operator-canary" as const,
    repositoryIdentity: repositoryIdentity(fields.get("repositoryIdentity"), error),
    transactionId: identifier(fields.get("transactionId"), error),
    baseHeadSha: headSha(fields.get("baseHeadSha"), error),
    attempt: attempt(fields.get("attempt"), error),
    replanUsed,
    coarseFingerprint: hash(fields.get("coarseFingerprint"), error),
    fineFingerprint: hash(fields.get("fineFingerprint"), error),
    progressFact: identifier(fields.get("progressFact"), error),
    recovery: recovery as RemediationRecovery,
  });
}

function normalizeSnapshot(value: unknown, error: string): RemediationEpisodeSnapshot {
  const fields = ownDataFields(value, RECORD_FIELDS, SNAPSHOT_FIELDS, error);
  const snapshot = snapshotFromFields(fields, error);
  // A supplied record is evidence, not a formatting hint: its complete payload must verify.
  if (fields.has("hash") && hash(fields.get("hash"), error) !== payloadHash(snapshot)) return deny(error);
  return snapshot;
}

function normalizeRecord(value: unknown, error: string): RemediationEpisodeRecord {
  const fields = ownDataFields(value, RECORD_FIELDS, RECORD_FIELDS, error);
  const snapshot = snapshotFromFields(fields, error);
  const recordHash = hash(fields.get("hash"), error);
  if (recordHash !== payloadHash(snapshot)) return deny(error);
  return Object.freeze({ ...snapshot, hash: recordHash });
}

function normalizeTombstone(value: unknown, error: string): RemovalTombstone {
  const fields = ownDataFields(value, TOMBSTONE_FIELDS, TOMBSTONE_FIELDS, error);
  if (fields.get("schema") !== "HAIOS_M12_REMEDIATION_TOMBSTONE_R1") return deny(error);
  const episodeId = episodeIdentifier(fields.get("episodeId"), error);
  const recordHash = hash(fields.get("recordHash"), error);
  const tombstoneRecordHash = hash(fields.get("hash"), error);
  if (tombstoneRecordHash !== tombstoneHash(episodeId, recordHash)) return deny(error);
  return Object.freeze({ schema: "HAIOS_M12_REMEDIATION_TOMBSTONE_R1" as const, episodeId, recordHash, hash: tombstoneRecordHash });
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

function sameDirectoryObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function samePath(left: string, right: string): boolean { return resolve(left).toLowerCase() === resolve(right).toLowerCase(); }

function containedBy(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | null { return error instanceof Error ? error.message : null; }

export class RemediationStore {
  readonly #configuredStateRoot: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(stateRoot: string) {
    if (typeof stateRoot !== "string" || stateRoot.length === 0) deny(M12_REMEDIATION_STATE_DENIED);
    this.#configuredStateRoot = resolve(stateRoot);
  }

  async load(requestedEpisodeId: string): Promise<RemediationEpisodeRecord | undefined> {
    return this.#withRead(async () => {
      const paths = await this.#paths(requestedEpisodeId);
      await this.#assertNoResidue(paths.pin);
      const tombstone = await this.#readTombstone(paths.tombstonePath, paths.pin, requestedEpisodeId, true);
      const stored = await this.#readRecord(paths.recordPath, paths.pin, requestedEpisodeId, true);
      if (tombstone !== undefined && stored !== undefined && tombstone.tombstone.recordHash !== stored.record.hash) {
        deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      await this.#assertDirectory(paths.pin);
      await this.#assertNoResidue(paths.pin);
      if (tombstone !== undefined) return undefined;
      return stored?.record;
    });
  }

  async save(input: RemediationEpisodeSnapshot | RemediationEpisodeRecord): Promise<RemediationEpisodeRecord> {
    const snapshot = normalizeSnapshot(input, M12_REMEDIATION_STATE_DENIED);
    const record = Object.freeze({ ...snapshot, hash: payloadHash(snapshot) });
    const paths = await this.#paths(snapshot.episodeId);
    return this.#withMutation(paths, snapshot.episodeId, "save", async (state) => {
      if (await this.#readTombstone(paths.tombstonePath, paths.pin, snapshot.episodeId, true) !== undefined) {
        deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      const existing = await this.#readRecord(paths.recordPath, paths.pin, snapshot.episodeId, true);
      if (existing !== undefined) {
        this.#assertTransition(existing.record, record);
        if (existing.record.hash === record.hash) return existing.record;
        await this.#publish(paths.recordPath, paths.pin, canonicalRecordJson(record), existing, state);
      } else {
        await this.#publish(paths.recordPath, paths.pin, canonicalRecordJson(record), undefined, state);
      }
      return record;
    });
  }

  async remove(requestedEpisodeId: string): Promise<void> {
    const paths = await this.#paths(requestedEpisodeId);
    await this.#withMutation(paths, requestedEpisodeId, "remove", async (state) => {
      const tombstone = await this.#readTombstone(paths.tombstonePath, paths.pin, requestedEpisodeId, true);
      const existing = await this.#readRecord(paths.recordPath, paths.pin, requestedEpisodeId, true);
      if (tombstone !== undefined) {
        if (existing !== undefined && existing.record.hash !== tombstone.tombstone.recordHash) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
        return;
      }
      if (existing === undefined) return;
      await this.#publish(paths.tombstonePath, paths.pin, canonicalTombstoneJson(tombstoneFor(existing.record)), undefined, state);
    });
  }

  #assertTransition(previous: RemediationEpisodeRecord, next: RemediationEpisodeRecord): void {
    if (previous.episodeId !== next.episodeId || previous.projectId !== next.projectId
      || previous.repositoryIdentity !== next.repositoryIdentity || previous.transactionId !== next.transactionId
      || previous.baseHeadSha !== next.baseHeadSha || next.attempt < previous.attempt
      || (previous.replanUsed && !next.replanUsed)) deny(M12_REMEDIATION_STATE_DENIED);
  }

  async #withRead<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolveGate) => { release = resolveGate; });
    await prior.catch(() => undefined);
    try {
      return await action();
    } finally {
      release?.();
    }
  }

  async #withMutation<T>(paths: StorePaths, episodeId: string, operation: "save" | "remove", action: (state: MutationState) => Promise<T>): Promise<T> {
    const prior = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolveGate) => { release = resolveGate; });
    await prior.catch(() => undefined);
    const lockPath = join(paths.pin.directory, ".m12-remediation-lock");
    const journalPath = join(paths.pin.directory, ".m12-remediation-operation");
    const state: MutationState = { dirty: false };
    let lockCreated = false;
    let journalCreated = false;
    let clean = false;
    try {
      await this.#assertNoResidue(paths.pin);
      await this.#assertDirectory(paths.pin);
      await this.#writeExclusive(lockPath, canonicalJson({ schema: "HAIOS_M12_REMEDIATION_LOCK_R1", episodeId, operation }));
      lockCreated = true;
      await this.#assertDirectory(paths.pin);
      await this.#writeExclusive(journalPath, canonicalJson({ schema: "HAIOS_M12_REMEDIATION_OPERATION_R1", episodeId, operation }));
      journalCreated = true;
      await this.#assertDirectory(paths.pin);
      const result = await action(state);
      await this.#assertDirectory(paths.pin);
      clean = true;
      return result;
    } catch (error) {
      // Validation failures before the first move/link leave no state transition to recover.
      if (!state.dirty && (errorCode(error) === M12_REMEDIATION_STATE_DENIED || errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED)) clean = true;
      if (errorCode(error) === M12_REMEDIATION_STATE_DENIED || errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      try {
        if (clean) {
          if (journalCreated) await this.#removeKnownResidue(journalPath, paths.pin);
          if (lockCreated) await this.#removeKnownResidue(lockPath, paths.pin);
        }
      } finally {
        release?.();
      }
    }
  }

  async #paths(requestedEpisodeId: string): Promise<StorePaths> {
    const safeEpisodeId = episodeIdentifier(requestedEpisodeId, M12_REMEDIATION_STATE_DENIED);
    const pin = await this.#stateDirectory();
    const recordPath = resolve(pin.directory, `${safeEpisodeId}.json`);
    const tombstonePath = resolve(pin.directory, `${safeEpisodeId}.removed.json`);
    if (!containedBy(pin.directory, recordPath) || !containedBy(pin.directory, tombstonePath)) deny(M12_REMEDIATION_STATE_DENIED);
    return Object.freeze({ pin, recordPath, tombstonePath });
  }

  async #stateDirectory(): Promise<DirectoryPin> {
    try {
      await mkdir(this.#configuredStateRoot, { recursive: true });
      const root = await this.#pinDirectory(this.#configuredStateRoot, this.#configuredStateRoot);
      if (!samePath(root.path, this.#configuredStateRoot)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const directoryPath = join(root.path, "remediation");
      await mkdir(directoryPath, { recursive: true });
      const directory = await this.#pinDirectory(directoryPath, root.path);
      return Object.freeze({ rootPath: root.path, rootIdentity: root.identity, directory: directory.path, directoryIdentity: directory.identity });
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #pinDirectory(path: string, containedRoot: string): Promise<{ readonly path: string; readonly identity: FileIdentity }> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const opened = identity(await handle.stat());
      const before = await lstat(path);
      const realBefore = await realpath(path);
      const after = await lstat(path);
      const realAfter = await realpath(path);
      if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
        || !sameIdentity(opened, identity(before)) || !sameIdentity(opened, identity(after))
        || !samePath(realBefore, realAfter) || !containedBy(containedRoot, realBefore)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      await handle.close();
      handle = undefined;
      return Object.freeze({ path: realBefore, identity: opened });
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  async #assertDirectory(pin: DirectoryPin): Promise<void> {
    const root = await this.#pinDirectory(this.#configuredStateRoot, this.#configuredStateRoot);
    const directory = await this.#pinDirectory(join(root.path, "remediation"), root.path);
    if (!samePath(root.path, pin.rootPath) || !samePath(directory.path, pin.directory)
      || !sameDirectoryObject(root.identity, pin.rootIdentity) || !sameDirectoryObject(directory.identity, pin.directoryIdentity)) {
      deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #assertNoResidue(pin: DirectoryPin): Promise<void> {
    try {
      const names = await readdir(pin.directory);
      if (names.some((name) => name.startsWith(".m12-"))) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #readPinned(path: string, pin: DirectoryPin, allowMissing: boolean): Promise<PinnedFile | undefined> {
    let handle: FileHandle | undefined;
    let opened = false;
    try {
      handle = await open(path, "r");
      opened = true;
      const openedIdentity = identity(await handle.stat());
      const before = await lstat(path);
      const realBefore = await realpath(path);
      if (!before.isFile() || before.isSymbolicLink() || !sameIdentity(openedIdentity, identity(before))
        || !samePath(realBefore, path) || !containedBy(pin.directory, realBefore)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      const content = await handle.readFile({ encoding: "utf8" });
      const closedIdentity = identity(await handle.stat());
      const after = await lstat(path);
      const realAfter = await realpath(path);
      if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(openedIdentity, closedIdentity)
        || !sameIdentity(closedIdentity, identity(after)) || !samePath(realBefore, realAfter)
        || !samePath(realAfter, path) || !containedBy(pin.directory, realAfter)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      await handle.close();
      handle = undefined;
      return Object.freeze({ content, identity: closedIdentity });
    } catch (error) {
      if (isMissing(error) && !opened && allowMissing) return undefined;
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  async #readRecord(path: string, pin: DirectoryPin, expectedEpisodeId: string, allowMissing: boolean): Promise<StoredRecord | undefined> {
    const pinned = await this.#readPinned(path, pin, allowMissing);
    if (pinned === undefined) return undefined;
    try {
      const record = normalizeRecord(JSON.parse(pinned.content) as unknown, M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      if (record.episodeId !== expectedEpisodeId) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      return Object.freeze({ ...pinned, record });
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #readTombstone(path: string, pin: DirectoryPin, expectedEpisodeId: string, allowMissing: boolean): Promise<StoredTombstone | undefined> {
    const pinned = await this.#readPinned(path, pin, allowMissing);
    if (pinned === undefined) return undefined;
    try {
      const tombstone = normalizeTombstone(JSON.parse(pinned.content) as unknown, M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      if (tombstone.episodeId !== expectedEpisodeId) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      return Object.freeze({ ...pinned, tombstone });
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
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
      throw error;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  async #publish(recordPath: string, pin: DirectoryPin, content: string, expected: PinnedFile | undefined, state: MutationState): Promise<void> {
    const temporaryPath = join(pin.directory, `.m12-temp-${randomBytes(24).toString("hex")}`);
    let temporaryIdentity: FileIdentity | undefined;
    let publicationAmbiguous = false;
    try {
      temporaryIdentity = await this.#writeExclusive(temporaryPath, content);
      await this.#assertDirectory(pin);
      const current = await this.#readPinned(recordPath, pin, true);
      if ((expected === undefined && current !== undefined) || (expected !== undefined && (current === undefined
        || current.content !== expected.content || !sameIdentity(current.identity, expected.identity)))) {
        deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      await this.#assertDirectory(pin);
      // Node exposes no no-replace rename on this Windows platform. The precondition and
      // postcondition are both verified; an uncertain rename preserves reconciliation evidence.
      publicationAmbiguous = true;
      state.dirty = true;
      await rename(temporaryPath, recordPath);
      const target = await this.#readPinned(recordPath, pin, false);
      if (target === undefined || target.content !== content
        || await this.#readPinned(temporaryPath, pin, true) !== undefined) {
        deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      }
      await this.#assertDirectory(pin);
    } catch (error) {
      if (!publicationAmbiguous) await this.#removeExactTemporary(temporaryPath, pin);
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #removeExactTemporary(path: string, pin: DirectoryPin): Promise<void> {
    try {
      const temporary = await this.#readPinned(path, pin, true);
      if (temporary !== undefined) await this.#removePinned(path, pin, temporary.identity);
    } catch {
      // If the exact artifact cannot be revalidated and removed, it remains as reconciliation evidence.
    }
  }

  async #removePinned(path: string, pin: DirectoryPin, expected: FileIdentity): Promise<void> {
    const current = await this.#readPinned(path, pin, false);
    if (current === undefined || !sameIdentity(current.identity, expected)) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    await this.#assertDirectory(pin);
    try {
      await unlink(path);
      if (await this.#readPinned(path, pin, true) !== undefined) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
      await this.#assertDirectory(pin);
    } catch (error) {
      if (errorCode(error) === M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED) throw error;
      return deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    }
  }

  async #removeKnownResidue(path: string, pin: DirectoryPin): Promise<void> {
    const current = await this.#readPinned(path, pin, false);
    if (current === undefined) deny(M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED);
    await this.#removePinned(path, pin, current.identity);
  }
}
