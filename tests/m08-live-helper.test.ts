import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const helper = join(process.cwd(), "scripts", "live-m08-qualification.mjs");

describe("M08 disposable ACTIVE live helper contract", () => {
  it("uses the qualified runtime factory and routes execution through MCP", async () => {
    const source = await readFile(helper, "utf8");
    for (const marker of [
      "createGatewayServer", "createQualifiedOperatorControlRuntime", "LocalOperatorGit",
      "registryPath", "effectPolicyPath",
      'protocolMode: "operator13"', 'operatorMode: "ACTIVE"', "operatorRuntime",
      "Client", "StreamableHTTPClientTransport", "operator_begin_transaction",
      "operator_stage_patch", "operator_validate_transaction", "operator_apply_transaction",
      "operator_run_task", "operator_git_checkpoint", "operator_promote_transaction",
      "operator_rollback_transaction",
    ]) expect(source).toContain(marker);
    expect(source).toContain("127.0.0.1");
    expect(source).toContain("8772");
  });
  it("contains separate promotion, rollback, and stale-CAS scenarios with no forbidden remote authority", async () => {
    const source = await readFile(helper, "utf8");
    for (const marker of [
      "promotionPassed", "rollbackPassed", "staleCasDenied",
      "canonicalUnchangedBeforePromotion", "worktreeResidueZero",
    ]) expect(source).toContain(marker);
    for (const forbidden of [
      "git push", "git fetch", "git pull", "docker pull",
      "OPENAI_API_KEY", "GITHUB_TOKEN", "8768/mcp", "8769/mcp",
    ]) expect(source).not.toContain(forbidden);
  });
});
