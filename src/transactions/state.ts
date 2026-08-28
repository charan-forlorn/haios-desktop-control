import type { TransactionEvent, TransactionState } from "./types.js";
export type { TransactionEvent, TransactionState } from "./types.js";

export type TransactionTransition =
  | { readonly decision: "ALLOW"; readonly state: TransactionState }
  | { readonly decision: "DENY"; readonly reason: "INVALID_TRANSACTION_TRANSITION" };

const TRANSITIONS: Readonly<Record<string, TransactionState>> = Object.freeze({
  "OPEN:stage": "STAGED",
  "STAGED:stage": "STAGED",
  "STAGED:validate": "VALIDATED",
  "VALIDATED:apply": "APPLIED",
  "APPLIED:verify": "VERIFIED",
  "VERIFIED:promote": "PROMOTED",
  "APPLIED:require_rollback": "ROLLBACK_REQUIRED",
  "ROLLBACK_REQUIRED:rollback": "ROLLED_BACK",
});

export function nextTransactionState(state: TransactionState, event: string): TransactionTransition {
  const next = TRANSITIONS[`${state}:${event}`];
  return next === undefined
    ? { decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" }
    : { decision: "ALLOW", state: next };
}
