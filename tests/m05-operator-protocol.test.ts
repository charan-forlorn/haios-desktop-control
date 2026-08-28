import { describe, expect, it } from "vitest";

import {
  OPERATOR_V1_TOOL_NAMES,
  operatorFoundationCapabilities,
  operatorFoundationStatus,
} from "../src/operator/protocol.js";

const EXPECTED = [
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
] as const;

const FORBIDDEN = [
  "write_file", "move_file", "delete", "unlink", "rm",
  "start_process", "kill_process", "force_terminate", "set_config_value",
  "filesystem_read", "project_test", "transaction_apply",
] as const;
describe("M05 Level B v1 protocol foundation", () => {
  it("defines the exact immutable 13-tool surface", () => {
    expect(OPERATOR_V1_TOOL_NAMES).toEqual(EXPECTED);
    expect(OPERATOR_V1_TOOL_NAMES).toHaveLength(13);
    expect(new Set(OPERATOR_V1_TOOL_NAMES).size).toBe(13);
    expect(Object.isFrozen(OPERATOR_V1_TOOL_NAMES)).toBe(true);
  });

  it.each(FORBIDDEN)("does not expose legacy/raw tool %s", (name) => {
    expect(OPERATOR_V1_TOOL_NAMES).not.toContain(name);
  });

  it("is fixed to READ_ONLY_EMERGENCY until isolation/promotion qualify", () => {
    expect(operatorFoundationStatus()).toEqual({
      protocol: "operator13",
      mode: "READ_ONLY_EMERGENCY",
      qualification: "M05_FOUNDATION_ONLY",
      mutationActive: false,
      destructive: "LOCKED",
    });
  });

  it("reports capability locks without implying qualification", () => {
    expect(operatorFoundationCapabilities()).toMatchObject({
      toolCount: 13,
      mutationActive: false,
      checkpointQualified: false,
      promotionQualified: false,
      s2Enabled: false,
      genericShell: false,
      genericExec: false,
    });
  });
});