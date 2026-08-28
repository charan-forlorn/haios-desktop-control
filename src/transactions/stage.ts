import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { win32 } from "node:path";

import { authorizePath } from "../paths.js";
import { nextTransactionState } from "./state.js";
import { sameCurrentness, type CurrentnessProvider } from "./currentness.js";
import type { TransactionIntent, TransactionRecord } from "./types.js";
import type { TransactionStore } from "./store.js";

const PROJECT_ROOT = "c:\\workspace\\haios-desktop-control";
const MAX_CONTENT_BYTES = 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type TransactionOperationResult =
  | { readonly decision: "ALLOW"; readonly state: TransactionRecord["state"]; readonly transaction: TransactionRecord }
  | { readonly decision: "DENY"; readonly reason: string };

function projectScoped(normalizedPath: string): boolean {
  const lower = normalizedPath.toLowerCase();
  return lower === PROJECT_ROOT || lower.startsWith(`${PROJECT_ROOT}\\`);
}

async function nearestExistingProjectRealpath(normalizedPath: string): Promise<string | null> {
  let candidate = normalizedPath;
  const volumeRoot = win32.parse(normalizedPath).root;
  while (true) {
    try {
      return win32.normalize(await realpath(candidate));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    const parent = win32.dirname(candidate);
    if (parent === candidate || candidate === volumeRoot) return null;
    candidate = parent;
  }
}

async function authorizeProjectPath(input: string): Promise<string | null> {
  const decision = await authorizePath(input);
  if (decision.decision !== "ALLOW" || !projectScoped(decision.normalizedPath)) return null;
  const resolvedAncestor = await nearestExistingProjectRealpath(decision.normalizedPath);
  if (resolvedAncestor === null || !projectScoped(resolvedAncestor)) return null;
  return decision.normalizedPath;
}
export async function beginTransaction(
  store: TransactionStore,
  currentnessProvider: CurrentnessProvider,
): Promise<TransactionOperationResult> {
  const currentness = await currentnessProvider();
  const transaction: TransactionRecord = {
    id: `txn_${randomBytes(16).toString("hex")}`,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    currentness: Object.freeze({ ...currentness }),
    intents: [],
  };
  store.add(transaction);
  return { decision: "ALLOW", state: transaction.state, transaction };
}

function intentPaths(intent: TransactionIntent): string[] {
  if (intent.kind === "move") return [intent.sourcePath, intent.destinationPath];
  return [intent.path];
}

function hasConflict(record: TransactionRecord, intent: TransactionIntent): boolean {
  const existing = new Set(record.intents.flatMap(intentPaths).map((path) => path.toLowerCase()));
  return intentPaths(intent).some((path) => existing.has(path.toLowerCase()));
}

function validContent(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= MAX_CONTENT_BYTES;
}
export async function stageIntent(
  store: TransactionStore,
  transactionId: string,
  intent: TransactionIntent,
): Promise<TransactionOperationResult> {
  const record = store.get(transactionId);
  if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
  if (record.state !== "OPEN" && record.state !== "STAGED") {
    return { decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" };
  }

  let normalized: TransactionIntent;
  if (intent.kind === "create") {
    const path = await authorizeProjectPath(intent.path);
    if (path === null || !validContent(intent.content)) return { decision: "DENY", reason: "PATH_OR_CONTENT_DENIED" };
    normalized = Object.freeze({ ...intent, path });
  } else if (intent.kind === "replace") {
    const path = await authorizeProjectPath(intent.path);
    if (path === null || !SHA256_HEX.test(intent.expectedSha256) || !validContent(intent.content)) {
      return { decision: "DENY", reason: "PATH_OR_CONTENT_DENIED" };
    }
    normalized = Object.freeze({ ...intent, path });
  } else if (intent.kind === "move") {
    const sourcePath = await authorizeProjectPath(intent.sourcePath);
    const destinationPath = await authorizeProjectPath(intent.destinationPath);
    if (sourcePath === null || destinationPath === null || sourcePath.toLowerCase() === destinationPath.toLowerCase()) {
      return { decision: "DENY", reason: "PATH_DENIED" };
    }
    normalized = Object.freeze({ ...intent, sourcePath, destinationPath });
  } else {
    const path = await authorizeProjectPath(intent.path);
    if (path === null || !SHA256_HEX.test(intent.expectedSha256)) {
      return { decision: "DENY", reason: "PATH_OR_HASH_DENIED" };
    }
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return { decision: "DENY", reason: "REMOVE_TARGET_NOT_REGULAR_FILE" };
    } catch {
      return { decision: "DENY", reason: "REMOVE_TARGET_MISSING" };
    }
    normalized = Object.freeze({ ...intent, path });
  }

  if (hasConflict(record, normalized)) return { decision: "DENY", reason: "CONFLICTING_TRANSACTION_INTENT" };
  record.intents.push(normalized);
  const transition = nextTransactionState(record.state, "stage");
  if (transition.decision !== "ALLOW") return transition;
  record.state = transition.state;
  return { decision: "ALLOW", state: record.state, transaction: record };
}
export async function validateTransaction(
  store: TransactionStore,
  transactionId: string,
  currentnessProvider: CurrentnessProvider,
): Promise<TransactionOperationResult> {
  const record = store.get(transactionId);
  if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
  if (record.state !== "STAGED" || record.intents.length === 0) {
    return { decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" };
  }
  const current = await currentnessProvider();
  if (!sameCurrentness(record.currentness, current)) {
    return { decision: "DENY", reason: "STALE_TRANSACTION" };
  }
  const transition = nextTransactionState(record.state, "validate");
  if (transition.decision !== "ALLOW") return transition;
  record.state = transition.state;
  return { decision: "ALLOW", state: record.state, transaction: record };
}
