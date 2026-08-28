import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const helper = join(process.cwd(), "scripts", "live-m09-host-parity.mjs");

describe("M09 direct host ACTIVE helper contract", () => {
  it("uses the M09 host factory, temporary key file, exact 13-tool MCP flow, and explicit direct port", async () => {
    const source = await readFile(helper, "utf8");
    for (const marker of [
      "createHostOperatorRuntime", "LocalOperatorGit", "randomBytes", "apiKeyFile",
      "directPort", 'mode: "ACTIVE"', 'activationScope: "M09_TEST_ONLY"',
      "Client", "StreamableHTTPClientTransport", "operator_begin_transaction",
      "operator_stage_patch", "operator_validate_transaction", "operator_apply_transaction",
      "operator_run_task", "project.test", "operator_git_checkpoint",
      "operator_promote_transaction", "operator_rollback_transaction",
    ]) expect(source).toContain(marker);
    expect(source).toContain("OPERATOR_V1_TOOL_NAMES");
  });

  it("contains promotion, rollback, stale-CAS, canonical-currentness, and cleanup facts", async () => {
    const source = await readFile(helper, "utf8");
    for (const marker of [
      "exactToolSurface", "activeStatusPassed", "promotionPassed", "rollbackPassed",
      "staleCasDenied", "stalePromotionNoMutation", "canonicalUnchangedBeforePromotion",
      "taskPassed", "worktreeResidueZero", "apiKeyFileRemoved",
    ]) expect(source).toContain(marker);
    expect(source).toContain("rm(apiKeyFile");
  });

  it("contains no production, remote Git, Docker-socket, real-tunnel, or cloud credential authority", async () => {
    const source = await readFile(helper, "utf8");
    for (const forbidden of [
      "git push", "git fetch", "git pull", "docker pull", "docker.sock",
      "OPENAI_API_KEY", "GITHUB_TOKEN", "CONTROL_PLANE_API_KEY",
      "8768/mcp", "8769/mcp", "tunnel_0", "cloudflare.com",
    ]) expect(source).not.toContain(forbidden);
  });
});
