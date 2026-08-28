import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const executePath = join(process.cwd(), "scripts", "execute-m10-readonly-cutover.ps1");
const rollbackPath = join(process.cwd(), "scripts", "rollback-m10-readonly-cutover.ps1");
const launcherPath = join(process.cwd(), "scripts", "run-m10-readonly-runtime.mjs");

describe("M10 sealed cutover transaction contract", () => {
  it("hard-binds every production integration point", async () => {
    const source = await readFile(executePath, "utf8");
    for (const marker of [
      "C:\\Workspace\\haios-operator-mcp\\docker-compose.operator.yml",
      "C:\\Workspace\\haios-operator-mcp\\docker-compose.operator-dedicated-tunnel.yml",
      "C:\\Workspace\\haios-desktop-control-runtime",
      "HAIOS\\M10",
      "HAIOS-M10-Operator-ReadOnly",
      "haios-operator-mcp",
      "haios-operator-dedicated-tunnel-client",
      "haios-tunnel-client",
      "8769",
    ]) expect(source).toContain(marker);
  });

  it("uses the strict M10 launcher and wrapper", async () => {
    const launcher = await readFile(launcherPath, "utf8");
    expect(launcher).toContain("validateM10ReadOnlyProductionConfig");
    expect(launcher).toContain("m10-production-config.js");
    expect(launcher).not.toContain("M09_TEST_ONLY");
    const source = await readFile(executePath, "utf8");
    expect(source).toContain("run-m10-readonly-runtime.mjs");
    expect(source).not.toContain("run-m09-host-runtime.mjs");
  });

  it("requires sealed currentness before the first mutating command", async () => {
    const source = await readFile(executePath, "utf8");
    for (const marker of [
      "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER",
      "executor_sha256",
      "rollback_sha256",
      "candidate_manifest_sha256",
      "parent_cert_sha256",
      "operator_compose_sha256",
      "dedicated_compose_sha256",
      "container_digests",
      "listener_8768",
      "listener_8769",
      "M10_CUTOVER_AUTHORITY_CURRENTNESS_FAILED",
    ]) expect(source).toContain(marker);
    const gate = source.indexOf("M10_CUTOVER_AUTHORITY_CURRENTNESS_FAILED");
    const firstMutation = source.indexOf("M10_MUTATION_BEGIN");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThan(gate);
  });

  it("creates the journal before mutation and preserves exact forward ordering", async () => {
    const source = await readFile(executePath, "utf8");
    const journal = source.indexOf("M10_JOURNAL_READY");
    const begin = source.indexOf("M10_MUTATION_BEGIN");
    const portHandoff = source.indexOf("M10_OLD_OPERATOR_HOST_PORT_REMOVED");
    const deployment = source.indexOf("M10_DEPLOYMENT_WORKTREE_READY");
    const task = source.indexOf("M10_SCHEDULED_TASK_STARTED");
    const host = source.indexOf("M10_HOST_8769_EMERGENCY_READY");
    const tunnel = source.indexOf("M10_DEDICATED_TUNNEL_SWITCHED");
    expect(journal).toBeLessThan(begin);
    expect(begin).toBeLessThan(portHandoff);
    expect(portHandoff).toBeLessThan(deployment);
    expect(deployment).toBeLessThan(task);
    expect(task).toBeLessThan(host);
    expect(host).toBeLessThan(tunnel);
  });

  it("binds rollback to exact preimages and refuses ambiguous drift", async () => {
    const source = await readFile(rollbackPath, "utf8");
    for (const marker of [
      "M10_ROLLBACK_CURRENTNESS_BLOCKED",
      "dedicated_compose_sha256",
      "operator_compose_sha256",
      "execution_journal_sha256",
      "Stop-ScheduledTask",
      "Unregister-ScheduledTask",
      "git worktree remove",
      "READ_ONLY_EMERGENCY",
      "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_ROLLED_BACK_TO_CERTIFIED_M09_READ_ONLY_STATE",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("docker system prune");
    expect(source).not.toContain("docker compose down");
  });

  it("does not accept caller-controlled production resource names or paths", async () => {
    const execute = await readFile(executePath, "utf8");
    const rollback = await readFile(rollbackPath, "utf8");
    const executeParams = execute.match(/^param\([\s\S]*?\)\r?\n/u)?.[0] ?? "";
    const rollbackParams = rollback.match(/^param\([\s\S]*?\)\r?\n/u)?.[0] ?? "";
    for (const forbidden of [
      "$OperatorCompose", "$DedicatedCompose", "$DeploymentRoot", "$TaskName",
      "$ContainerName", "$Port", "$SecretPath", "$Command",
    ]) {
      expect(executeParams).not.toContain(forbidden);
      expect(rollbackParams).not.toContain(forbidden);
    }
  });

  it("provides a hard-bound synthetic fixture path for non-production transaction testing", async () => {
    const execute = await readFile(executePath, "utf8");
    const rollback = await readFile(rollbackPath, "utf8");
    expect(execute).toContain("runtime\\m10-cutover-fixture");
    expect(execute).toContain("SYNTHETIC_M10_CUTOVER_TEST_ONLY");
    expect(rollback).toContain("runtime\\m10-cutover-fixture");
    expect(rollback).toContain("SYNTHETIC_M10_CUTOVER_TEST_ONLY");
  });
});


describe("M10 post-cutover live qualifier contract", () => {
  it("is read-only and requires durable dedicated-route MCP proof", async () => {
    const path = join(process.cwd(), "scripts", "qualify-m10-live.ps1");
    const source = await readFile(path, "utf8");
    for (const marker of [
      "dedicated-route-proof.json",
      "M10_DEDICATED_ROUTE_PROOF_MISSING",
      "exact_13_tools",
      "READ_ONLY_EMERGENCY",
      "HAIOS-M10-Operator-ReadOnly",
      "haios-tunnel-client",
      "haios-operator-dedicated-tunnel-client",
      "haios-operator-mcp",
      "secret_acl_pass",
      "M10_LIVE_READ_ONLY_QUALIFICATION_PASS",
    ]) expect(source).toContain(marker);
    for (const forbidden of [
      "Register-ScheduledTask", "Unregister-ScheduledTask", "Start-ScheduledTask", "Stop-ScheduledTask",
      " compose up", " compose down", "docker rm", "Remove-Item -LiteralPath $StateRoot",
    ]) expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});
