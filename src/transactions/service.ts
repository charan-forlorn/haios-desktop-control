import { rm } from "node:fs/promises";
import { join } from "node:path";

import { applyTransaction } from "./apply.js";
import type { TransactionMutationAdapter } from "./adapter.js";
import type { CurrentnessProvider } from "./currentness.js";
import { RollbackBundleStore } from "./preimage.js";
import { rollbackPlans } from "./rollback.js";
import { beginTransaction, stageIntent, validateTransaction } from "./stage.js";
import { nextTransactionState } from "./state.js";
import { TransactionStore } from "./store.js";
import type { RollbackPlan, TransactionIntent, TransactionState } from "./types.js";

export interface TransactionServiceConfig {
  readonly currentness: CurrentnessProvider;
  readonly adapter: TransactionMutationAdapter;
  readonly rollbackRoot: string;
  readonly verifier: () => Promise<boolean>;
  readonly verificationProfile?: string;
}

export type TransactionServiceResult =
  | { readonly decision: "ALLOW"; readonly state: TransactionState; readonly transactionId: string; readonly verificationProfile?: string }
  | { readonly decision: "DENY"; readonly reason: string };

interface VerificationEvidence {
  readonly profile: string;
  result: "PENDING" | "PASS" | "FAIL";
  verifiedAt?: string;
  promotedAt?: string;
}
export class TransactionService {
  readonly #currentness: CurrentnessProvider;
  readonly #adapter: TransactionMutationAdapter;
  readonly #rollbackRoot: string;
  readonly #verifier: () => Promise<boolean>;
  readonly #verificationProfile: string;
  readonly #store = new TransactionStore();
  readonly #plans = new Map<string, readonly RollbackPlan[]>();
  readonly #verification = new Map<string, VerificationEvidence>();

  constructor(config: TransactionServiceConfig) {
    this.#currentness = config.currentness;
    this.#adapter = config.adapter;
    this.#rollbackRoot = config.rollbackRoot;
    this.#verifier = config.verifier;
    this.#verificationProfile = config.verificationProfile ?? "project_test";
  }

