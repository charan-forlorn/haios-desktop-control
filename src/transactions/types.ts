export type TransactionState =
  | "OPEN"
  | "STAGED"
  | "VALIDATED"
  | "APPLYING"
  | "APPLIED"
  | "VERIFIED"
  | "PROMOTED"
  | "ROLLBACK_REQUIRED"
  | "ROLLED_BACK";

export type TransactionEvent =
  | "stage"
  | "validate"
  | "apply"
  | "apply_complete"
  | "verify"
  | "promote"
  | "require_rollback"
  | "rollback";

export interface TransactionCurrentness {
  readonly head: string;
  readonly branch: string;
  readonly trackedStateDigest: string;
}

export type TransactionIntent =
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | { readonly kind: "replace"; readonly path: string; readonly expectedSha256: string; readonly content: string }
  | { readonly kind: "move"; readonly sourcePath: string; readonly destinationPath: string }
  | { readonly kind: "remove"; readonly path: string; readonly expectedSha256: string };

export interface TransactionRecord {
  readonly id: string;
  state: TransactionState;
  readonly createdAt: string;
  readonly currentness: TransactionCurrentness;
  readonly intents: TransactionIntent[];
}

export type RollbackPlan =
  | { readonly kind: "create"; readonly path: string; readonly postSha256: string }
  | { readonly kind: "replace"; readonly path: string; readonly preSha256: string; readonly postSha256: string; readonly bundlePath: string }
  | { readonly kind: "move"; readonly sourcePath: string; readonly destinationPath: string; readonly preSha256: string; readonly postSha256: string; readonly bundlePath: string }
  | { readonly kind: "remove"; readonly path: string; readonly preSha256: string; readonly quarantinePath: string; readonly bundlePath: string };
