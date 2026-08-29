import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(process.cwd(), "scripts", "m10-preflight.ps1");
const executePath = join(process.cwd(), "scripts", "execute-m10-readonly-cutover.ps1");
const preflightQualifierPath = join(process.cwd(), "scripts", "qualify-m10-preflight.ps1");
const liveQualifierPath = join(process.cwd(), "scripts", "qualify-m10-live.ps1");

describe("M10 production preflight contract", () => {
  it("hard-binds production integration points and read-only inventory", async () => {
    const source = await readFile(scriptPath, "utf8");
    for (const marker of [
      "C:\\Workspace\\haios-operator-mcp\\docker-compose.operator.yml",
      "C:\\Workspace\\haios-operator-mcp\\docker-compose.operator-dedicated-tunnel.yml",
      "haios-operator-mcp",
      "haios-operator-dedicated-tunnel-client",
      "haios-tunnel-client",
      "Get-ContainerIntegrityDigest",
      "Sort-Object Destination,Type",
      "Get-ListenerIdentity 8768",
      "Get-ListenerIdentity 8769",
      "production-preimage.json",
    ]) expect(source).toContain(marker);
  });

  it("contains no production compose mutation commands", async () => {
    const source = await readFile(scriptPath, "utf8");
    for (const forbidden of [" compose up", " compose down", " compose restart", " compose rm", " compose create"])
      expect(source.toLowerCase()).not.toContain(forbidden);
  });

  it("limits ACL mutation to a disposable fixture and rejects broad principals", async () => {
    const source = await readFile(scriptPath, "utf8");
    for (const marker of [
      "acl-fixture-result.json",
      "SetAccessRuleProtection($true, $false)",
      "WellKnownSidType.WorldSid",
      "WellKnownSidType.BuiltinUsersSid",
      "WellKnownSidType.LocalSystemSid",
      "WellKnownSidType.BuiltinAdministratorsSid",
      "Remove-Item -LiteralPath $FixtureRoot -Recurse -Force",
    ]) expect(source).toContain(marker);
  });

  it("builds but never registers the exact scheduled-task definition", async () => {
    const source = await readFile(scriptPath, "utf8");
    for (const marker of [
      "HAIOS-M10-Operator-ReadOnly",
      "New-ScheduledTaskAction",
      "New-ScheduledTaskTrigger",
      "New-ScheduledTaskPrincipal",
      "New-ScheduledTaskSettingsSet",
      "New-ScheduledTask",
      "Interactive",
      "task-scheduler-feasibility.json",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("Register-ScheduledTask");
  });

  it("models and registers an unlimited, battery-tolerant supervisor while preserving restart policy", async () => {
    const [preflight, execute] = await Promise.all([
      readFile(scriptPath, "utf8"),
      readFile(executePath, "utf8"),
    ]);
    for (const source of [preflight, execute]) {
      for (const marker of [
        "-AllowStartIfOnBatteries",
        "-DontStopIfGoingOnBatteries",
        "-ExecutionTimeLimit ([TimeSpan]::Zero)",
        "-RestartCount 3",
        "-RestartInterval (New-TimeSpan -Minutes 1)",
      ]) expect(source).toContain(marker);
    }
    for (const marker of [
      "disallow_start_if_on_batteries",
      "stop_if_going_on_batteries",
      "execution_time_limit",
      "restart_count",
      "restart_interval",
      "Settings.DisallowStartIfOnBatteries",
      "Settings.StopIfGoingOnBatteries",
    ]) expect(preflight).toContain(marker);
  });

  it("fails closed when preflight or live task longevity settings drift", async () => {
    const [preflightQualifier, liveQualifier] = await Promise.all([
      readFile(preflightQualifierPath, "utf8"),
      readFile(liveQualifierPath, "utf8"),
    ]);
    expect(preflightQualifier).toContain("M10_TASK_LONGEVITY_DRIFT");
    expect(liveQualifier).toContain("M10_LIVE_TASK_LONGEVITY_DRIFT");
    for (const marker of [
      "disallow_start_if_on_batteries",
      "stop_if_going_on_batteries",
      "execution_time_limit",
      "restart_count",
      "restart_interval",
    ]) expect(preflightQualifier).toContain(marker);
    for (const marker of [
      "DisallowStartIfOnBatteries",
      "StopIfGoingOnBatteries",
      "ExecutionTimeLimit",
      "RestartCount",
      "RestartInterval",
    ]) expect(liveQualifier).toContain(marker);
  });

  it("dry-renders only the intended operator and dedicated-tunnel deltas", async () => {
    const source = await readFile(scriptPath, "utf8");
    for (const marker of [
      "compose-render-result.json",
      "!reset []",
      "!override",
      "host.docker.internal:8769/mcp",
      "/run/secrets/m10-operator-api-key",
      "MCP_EXTRA_HEADERS",
      "X-API-Key: file:/run/secrets/m10-operator-api-key",
      "docker.exe compose",
      " config",
    ]) expect(source).toContain(marker);
  });
});

// M10 production supervision must never bypass the strict M10 wrapper.
describe("M10 supervisor launcher binding", () => {
  it("points Task Scheduler only at the M10 read-only launcher", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("run-m10-readonly-supervisor.mjs");
    expect(source).not.toContain("-Argument `\"$launcher");
    expect(source).not.toContain("run-m09-host-runtime.mjs");
  });
});
