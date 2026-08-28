import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(process.cwd(), "scripts", "m10-preflight.ps1");

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
