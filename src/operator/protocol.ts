export type OperatorMode = "ACTIVE" | "READ_ONLY_EMERGENCY" | "DISABLED";

export const OPERATOR_V1_TOOL_NAMES = Object.freeze([
  "operator_status",
  "operator_capabilities",
  "operator_begin_transaction",
  "operator_stage_patch",
  "operator_stage_create",
  "operator_stage_move",
  "operator_stage_remove",
  "operator_validate_transaction",
  "operator_apply_transaction",
  "operator_run_task",
  "operator_rollback_transaction",
  "operator_git_checkpoint",
  "operator_promote_transaction",
] as const);

export type OperatorV1ToolName = (typeof OPERATOR_V1_TOOL_NAMES)[number];

export function operatorFoundationStatus() {
  return Object.freeze({
    protocol: "operator13" as const,
    mode: "READ_ONLY_EMERGENCY" as const,
    qualification: "M05_FOUNDATION_ONLY" as const,
    mutationActive: false as const,
    destructive: "LOCKED" as const,
  });
}
export function operatorFoundationCapabilities() {
  return Object.freeze({
    toolCount: OPERATOR_V1_TOOL_NAMES.length,
    taskRegistry: "M05_TYPED_FOUNDATION" as const,
    mutationActive: false as const,
    checkpointQualified: false as const,
    promotionQualified: false as const,
    s2Enabled: false as const,
    genericShell: false as const,
    genericExec: false as const,
  });
}