  async begin(): Promise<TransactionServiceResult> {
    const result = await beginTransaction(this.#store, this.#currentness);
    if (result.decision !== "ALLOW") return result;
    return { decision: "ALLOW", state: result.state, transactionId: result.transaction.id };
  }

  async #stage(transactionId: string, intent: TransactionIntent): Promise<TransactionServiceResult> {
    const result = await stageIntent(this.#store, transactionId, intent);
    if (result.decision !== "ALLOW") return result;
    return { decision: "ALLOW", state: result.state, transactionId };
  }
  stageCreate(transactionId: string, path: string, content: string) {
    return this.#stage(transactionId, { kind: "create", path, content });
  }

  stageReplace(transactionId: string, path: string, expectedSha256: string, content: string) {
    return this.#stage(transactionId, { kind: "replace", path, expectedSha256, content });
  }

  stageMove(transactionId: string, sourcePath: string, destinationPath: string) {
    return this.#stage(transactionId, { kind: "move", sourcePath, destinationPath });
  }

  async validate(transactionId: string): Promise<TransactionServiceResult> {
    const result = await validateTransaction(this.#store, transactionId, this.#currentness);
    if (result.decision !== "ALLOW") return result;
    return { decision: "ALLOW", state: result.state, transactionId };
  }

  async promote(transactionId: string): Promise<TransactionServiceResult> {
    const record = this.#store.get(transactionId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    const transition = nextTransactionState(record.state, "promote");
    if (transition.decision !== "ALLOW") return transition;
    record.state = transition.state;
    const evidence = this.#verification.get(transactionId);
    if (evidence !== undefined) evidence.promotedAt = new Date().toISOString();
    await rm(join(this.#rollbackRoot, transactionId), { recursive: true, force: true });
    return { decision: "ALLOW", state: record.state, transactionId, verificationProfile: this.#verificationProfile };
  }
  async #rollback(transactionId: string): Promise<TransactionServiceResult> {
    const record = this.#store.get(transactionId);
    if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
    if (record.state !== "ROLLBACK_REQUIRED") {
      return { decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" };
    }
    const plans = this.#plans.get(transactionId);
    if (plans === undefined) return { decision: "DENY", reason: "ROLLBACK_PLAN_UNAVAILABLE" };
    const bundles = new RollbackBundleStore(this.#rollbackRoot, transactionId);
    const rolledBack = await rollbackPlans(plans, bundles);
    if (rolledBack.decision !== "ALLOW") return rolledBack;
    const transition = nextTransactionState(record.state, "rollback");
    if (transition.decision !== "ALLOW") return transition;
    record.state = transition.state;
    await rm(join(this.#rollbackRoot, transactionId), { recursive: true, force: true });
    return { decision: "ALLOW", state: record.state, transactionId };
  }

  rollback(transactionId: string): Promise<TransactionServiceResult> {
    return this.#rollback(transactionId);
  }

  async apply(transactionId: string): Promise<TransactionServiceResult> {
    const bundles = new RollbackBundleStore(this.#rollbackRoot, transactionId);
    const applied = await applyTransaction(
      this.#store, transactionId, this.#currentness, this.#adapter, bundles,
    );
    if (applied.decision !== "ALLOW") return applied;
    this.#plans.set(transactionId, applied.rollbackPlans);
    const evidence: VerificationEvidence = { profile: this.#verificationProfile, result: "PENDING" };
    this.#verification.set(transactionId, evidence);
    let verified = false;
    try {
      verified = await this.#verifier();
    } catch {
      verified = false;
    }
    evidence.result = verified ? "PASS" : "FAIL";
    evidence.verifiedAt = new Date().toISOString();
    const record = this.#store.require(transactionId);
    if (!verified) {
      const required = nextTransactionState(record.state, "require_rollback");
      if (required.decision !== "ALLOW") return required;
      record.state = required.state;
      const rolledBack = await this.#rollback(transactionId);
      if (rolledBack.decision !== "ALLOW") return rolledBack;
      return { decision: "DENY", reason: "VERIFICATION_FAILED_ROLLED_BACK" };
    }

    const verifiedState = nextTransactionState(record.state, "verify");
    if (verifiedState.decision !== "ALLOW") return verifiedState;
    record.state = verifiedState.state;
    return this.promote(transactionId);
  }

  async status(transactionId: string) {
    const record = this.#store.get(transactionId);
    if (record === undefined) return { decision: "DENY" as const, reason: "TRANSACTION_NOT_FOUND" };
    const verification = this.#verification.get(transactionId);
    return {
      decision: "ALLOW" as const,
      transactionId,
      state: record.state,
      createdAt: record.createdAt,
      intentCount: record.intents.length,
      currentness: record.currentness,
      verification: verification === undefined ? undefined : { ...verification },
    };
  }
}

export type TransactionDispatchResult = { readonly decision: "ALLOW" | "DENY"; readonly [key: string]: unknown };

export interface TransactionServiceApi {
  begin(): Promise<TransactionDispatchResult>;
  stageCreate(transactionId: string, path: string, content: string): Promise<TransactionDispatchResult>;
  stageReplace(transactionId: string, path: string, expectedSha256: string, content: string): Promise<TransactionDispatchResult>;
  stageMove(transactionId: string, sourcePath: string, destinationPath: string): Promise<TransactionDispatchResult>;
  validate(transactionId: string): Promise<TransactionDispatchResult>;
  apply(transactionId: string): Promise<TransactionDispatchResult>;
  rollback(transactionId: string): Promise<TransactionDispatchResult>;
  status(transactionId: string): Promise<TransactionDispatchResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactStrings(raw: unknown, keys: readonly string[]): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
  for (const key of keys) if (typeof raw[key] !== "string") return null;
  return raw as Record<string, string>;
}

const INVALID_ARGS: TransactionDispatchResult = Object.freeze({ decision: "DENY" as const, reason: "INVALID_MUTATION_ARGUMENTS" });
const TRANSACTION_TOOL_NAMES = new Set([
  "transaction_begin", "transaction_stage_create", "transaction_stage_replace",
  "transaction_stage_move", "transaction_validate", "transaction_apply",
  "transaction_rollback", "transaction_status",
]);

export async function dispatchTransactionTool(
  service: TransactionServiceApi,
  name: string,
  raw: unknown,
): Promise<TransactionDispatchResult> {
  if (!TRANSACTION_TOOL_NAMES.has(name)) return { decision: "DENY", reason: "TOOL_DENIED" };
  if (name === "transaction_begin") {
    return isRecord(raw) && Object.keys(raw).length === 0 ? service.begin() : INVALID_ARGS;
  }
  if (name === "transaction_stage_create") {
    const args = exactStrings(raw, ["transactionId", "path", "content"]);
    return args === null ? INVALID_ARGS : service.stageCreate(args.transactionId!, args.path!, args.content!);
  }
  if (name === "transaction_stage_replace") {
    const args = exactStrings(raw, ["transactionId", "path", "expectedSha256", "content"]);
    return args === null ? INVALID_ARGS : service.stageReplace(args.transactionId!, args.path!, args.expectedSha256!, args.content!);
  }
  if (name === "transaction_stage_move") {
    const args = exactStrings(raw, ["transactionId", "sourcePath", "destinationPath"]);
    return args === null ? INVALID_ARGS : service.stageMove(args.transactionId!, args.sourcePath!, args.destinationPath!);
  }
  const args = exactStrings(raw, ["transactionId"]);
  if (args === null) return INVALID_ARGS;
  if (name === "transaction_validate") return service.validate(args.transactionId!);
  if (name === "transaction_apply") return service.apply(args.transactionId!);
  if (name === "transaction_rollback") return service.rollback(args.transactionId!);
  if (name === "transaction_status") return service.status(args.transactionId!);
  return { decision: "DENY", reason: "TOOL_DENIED" };
}
