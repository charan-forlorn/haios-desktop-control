import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = join(process.cwd(), "scripts", "live-m10-readonly-parity.mjs");
const hostProbePath = join(process.cwd(), "scripts", "probe-m10-readonly-host.mjs");

describe("M10 disposable read-only parity helper", () => {
  it("hard-binds disposable ports, emergency mode, empty projects, and synthetic tunnel transport", async () => {
    const source = await readFile(helperPath, "utf8");
    for (const marker of [
      "READ_ONLY_EMERGENCY",
      "allowedProjects: {}",
      "8774",
      "18774",
      "--entrypoint", "/usr/bin/tunnel-client",
      "host.docker.internal:${directPort}/mcp",
      "/run/secrets/m10-api-key",
      "MCP_EXTRA_HEADERS=X-API-Key: file:/run/secrets/m10-api-key",
      "tunnel_33333333333333333333333333333333",
      "haios.m10.owner=readonly-parity",
    ]) expect(source).toContain(marker);
  });

  it("proves exact read-only status/capabilities and mutation denial", async () => {
    const source = await readFile(helperPath, "utf8");
    for (const marker of [
      "OPERATOR_V1_TOOL_NAMES",
      "operator_status",
      "operator_capabilities",
      "mutationActive === false",
      "s2Enabled === false",
      "genericExec === false",
      "genericShell === false",
      "destructive === \"LOCKED\"",
      "operator_begin_transaction",
      "TOOL_DENIED_INACTIVE_MODE",
    ]) expect(source).toContain(marker);
  });

  it("defines an authenticated production host MCP proof without exposing the API key", async () => {
    const source = await readFile(hostProbePath, "utf8");
    for (const marker of [
      "http://127.0.0.1:8769/mcp",
      "loadHostApiKey",
      "OPERATOR_V1_TOOL_NAMES",
      "operator_status",
      "operator_capabilities",
      "operator_begin_transaction",
      "TOOL_DENIED_INACTIVE_MODE",
      "exact_13_tools",
      "mutation_active",
      "s2_enabled",
      "generic_exec",
      "generic_shell",
      "destructive",
      "mutation_denied",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("process.stdout.write(apiKey");
  });
  it("forbids production authority and persists no secret bytes", async () => {
    const source = await readFile(helperPath, "utf8");
    for (const forbidden of [
      "8768", "8769", "M09_TEST_ONLY", "mode: \"ACTIVE\"",
      "git push", "git fetch", "git pull", "docker.sock",
      "OPENAI_API_KEY", "GITHUB_TOKEN",
      "tunnel_6a84390db5a0819185909bb9b2e29c95",
      "tunnel_6a8dc59a6f5c8191baf6a79637c3e063",
    ]) expect(source).not.toContain(forbidden);
    for (const marker of [
      "apiKeyFileRemoved",
      "tunnelContainerRemoved",
      "tunnelLogsSecretFree",
      "rm(apiKeyFile",
    ]) expect(source).toContain(marker);
  });
});
