import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

import type {
  OperatorTransactionIntent,
  OperatorTransactionRecord,
  OperatorTransactionState,
} from "./transaction-types.js";

export interface OperatorTransactionGit {
  head(cwd: string): Promise<string>;
  status(cwd: string): Promise<string>;
  commonDir(cwd: string): Promise<string>;
  worktreeAdd(repo: string, path: string, branch: string, startPoint: string): Promise<void>;
  worktreeRemove(repo: string, path: string): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  addAll(cwd: string): Promise<void>;
  commit(cwd: string, message: string): Promise<string>;
  isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  mergeFastForward(cwd: string, checkpoint: string): Promise<string>;
}

export interface OperatorTransactionServiceConfig {
  readonly worktreeRoot: string;
  readonly allowedProjects: Readonly<Record<string, string>>;
  readonly git: OperatorTransactionGit;
}

export type OperatorTransactionResult =
  | { readonly decision: "ALLOW"; readonly transaction: OperatorTransactionRecord; readonly state: OperatorTransactionState }
  | { readonly decision: "DENY"; readonly reason: string };

export type OperatorTransactionStatusResult =
  | { readonly decision: "ALLOW"; readonly transaction: OperatorTransactionRecord; readonly state: OperatorTransactionState; readonly intentCount: number }
  | { readonly decision: "DENY"; readonly reason: string };

interface MutableRecord {
  txId: string;
  projectId: string;
  canonicalRoot: string;
  worktreePath: string;
  branchName: string;
  baseHeadSha: string;
  createdAt: string;
  state: OperatorTransactionState;
  intents: OperatorTransactionIntent[];
  checkpointId?: string;
}
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const FULL_SHA256 = /^[a-f0-9]{64}$/i;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

function samePath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

function within(root: string, candidate: string): boolean {
  const base = win32.resolve(root).replace(/[\\/]+$/, "").toLowerCase();
  const value = win32.resolve(candidate).replace(/[\\/]+$/, "").toLowerCase();
  return value === base || value.startsWith(`${base}\\`);
}

function normalizeRelPath(value: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) return null;
  const segments = value.replace(/\//g, "\\").split("\\");
  if (win32.isAbsolute(value) || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  const sensitive = segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".git" || lower === "credentials" || lower === "secrets" ||
      lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key");
  });
  if (sensitive) return null;
  return win32.normalize(segments.join("\\"));
}

function decodeBase64(value: string): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_CONTENT_BYTES || bytes.toString("base64") !== value) return null;
  return bytes;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
