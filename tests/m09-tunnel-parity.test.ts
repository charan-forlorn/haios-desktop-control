import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const helper = join(process.cwd(), "scripts", "live-m09-host-parity.mjs");
const syntheticTunnel = "tunnel_22222222222222222222222222222222";

describe("M09 file-backed tunnel dev-proxy parity contract", () => {
  it("pins the dev-proxy image, synthetic tunnel, host target, and bounded disposable runtime", async () => {
    const source = await readFile(helper, "utf8");
    for (const marker of [
      "ghcr.io/openai/tunnel-client:v0.0.11",
      '"dev", "proxy"',
      '"--entrypoint", "/usr/bin/tunnel-client"',
      "host.docker.internal:${directPort}/mcp",
      syntheticTunnel,
      "18773",
      '"--duration", "45s"',
      "haios-m09-tunnel-parity-",
      "haios.m09.owner=host-parity",
    ]) expect(source).toContain(marker);
  });

  it("uses only file-backed X-API-Key with a read-only secret mount", async () => {
    const source = await readFile(helper, "utf8");
    expect(source).toContain("MCP_EXTRA_HEADERS=X-API-Key: file:/run/secrets/m09-api-key");
    expect(source).toContain("target=/run/secrets/m09-api-key,readonly");
    expect(source).toContain("apiKeyFile");
    expect(source).not.toContain("MCP_EXTRA_HEADERS=X-API-Key: ${apiKey}");
  });

  it("connects the official SDK through local proxy ingress and records read-only parity facts", async () => {
    const source = await readFile(helper, "utf8");
    for (const marker of [
      "StreamableHTTPClientTransport",
      "tunnelProxyUrl",
      "tunnelExactToolSurface",
      "tunnelStatusPassed",
      "tunnelCapabilitiesPassed",
      "tunnelParityPassed",
      "tunnelContainerRemoved",
      "tunnelLogsSecretFree",
      "operator_status",
      "operator_capabilities",
    ]) expect(source).toContain(marker);
  });

  it("contains no real control-plane authority or non-synthetic tunnel id", async () => {
    const source = await readFile(helper, "utf8");
    for (const forbidden of [
      "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "--control-plane.api-key",
      "--control-plane.base-url", "--control-plane.poll-channel", "channel=main",
    ]) expect(source).not.toContain(forbidden);
    const ids = source.match(/tunnel_[0-9a-f]{32}/g) ?? [];
    expect([...new Set(ids)]).toEqual([syntheticTunnel]);
  });
});
