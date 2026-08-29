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
  it("uses functional tunnel readiness and records Docker health only as an observation", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "Get-TunnelFunctionalReadiness", "healthz_pass", "backend_reachable",
      "control_plane_poll_recent", "docker_health_observation", "commands_poll_last_successful_timestamp_seconds",
      "M10_SHARED_TUNNEL_FUNCTIONAL_READINESS_FAILED", "M10_DEDICATED_TUNNEL_FUNCTIONAL_READINESS_FAILED",
      "m10-operational-readiness-blocker.json",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain('$SharedTunnelHealth -ne "healthy" -or $DedicatedTunnelHealth -ne "healthy"');
  });

  it("independently proves deployment byte reproducibility before sealing Human authority", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "m10-deployment-byte-reproducibility.json",
      "M10_DEPLOYMENT_PROOF_MANIFEST_DRIFT",
      "M10_DEPLOYMENT_PROOF_INDEX_DRIFT",
      "M10_DEPLOYMENT_PROOF_WORKTREE_DRIFT",
      "M10_DEPLOYMENT_BYTE_REPRODUCIBILITY_PASS",
    ]) expect(source).toContain(marker);
  });
  it("seals exact executor, rollback, preflight, live verifier, manifest and Human decision", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [
      "execute-m10-readonly-cutover.ps1", "rollback-m10-readonly-cutover.ps1",
      "m10-preflight.ps1", "qualify-m10-live.ps1", "run-m10-readonly-runtime.mjs",
      "run-m10-readonly-supervisor.mjs",
      "candidate_manifest_sha256", "executor_sha256", "rollback_sha256",
      "preflight_sha256", "live_qualifier_sha256", "strict_launcher_sha256",
      "strict_supervisor_sha256",
      "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER",
    ]) expect(source).toContain(marker);
  });

  it("pins deterministic mixed checkout semantics without changing historical byte identities", async () => {
    const attrs = await readFile(join(process.cwd(), ".gitattributes"), "utf8").catch(() => "");
    for (const marker of [
      "* text=auto eol=crlf",
      ".gitattributes text eol=lf",
      "docs/superpowers/plans/2026-08-28-m10-* text eol=lf",
      "docs/superpowers/specs/2026-08-28-m10-* text eol=lf",
      "scripts/*m10* text eol=lf",
      "src/operator/host-runtime.ts text eol=lf",
      "src/operator/m10-production-config.ts text eol=lf",
      "tests/m10-* text eol=lf",
      "tests/m09-host-runtime.test.ts text eol=lf",
    ]) expect(attrs).toContain(marker);
  });

  it("fail-closes rollback on missing recovery bindings and preservation drift", async () => {
    const qualifier = await readFile(qualifierPath, "utf8");
    const rollback = await readFile(rollbackPath, "utf8");
    for (const marker of [
      "dedicated_control_key_file", "dedicated_control_key_file_sha256", "shared_tunnel_sha256",
    ]) expect(qualifier).toContain(marker);
    const production = rollback.slice(rollback.indexOf("if ((Get-Sha256 $OperatorCompose)"));
    for (const marker of [
      "M10_DEDICATED_CONTROL_KEY_BINDING_MISSING", "M10_DEDICATED_CONTROL_KEY_DRIFT",
      "M10_ROLLBACK_8769_NOT_FREE", "M10_DEDICATED_RESTORE_ROUTE_FAILED",
      "M10_DEDICATED_RESTORE_HEALTH_FAILED", "M10_ROLLBACK_SHARED_TUNNEL_DRIFT", "M10_ROLLBACK_8768_DRIFT",
    ]) expect(production).toContain(marker);
    const routeProof = production.indexOf("M10_DEDICATED_RESTORE_ROUTE_FAILED");
    const healthProof = production.indexOf("M10_DEDICATED_RESTORE_HEALTH_FAILED");
    const dedicatedTrue = production.indexOf("$RollbackResult.dedicated_restored=$true");
    const sharedProof = production.lastIndexOf("M10_ROLLBACK_SHARED_TUNNEL_DRIFT");
    const secureProof = production.lastIndexOf("M10_ROLLBACK_8768_DRIFT");
    const terminal = production.indexOf("HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_ROLLED_BACK_TO_CERTIFIED_M09_READ_ONLY_STATE");
    expect(dedicatedTrue).toBeGreaterThan(routeProof);
    expect(dedicatedTrue).toBeGreaterThan(healthProof);
    expect(terminal).toBeGreaterThan(sharedProof);
    expect(terminal).toBeGreaterThan(secureProof);
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