async function nearestExistingRealpath(path: string): Promise<string | null> {
  let candidate = win32.resolve(path);
  const volumeRoot = win32.parse(candidate).root;
  while (true) {
    try { return win32.normalize(await realpath(candidate)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    const parent = win32.dirname(candidate);
    if (parent === candidate || candidate === volumeRoot) return null;
    candidate = parent;
  }
}

async function authorizeCandidate(
  worktreePath: string,
  relPath: string,
  requireRegularFile: boolean,
): Promise<{ decision: "ALLOW"; relPath: string; absolutePath: string } | { decision: "DENY"; reason: "PATH_DENIED" }> {
  const normalizedRel = normalizeRelPath(relPath);
  if (normalizedRel === null) return { decision: "DENY", reason: "PATH_DENIED" };
  const rootReal = win32.normalize(await realpath(worktreePath));
  const absolutePath = win32.resolve(worktreePath, normalizedRel);
  if (!within(worktreePath, absolutePath)) return { decision: "DENY", reason: "PATH_DENIED" };
  const ancestorReal = await nearestExistingRealpath(absolutePath);
  if (ancestorReal === null || !within(rootReal, ancestorReal)) return { decision: "DENY", reason: "PATH_DENIED" };
  if (requireRegularFile) {
    try {
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return { decision: "DENY", reason: "PATH_DENIED" };
      const targetReal = win32.normalize(await realpath(absolutePath));
      if (!within(rootReal, targetReal)) return { decision: "DENY", reason: "PATH_DENIED" };
    } catch { return { decision: "DENY", reason: "PATH_DENIED" }; }
  }
  return { decision: "ALLOW", relPath: normalizedRel, absolutePath };
}

function snapshot(record: MutableRecord): OperatorTransactionRecord {
  return Object.freeze({
    ...record,
    intents: Object.freeze(record.intents.map((intent) => Object.freeze({ ...intent }))),
  });
}

function allow(record: MutableRecord): OperatorTransactionResult {
  return { decision: "ALLOW", transaction: snapshot(record), state: record.state };
}
export class OperatorTransactionService {
  readonly #worktreeRoot: string;
  readonly #allowedProjects: Readonly<Record<string, string>>;
  readonly #git: OperatorTransactionGit;
  readonly #records = new Map<string, MutableRecord>();
  readonly #repositoryIdentity = new Map<string, string>();

  constructor(config: OperatorTransactionServiceConfig) {
    this.#worktreeRoot = win32.resolve(config.worktreeRoot);
    this.#allowedProjects = Object.freeze({ ...config.allowedProjects });
    this.#git = config.git;
  }

  async #commonDirAbsolute(cwd: string): Promise<string | null> {
    try {
      const raw = (await this.#git.commonDir(cwd)).trim();
      if (raw.length === 0) return null;
      return win32.normalize(win32.isAbsolute(raw) ? raw : win32.resolve(cwd, raw));
    } catch { return null; }
  }

  async begin(projectId: string, canonicalRoot: string): Promise<OperatorTransactionResult> {
    const allowed = this.#allowedProjects[projectId];
    if (allowed === undefined) return { decision: "DENY", reason: "PROJECT_NOT_ALLOWED" };
    let canonicalReal: string;
    let allowedReal: string;
    try {
      canonicalReal = win32.normalize(await realpath(canonicalRoot));
      allowedReal = win32.normalize(await realpath(allowed));
    } catch { return { decision: "DENY", reason: "CANONICAL_ROOT_INVALID" }; }
    if (!samePath(canonicalReal, allowedReal)) return { decision: "DENY", reason: "CANONICAL_ROOT_MISMATCH" };
    if ((await this.#git.status(canonicalReal)).trim().length !== 0) return { decision: "DENY", reason: "CANONICAL_DIRTY" };
    const baseHeadSha = await this.#git.head(canonicalReal);
    if (!FULL_GIT_SHA.test(baseHeadSha)) return { decision: "DENY", reason: "CANONICAL_HEAD_INVALID" };
    const canonicalIdentity = await this.#commonDirAbsolute(canonicalReal);
    if (canonicalIdentity === null) return { decision: "DENY", reason: "CANONICAL_GIT_IDENTITY_UNAVAILABLE" };

    const idHex = randomUUID().replace(/-/g, "").toLowerCase();
    const txId = `txn_${idHex}`;
    const branchName = `haios-tx-${idHex.slice(0, 12)}`;
    const worktreePath = join(this.#worktreeRoot, txId);
    if (await exists(worktreePath)) return { decision: "DENY", reason: "WORKTREE_PATH_EXISTS" };
    try { await this.#git.worktreeAdd(canonicalReal, worktreePath, branchName, baseHeadSha); }
    catch { return { decision: "DENY", reason: "WORKTREE_CREATE_FAILED" }; }
    const worktreeIdentity = await this.#commonDirAbsolute(worktreePath);
    if (worktreeIdentity === null || !samePath(worktreeIdentity, canonicalIdentity)) {
      return { decision: "DENY", reason: "WORKTREE_REPOSITORY_IDENTITY_MISMATCH" };
    }
    if ((await this.#git.head(worktreePath)) !== baseHeadSha || (await this.#git.status(worktreePath)).trim().length !== 0) {
      try { await this.#git.worktreeRemove(canonicalReal, worktreePath); await this.#git.deleteBranch(canonicalReal, branchName); } catch { }
      return { decision: "DENY", reason: "WORKTREE_BASE_MISMATCH" };
    }

    const record: MutableRecord = {
      txId, projectId, canonicalRoot: canonicalReal, worktreePath, branchName, baseHeadSha,
      createdAt: new Date().toISOString(), state: "OPEN", intents: [],
    };
    this.#records.set(txId, record);
    this.#repositoryIdentity.set(txId, canonicalIdentity);
    return allow(record);
  }
  #record(txId: string): MutableRecord | undefined {
    return this.#records.get(txId);
  }

  #stageAllowed(record: MutableRecord): boolean {
    return record.state === "OPEN" || record.state === "STAGED";
  }

  #touched(record: MutableRecord): Set<string> {
    const result = new Set<string>();
    for (const intent of record.intents) {
      if (intent.kind === "move") {
        result.add(intent.fromRel.toLowerCase());
        result.add(intent.toRel.toLowerCase());
      } else result.add(intent.relPath.toLowerCase());
    }
    return result;
  }

  async #source(
    record: MutableRecord,
    relPath: string,
    expectedSha256: string,
  ): Promise<{ decision: "ALLOW"; relPath: string; absolutePath: string } | { decision: "DENY"; reason: string }> {
    if (!FULL_SHA256.test(expectedSha256)) return { decision: "DENY", reason: "PREIMAGE_MISMATCH" };
    const guarded = await authorizeCandidate(record.worktreePath, relPath, true);
    if (guarded.decision !== "ALLOW") return guarded;
    const bytes = await readFile(guarded.absolutePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) return { decision: "DENY", reason: "PREIMAGE_MISMATCH" };
    return guarded;
  }

  #append(record: MutableRecord, intent: OperatorTransactionIntent): OperatorTransactionResult {
    record.intents.push(intent);
    record.state = "STAGED";
    return allow(record);
  }

  async stageCreate(txId: string, relPath: string, contentBase64: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (!this.#stageAllowed(record)) return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    const content = decodeBase64(contentBase64);
    if (content === null) return { decision: "DENY", reason: "INVALID_CONTENT" };
    const target = await authorizeCandidate(record.worktreePath, relPath, false);
    if (target.decision !== "ALLOW") return target;
    if (this.#touched(record).has(target.relPath.toLowerCase())) return { decision: "DENY", reason: "PATH_ALREADY_STAGED" };
    if (await exists(target.absolutePath)) return { decision: "DENY", reason: "TARGET_EXISTS" };
    return this.#append(record, { kind: "create", relPath: target.relPath, contentBase64 });
  }
  async stagePatch(txId: string, relPath: string, preimageSha256: string, newContentBase64: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (!this.#stageAllowed(record)) return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    if (decodeBase64(newContentBase64) === null) return { decision: "DENY", reason: "INVALID_CONTENT" };
    const source = await this.#source(record, relPath, preimageSha256);
    if (source.decision !== "ALLOW") return source;
    if (this.#touched(record).has(source.relPath.toLowerCase())) return { decision: "DENY", reason: "PATH_ALREADY_STAGED" };
    return this.#append(record, { kind: "patch", relPath: source.relPath, preimageSha256: preimageSha256.toLowerCase(), newContentBase64 });
  }

  async stageMove(txId: string, fromRel: string, toRel: string, preimageSha256: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (!this.#stageAllowed(record)) return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    const source = await this.#source(record, fromRel, preimageSha256);
    if (source.decision !== "ALLOW") return source;
    const target = await authorizeCandidate(record.worktreePath, toRel, false);
    if (target.decision !== "ALLOW") return target;
    const touched = this.#touched(record);
    if (touched.has(source.relPath.toLowerCase()) || touched.has(target.relPath.toLowerCase())) {
      return { decision: "DENY", reason: "PATH_ALREADY_STAGED" };
    }
    if (await exists(target.absolutePath)) return { decision: "DENY", reason: "TARGET_EXISTS" };
    return this.#append(record, {
      kind: "move", fromRel: source.relPath, toRel: target.relPath, preimageSha256: preimageSha256.toLowerCase(),
    });
  }
  async stageRemove(txId: string, relPath: string, preimageSha256: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (!this.#stageAllowed(record)) return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    const source = await this.#source(record, relPath, preimageSha256);
    if (source.decision !== "ALLOW") return source;
    if (this.#touched(record).has(source.relPath.toLowerCase())) return { decision: "DENY", reason: "PATH_ALREADY_STAGED" };
    return this.#append(record, { kind: "remove", relPath: source.relPath, preimageSha256: preimageSha256.toLowerCase() });
  }

  async #revalidateIntent(record: MutableRecord, intent: OperatorTransactionIntent): Promise<boolean> {
    if (intent.kind === "create") {
      const target = await authorizeCandidate(record.worktreePath, intent.relPath, false);
      return target.decision === "ALLOW" && !(await exists(target.absolutePath));
    }
    if (intent.kind === "patch" || intent.kind === "remove") {
      return (await this.#source(record, intent.relPath, intent.preimageSha256)).decision === "ALLOW";
    }
    const source = await this.#source(record, intent.fromRel, intent.preimageSha256);
    if (source.decision !== "ALLOW") return false;
    const target = await authorizeCandidate(record.worktreePath, intent.toRel, false);
    return target.decision === "ALLOW" && !(await exists(target.absolutePath));
  }

  async validate(txId: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (record.state !== "STAGED" || record.intents.length === 0) return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    if ((await this.#git.head(record.canonicalRoot)) !== record.baseHeadSha) return { decision: "DENY", reason: "STALE_CANONICAL_HEAD" };
    if ((await this.#git.status(record.canonicalRoot)).trim().length !== 0) return { decision: "DENY", reason: "CANONICAL_DIRTY" };
    if ((await this.#git.head(record.worktreePath)) !== record.baseHeadSha) return { decision: "DENY", reason: "WORKTREE_HEAD_DRIFT" };
    if ((await this.#git.status(record.worktreePath)).trim().length !== 0) return { decision: "DENY", reason: "WORKTREE_DIRTY_BEFORE_APPLY" };
    for (const intent of record.intents) {
      if (!(await this.#revalidateIntent(record, intent))) return { decision: "DENY", reason: "STAGED_INTENT_DRIFT" };
    }
    record.state = "VALIDATED";
    return allow(record);
  }
  async #canonicalStillCurrent(record: MutableRecord): Promise<boolean> {
    return (await this.#git.head(record.canonicalRoot)) === record.baseHeadSha &&
      (await this.#git.status(record.canonicalRoot)).trim().length === 0;
  }

  async #discardRuntime(record: MutableRecord): Promise<boolean> {
    const expectedIdentity = this.#repositoryIdentity.get(record.txId);
    if (expectedIdentity === undefined) return false;
    const canonicalIdentity = await this.#commonDirAbsolute(record.canonicalRoot);
    const worktreeIdentity = await this.#commonDirAbsolute(record.worktreePath);
    if (canonicalIdentity === null || worktreeIdentity === null) return false;
    if (!samePath(canonicalIdentity, expectedIdentity) || !samePath(worktreeIdentity, expectedIdentity)) return false;
    try { await this.#git.worktreeRemove(record.canonicalRoot, record.worktreePath); }
    catch { return false; }
    try { await this.#git.deleteBranch(record.canonicalRoot, record.branchName); }
    catch { return false; }
    this.#repositoryIdentity.delete(record.txId);
    return true;
  }

  async #discard(record: MutableRecord): Promise<boolean> {
    const clean = await this.#discardRuntime(record);
    if (clean) record.state = "ROLLED_BACK";
    return clean;
  }

  async #applyIntent(record: MutableRecord, intent: OperatorTransactionIntent): Promise<boolean> {
    if (!(await this.#revalidateIntent(record, intent))) return false;
    if (intent.kind === "create") {
      const target = await authorizeCandidate(record.worktreePath, intent.relPath, false);
      const content = decodeBase64(intent.contentBase64);
      if (target.decision !== "ALLOW" || content === null || await exists(target.absolutePath)) return false;
      await mkdir(win32.dirname(target.absolutePath), { recursive: true });
      await writeFile(target.absolutePath, content, { flag: "wx" });
      return true;
    }
    if (intent.kind === "patch") {
      const source = await this.#source(record, intent.relPath, intent.preimageSha256);
      const content = decodeBase64(intent.newContentBase64);
      if (source.decision !== "ALLOW" || content === null) return false;
      await writeFile(source.absolutePath, content);
      return true;
    }
    if (intent.kind === "move") {
      const source = await this.#source(record, intent.fromRel, intent.preimageSha256);
      const target = await authorizeCandidate(record.worktreePath, intent.toRel, false);
      if (source.decision !== "ALLOW" || target.decision !== "ALLOW" || await exists(target.absolutePath)) return false;
      await mkdir(win32.dirname(target.absolutePath), { recursive: true });
      await rename(source.absolutePath, target.absolutePath);
      return true;
    }
    const source = await this.#source(record, intent.relPath, intent.preimageSha256);
    if (source.decision !== "ALLOW") return false;
    await rm(source.absolutePath, { force: false });
    return true;
  }

  async apply(txId: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (record.state !== "VALIDATED") return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    if (!(await this.#canonicalStillCurrent(record))) return { decision: "DENY", reason: "CANONICAL_DRIFT" };
    if ((await this.#git.head(record.worktreePath)) !== record.baseHeadSha) return { decision: "DENY", reason: "WORKTREE_HEAD_DRIFT" };
    try {
      for (const intent of record.intents) {
        if (!(await this.#applyIntent(record, intent))) throw new Error("INTENT_DRIFT");
      }
      if (!(await this.#canonicalStillCurrent(record))) throw new Error("CANONICAL_DRIFT");
      record.state = "APPLIED";
      return allow(record);
    } catch {
      const discarded = await this.#discard(record);
      return discarded
        ? { decision: "DENY", reason: "APPLY_FAILED_TRANSACTION_DISCARDED" }
        : { decision: "DENY", reason: "APPLY_FAILED_CLEANUP_PENDING" };
    }
  }
  async checkpoint(txId: string, message: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (record.state !== "APPLIED") return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    if (message.trim().length === 0 || message.length > 200) return { decision: "DENY", reason: "INVALID_COMMIT_MESSAGE" };
    if (!(await this.#canonicalStillCurrent(record))) return { decision: "DENY", reason: "CANONICAL_DRIFT" };
    let checkpointId: string;
    try {
      await this.#git.addAll(record.worktreePath);
      checkpointId = await this.#git.commit(record.worktreePath, message);
    } catch {
      return { decision: "DENY", reason: "CHECKPOINT_FAILED" };
    }
    if (!FULL_GIT_SHA.test(checkpointId)) return { decision: "DENY", reason: "CHECKPOINT_INVALID" };
    if (!(await this.#git.isAncestor(record.worktreePath, record.baseHeadSha, checkpointId))) {
      return { decision: "DENY", reason: "CHECKPOINT_NOT_DESCENDANT" };
    }
    if ((await this.#git.status(record.worktreePath)).trim().length !== 0) {
      return { decision: "DENY", reason: "CHECKPOINT_WORKTREE_DIRTY" };
    }
    if (!(await this.#canonicalStillCurrent(record))) return { decision: "DENY", reason: "CANONICAL_DRIFT" };
    record.checkpointId = checkpointId;
    record.state = "CHECKPOINTED";
    return allow(record);
  }

  async promote(txId: string, expectedHeadSha: string, checkpointId: string): Promise<OperatorTransactionResult & { readonly cleanupPending?: boolean }> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (record.state !== "CHECKPOINTED" || record.checkpointId === undefined) {
      return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    }
    if (expectedHeadSha !== record.baseHeadSha) return { decision: "DENY", reason: "EXPECTED_HEAD_MISMATCH" };
    if (checkpointId !== record.checkpointId) return { decision: "DENY", reason: "CHECKPOINT_MISMATCH" };
    if ((await this.#git.head(record.canonicalRoot)) !== record.baseHeadSha) {
      return { decision: "DENY", reason: "STALE_CANONICAL_HEAD" };
    }
    if ((await this.#git.status(record.canonicalRoot)).trim().length !== 0) {
      return { decision: "DENY", reason: "CANONICAL_DIRTY" };
    }
    if (!(await this.#git.isAncestor(record.worktreePath, record.baseHeadSha, checkpointId))) {
      return { decision: "DENY", reason: "CHECKPOINT_NOT_DESCENDANT" };
    }
    try {
      const promotedHead = await this.#git.mergeFastForward(record.canonicalRoot, checkpointId);
      if (promotedHead !== checkpointId || (await this.#git.head(record.canonicalRoot)) !== checkpointId) {
        return { decision: "DENY", reason: "PROMOTION_POSTCONDITION_FAILED" };
      }
      if ((await this.#git.status(record.canonicalRoot)).trim().length !== 0) {
        return { decision: "DENY", reason: "PROMOTION_POSTCONDITION_FAILED" };
      }
    } catch {
      return { decision: "DENY", reason: "PROMOTION_FAILED" };
    }
    record.state = "PROMOTED";
    const cleanupPending = !(await this.#discardRuntime(record));
    return { decision: "ALLOW", transaction: snapshot(record), state: record.state, cleanupPending };
  }

  async rollback(txId: string): Promise<OperatorTransactionResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (record.state === "PROMOTED" || record.state === "ROLLED_BACK") {
      return { decision: "DENY", reason: "INVALID_TRANSACTION_STATE" };
    }
    const cleaned = await this.#discard(record);
    return cleaned ? allow(record) : { decision: "DENY", reason: "ROLLBACK_CLEANUP_PENDING" };
  }

  async status(txId: string): Promise<OperatorTransactionStatusResult> {
    const record = this.#record(txId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    return {
      decision: "ALLOW",
      transaction: snapshot(record),
      state: record.state,
      intentCount: record.intents.length,
    };
  }
}
