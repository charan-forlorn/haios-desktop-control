import { describe, expect, it } from "vitest";

import {
  MUTATE_TOOL_DEFINITIONS,
  classifyGatewayTool,
} from "../src/capabilities.js";
import { authorizeTool } from "../src/policy.js";
import {
  nextTransactionState,
  type TransactionState,
} from "../src/transactions/state.js";

const MUTATE_NAMES = [
  "transaction_begin",
  "transaction_stage_create",
  "transaction_stage_replace",
  "transaction_stage_move",
  "transaction_validate",
  "transaction_apply",
  "transaction_rollback",
  "transaction_status",
] as const;
describe("M03 mutation capability registry", () => {
  it("defines exactly eight immutable MUTATE wrappers", () => {
    expect(MUTATE_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual(MUTATE_NAMES);
    expect(Object.isFrozen(MUTATE_TOOL_DEFINITIONS)).toBe(true);
    expect(MUTATE_TOOL_DEFINITIONS.every(Object.isFrozen)).toBe(true);
  });

  it.each(MUTATE_NAMES)("classifies %s as MUTATE with class-bound authorization", (name) => {
    expect(classifyGatewayTool(name)).toBe("MUTATE");
    expect(authorizeTool(name)).toBe("DENY");
    expect(authorizeTool(name, "MUTATE")).toBe("ALLOW");
    expect(authorizeTool(name, "READ")).toBe("DENY");
    expect(authorizeTool(name, "EXECUTE")).toBe("DENY");
  });

  it.each(["write_file", "edit_block", "move_file", "start_process", "kill_process", "set_config_value"])(
    "keeps raw capability %s unavailable",
    (name) => expect(classifyGatewayTool(name)).toBe("UNKNOWN"),
  );
});
describe("M03 transaction state machine", () => {
  const valid: ReadonlyArray<[TransactionState, string, TransactionState]> = [
    ["OPEN", "stage", "STAGED"],
    ["STAGED", "stage", "STAGED"],
    ["STAGED", "validate", "VALIDATED"],
    ["VALIDATED", "apply", "APPLYING"],
    ["APPLYING", "apply_complete", "APPLIED"],
    ["APPLYING", "require_rollback", "ROLLBACK_REQUIRED"],
    ["APPLIED", "verify", "VERIFIED"],
    ["VERIFIED", "promote", "PROMOTED"],
    ["APPLIED", "require_rollback", "ROLLBACK_REQUIRED"],
    ["ROLLBACK_REQUIRED", "rollback", "ROLLED_BACK"],
  ];

  it.each(valid)("allows %s --%s--> %s", (from, event, expected) => {
    expect(nextTransactionState(from, event)).toEqual({ decision: "ALLOW", state: expected });
  });

  it.each([
    ["OPEN", "apply"],
    ["OPEN", "validate"],
    ["STAGED", "apply"],
    ["VALIDATED", "stage"],
    ["PROMOTED", "apply"],
    ["ROLLED_BACK", "rollback"],
  ] as const)("fails closed for invalid transition %s/%s", (from, event) => {
    expect(nextTransactionState(from, event)).toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" });
  });
});
