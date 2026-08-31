import { createHash } from "node:crypto";

import { B6_STAGE_PROJECTS, resolveB6Project, type B6ProjectId, type B6Stage } from "./b6-project-expansion.js";

export const B6_QUALIFICATION_SCHEMA = "HAIOS_B6_BOUNDED_ADMISSION_QUALIFICATION_R1" as const;

export interface B6QualificationRecipe {
  readonly schema: typeof B6_QUALIFICATION_SCHEMA;
  readonly stage: B6Stage;
  readonly targetProjectId: B6ProjectId;
  readonly deniedNextProjectId: B6ProjectId | undefined;
  readonly taskId: "node.test.run";
  readonly sandboxProfile: "S0";
  readonly networkAuthority: "NONE";
  readonly fixtureRelPath: "test/b6-admission-fixture.test.mjs";
  readonly requiredAssertions: readonly string[];
  readonly recipeSha256: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(stableJson(value), "utf8").digest("hex"); }

/**
 * Fixed-recipe qualification is intentionally data, not model-generated shell/argv. The live
 * orchestrator executes these steps through the exact 13-tool protocol and records its evidence.
 */
export function createB6QualificationRecipe(stage: B6Stage, targetProjectId: B6ProjectId): B6QualificationRecipe {
  const admitted = B6_STAGE_PROJECTS[stage];
  if (!admitted.includes(targetProjectId)) throw new Error("B6_QUALIFICATION_TARGET_NOT_ADMITTED");
  const deniedNextProjectId = stage === "SKILL_FABRIC" ? "hermes-os" : undefined;
  // Resolve now so a changed mapping cannot be represented as a recipe with the same identity.
  resolveB6Project(stage, targetProjectId);
  const unsigned = Object.freeze({ schema: B6_QUALIFICATION_SCHEMA, stage, targetProjectId, deniedNextProjectId,
    taskId: "node.test.run" as const, sandboxProfile: "S0" as const, networkAuthority: "NONE" as const,
    fixtureRelPath: "test/b6-admission-fixture.test.mjs" as const,
    requiredAssertions: Object.freeze(["exact_13_tools", "admitted_target", "non_admitted_denied", "isolated_transaction",
      "temporary_node_test_fixture", "effect_policy_verified", "rollback", "canonical_head_unchanged", "canonical_status_clean", "owned_residue_zero"]) });
  return Object.freeze({ ...unsigned, recipeSha256: digest(unsigned) });
}
