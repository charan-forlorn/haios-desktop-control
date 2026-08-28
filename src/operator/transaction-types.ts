export type OperatorTransactionState =
  | "OPEN"
  | "STAGED"
  | "VALIDATED"
  | "APPLIED"
  | "CHECKPOINTED"
  | "PROMOTED"
  | "ROLLED_BACK";

export type OperatorTransactionIntent =
  | { readonly kind: "create"; readonly relPath: string; readonly contentBase64: string }
  | {
      readonly kind: "patch";
      readonly relPath: string;
      readonly preimageSha256: string;
      readonly newContentBase64: string;
    }
  | {
      readonly kind: "move";
      readonly fromRel: string;
      readonly toRel: string;
      readonly preimageSha256: string;
    }
  | { readonly kind: "remove"; readonly relPath: string; readonly preimageSha256: string };

export interface OperatorTransactionRecord {
  readonly txId: string;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseHeadSha: string;
  readonly createdAt: string;
  readonly state: OperatorTransactionState;
  readonly intents: readonly OperatorTransactionIntent[];
  readonly checkpointId?: string;
}
