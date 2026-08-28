import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateM10ReadOnlyProductionConfig } from "../src/operator/m10-production-config.js";

const qualifierPath = join(process.cwd(), "scripts", "qualify-m10-preflight.ps1");
const executePath = join(process.cwd(), "scripts", "execute-m10-readonly-cutover.ps1");
const rollbackPath = join(process.cwd(), "scripts", "rollback-m10-readonly-cutover.ps1");
const parityPath = join(process.cwd(), "scripts", "live-m10-readonly-parity.mjs");

function validConfig(): Record<string, unknown> {
  return { apiKeyFile: "C:\\state\\operator-api-key", worktreeRoot: "C:\\runtime\\worktrees", allowedProjects: {}, port: 8769, mode: "READ_ONLY_EMERGENCY" };
}

describe("M10 adversarial pre-live boundary", () => {
  it("denies ACTIVE, activation scope, nonempty projects, and alternate production ports", () => {
    for (const value of [
      { ...validConfig(), mode: "ACTIVE", activationScope: "M09_TEST_ONLY" },
      { ...validConfig(), activationScope: "M09_TEST_ONLY" },
      { ...validConfig(), allowedProjects: { demo: "C:\\demo" } },
      { ...validConfig(), port: 8774 },
    ]) expect(() => validateM10ReadOnlyProductionConfig(value)).toThrow("M10_PRODUCTION_CONFIG_DENIED");
  });

  it("qualifier fail-closes on identity, runtime, collision, and authority drift", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "POWERSHELL_7_REQUIRED", "WORKTREE_NOT_CLEAN", "M09_FINAL_CERTIFICATION_HASH_DRIFT",
      "REMOTE_MAIN_DRIFT", "M10_PREEXISTING_OPERATOR_NOT_EMERGENCY", "M10_LISTENER_8768_MISSING",
      "M10_LISTENER_8769_MISSING", "M10_PORT_8774_NOT_FREE", "M10_PORT_18774_NOT_FREE",
      "M10_DEPLOYMENT_ROOT_COLLISION", "M10_STATE_ROOT_COLLISION", "M10_TASK_COLLISION",
      "M10_PREEXISTING_CONTAINER_RESIDUE", "M10_EXECUTOR_HASH_DRIFT", "M10_ROLLBACK_HASH_DRIFT",
      "M10_SHARED_TUNNEL_DRIFT", "M10_SECURE_8768_DRIFT",
    ]) expect(source).toContain(marker);
  });
  it("blocks pre-live qualification when either long-lived tunnel is not currently healthy", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "haios-tunnel-client", "haios-operator-dedicated-tunnel-client",
      "Get-ContainerHealthStatus", "M10_SHARED_TUNNEL_READINESS_FAILED",
      "M10_DEDICATED_TUNNEL_READINESS_FAILED", "m10-operational-readiness-blocker.json",
    ]) expect(source).toContain(marker);
  });

  it("seals exact executor, rollback, preflight, live verifier, manifest and Human decision", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "execute-m10-readonly-cutover.ps1", "rollback-m10-readonly-cutover.ps1",
      "m10-preflight.ps1", "qualify-m10-live.ps1", "run-m10-readonly-runtime.mjs",
      "candidate_manifest_sha256", "executor_sha256", "rollback_sha256",
      "preflight_sha256", "live_qualifier_sha256", "strict_launcher_sha256",
      "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER",
    ]) expect(source).toContain(marker);
  });

  it("emits only a no-mutation production decision envelope", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "production_mutation_performed=$false", "task_created=$false",
      "secret_created=$false", "tunnel_reconfigured=$false",
      "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_READY_FOR_EXACT_HUMAN_READ_ONLY_CUTOVER_DECISION",
    ]) expect(source).toContain(marker);
  });
});
