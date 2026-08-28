import { NODE_FILE_PROBE, sha256Bytes, type FileProbe, type TransactionMutationAdapter } from "./adapter.js";
import { sameCurrentness, type CurrentnessProvider } from "./currentness.js";
import type { RollbackBundleStore } from "./preimage.js";
import { rollbackPlans } from "./rollback.js";
import { nextTransactionState } from "./state.js";
import type { RollbackPlan, TransactionIntent } from "./types.js";
import type { TransactionStore } from "./store.js";

export type ApplyTransactionResult =
  | { readonly decision: "ALLOW"; readonly state: "APPLIED"; readonly rollbackPlans: readonly RollbackPlan[] }
  | { readonly decision: "DENY"; readonly reason: string };

async function planForIntent(
  intent: TransactionIntent,
  bundles: RollbackBundleStore,
  probe: FileProbe,
): Promise<RollbackPlan> {
  if (intent.kind === "create") {
    return { kind: "create", path: intent.path, postSha256: sha256Bytes(Buffer.from(intent.content, "utf8")) };
  }
  if (intent.kind === "replace") {
    const bytes = await probe.read(intent.path);
    const captured = await bundles.capture(intent.path, bytes);
    return {
      kind: "replace", path: intent.path, preSha256: captured.sha256,
      postSha256: sha256Bytes(Buffer.from(intent.content, "utf8")), bundlePath: captured.bundlePath,
    };
  }
  if (intent.kind === "remove") {
    const bytes = await probe.read(intent.path);
    const preSha256 = sha256Bytes(bytes);
    if (preSha256 !== intent.expectedSha256) throw new Error("PREIMAGE_MISMATCH");
    const captured = await bundles.capture(intent.path, bytes);
    const quarantinePath = await bundles.prepareQuarantine(intent.path);
    return {
      kind: "remove",
      path: intent.path,
      preSha256,
      quarantinePath,
      bundlePath: captured.bundlePath,
    };
  }
  const bytes = await probe.read(intent.sourcePath);
  const captured = await bundles.capture(intent.sourcePath, bytes);
  return {
    kind: "move",
    sourcePath: intent.sourcePath,
    destinationPath: intent.destinationPath,
    preSha256: captured.sha256,
    postSha256: captured.sha256,
    bundlePath: captured.bundlePath,
  };
}

async function executeIntent(
  intent: TransactionIntent,
  plan: RollbackPlan,
  adapter: TransactionMutationAdapter,
): Promise<{ decision: "ALLOW" } | { decision: "DENY"; reason: string }> {
  if (intent.kind === "create") {
    const result = await adapter.create(intent.path, intent.content);
    return result.decision === "ALLOW" ? { decision: "ALLOW" } : result;
  }
  if (intent.kind === "replace") {
    const result = await adapter.replace(intent.path, intent.expectedSha256, intent.content);
    return result.decision === "ALLOW" ? { decision: "ALLOW" } : result;
  }
  if (intent.kind === "remove") {
    if (plan.kind !== "remove") return { decision: "DENY", reason: "ROLLBACK_PLAN_MISMATCH" };
    const result = await adapter.removeToQuarantine(intent.path, plan.quarantinePath, intent.expectedSha256);
    return result.decision === "ALLOW" ? { decision: "ALLOW" } : result;
  }
  const result = await adapter.move(intent.sourcePath, intent.destinationPath);
  return result.decision === "ALLOW" ? { decision: "ALLOW" } : result;
}
async function verifyPlan(plan: RollbackPlan, probe: FileProbe): Promise<boolean> {
  if (plan.kind === "remove") {
    if (await probe.exists(plan.path)) return false;
    if (!(await probe.exists(plan.quarantinePath))) return false;
    return sha256Bytes(await probe.read(plan.quarantinePath)) === plan.preSha256;
  }
  if (plan.kind === "move") {
    if (await probe.exists(plan.sourcePath)) return false;
    if (!(await probe.exists(plan.destinationPath))) return false;
    return sha256Bytes(await probe.read(plan.destinationPath)) === plan.postSha256;
  }
  if (!(await probe.exists(plan.path))) return false;
  return sha256Bytes(await probe.read(plan.path)) === plan.postSha256;
}

export async function applyTransaction(
  store: TransactionStore,
  transactionId: string,
  currentnessProvider: CurrentnessProvider,
  adapter: TransactionMutationAdapter,
  bundles: RollbackBundleStore,
  probe: FileProbe = NODE_FILE_PROBE,
): Promise<ApplyTransactionResult> {
  const record = store.get(transactionId);
  if (record === undefined) return { decision: "DENY", reason: "TRANSACTION_NOT_FOUND" };
  if (record.state !== "VALIDATED") return { decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" };

  const current = await currentnessProvider();
  if (!sameCurrentness(record.currentness, current)) return { decision: "DENY", reason: "STALE_TRANSACTION" };

  const transition = nextTransactionState(record.state, "apply");
  if (transition.decision !== "ALLOW") return transition;
  record.state = transition.state;
  const plans: RollbackPlan[] = [];
  try {
    for (const intent of record.intents) {
      const plan = await planForIntent(intent, bundles, probe);
      plans.push(plan);
      const result = await executeIntent(intent, plan, adapter);
      if (result.decision !== "ALLOW") throw new Error(result.reason);
      if (!(await verifyPlan(plan, probe))) throw new Error("POSTIMAGE_MISMATCH");
    }

    const completed = nextTransactionState(record.state, "apply_complete");
    if (completed.decision !== "ALLOW") throw new Error(completed.reason);
    record.state = completed.state;
    return { decision: "ALLOW", state: "APPLIED", rollbackPlans: Object.freeze([...plans]) };
  } catch {
    const rollbackRequired = nextTransactionState(record.state, "require_rollback");
    if (rollbackRequired.decision === "ALLOW") record.state = rollbackRequired.state;
    const rolledBack = await rollbackPlans(plans, bundles, probe);
    if (rolledBack.decision !== "ALLOW") {
      return { decision: "DENY", reason: rolledBack.reason };
    }
    const completedRollback = nextTransactionState(record.state, "rollback");
    if (completedRollback.decision === "ALLOW") record.state = completedRollback.state;
    return { decision: "DENY", reason: "APPLY_FAILED_ROLLED_BACK" };
  }
}
