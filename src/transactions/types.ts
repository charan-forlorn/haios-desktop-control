export type TransactionState =
  | "OPEN"
  | "STAGED"
  | "VALIDATED"
  | "APPLIED"
  | "VERIFIED"
  | "PROMOTED"
  | "ROLLBACK_REQUIRED"
  | "ROLLED_BACK";

export type TransactionEvent =
  | "stage"
  | "validate"
  | "apply"
  | "verify"
  | "promote"
  | "require_rollback"
  | "rollback";
