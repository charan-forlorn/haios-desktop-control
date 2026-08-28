import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { createOperatorControlRuntime, dispatchOperatorControlTool } from "../src/operator/control-runtime.js";
import { loadTaskRegistryV2 } from "../src/operator/task-contract-v2.js";
import { loadTaskEffectPolicy } from "../src/operator/task-effects.js";

async function runtimeFixture() {
  const registry = await loadTaskRegistryV2("task-registry.m07.json");
  const effects = await loadTaskEffectPolicy("task-effects.m07.json");
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const allow = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return { decision: "ALLOW" as const, state: "APPLIED", transaction: { txId: "txn_test" } };
  };
  const transactions = {
    begin: allow("begin"), stagePatch: allow("stagePatch"), stageCreate: allow("stageCreate"),
    stageMove: allow("stageMove"), stageRemove: allow("stageRemove"), validate: allow("validate"),
    apply: allow("apply"), rollback: allow("rollback"), checkpoint: allow("checkpoint"),
    promote: allow("promote"), status: allow("status"),
  };
  const tasks = { run: async (request: any) => { calls.push({ name: "run", args: [request] }); return { decision: "ALLOW" as const }; } };
  return { runtime: createOperatorControlRuntime({ transactions, tasks, registry, effects }), registry, calls };
}

describe("M08 adversarial authority boundaries", () => {
  it.each(["mode", "executable", "shell", "cwd", "env", "expectedRegistrySha256", "s2", "remote", "extra"])(
    "rejects caller-added operator_run_task field %s before task dispatch", async (field) => {
      const fx = await runtimeFixture();
      const args: Record<string, unknown> = { txId: "txn_test", taskId: "project.test", params: {}, [field]: field === "env" ? { TOKEN: "x" } : "forbidden" };
      const result = await dispatchOperatorControlTool("operator_run_task", args, fx.runtime);
      expect(result).toMatchObject({ capabilityClass: "EXECUTE", result: { decision: "DENY", reason: "OPERATOR_INPUT_FIELDS_DENIED" } });
      expect(fx.calls).toHaveLength(0);
    },
  );

  it("server-binds the exact qualified M07 registry digest", async () => {
    const fx = await runtimeFixture();
    const result = await dispatchOperatorControlTool("operator_run_task", { txId: "txn_test", taskId: "project.test", params: {} }, fx.runtime);
    expect(result.result).toMatchObject({ decision: "ALLOW" });
    const call = fx.calls.find((entry) => entry.name === "run");
    expect(call).toBeDefined();
    expect((call!.args[0] as any).expectedRegistrySha256).toBe(fx.registry.sha256);
  });

  it("keeps ACTIVE status/capabilities bounded with S2 and destructive authority disabled", async () => {
    const fx = await runtimeFixture();
    const status = await dispatchOperatorControlTool("operator_status", {}, fx.runtime);
    const caps = await dispatchOperatorControlTool("operator_capabilities", {}, fx.runtime);
    expect(status.result).toMatchObject({ decision: "ALLOW", mode: "ACTIVE", mutationActive: true, destructive: "LOCKED" });
    expect(caps.result).toMatchObject({ decision: "ALLOW", toolCount: 13, s2Enabled: false, genericShell: false, genericExec: false, destructive: "LOCKED" });
  });

  it("contains no remote Git, generic shell, process kill, cloud, or production mutation authority in M08 wiring", async () => {
    const runtime = await readFile("src/operator/control-runtime.ts", "utf8");
    const server = await readFile("src/server.ts", "utf8");
    const localGit = await readFile("src/operator/local-git.ts", "utf8");
    for (const forbidden of ["git push", "git fetch", "git pull", "docker pull", "shell: true", "killProcess", "cloud mutation", "production mutation"]) {
      expect(runtime).not.toContain(forbidden);
    }
    for (const forbidden of ['"push"', '"pull"', '"fetch"', '"remote"', '"clone"', '"reset"', '"rebase"']) {
      expect(localGit).not.toContain(forbidden);
    }
  });

  it("requires branded qualified runtime provenance before ACTIVE server dispatch", async () => {
    const qualified = await readFile("src/operator/qualified-control-runtime.ts", "utf8");
    const server = await readFile("src/server.ts", "utf8");
    for (const marker of [
      "new LocalOperatorGit()", "new OperatorTransactionService", "new SandboxExecutor()",
      "new OperatorTaskRunner", "M08_QUALIFIED_RUNTIME_IDENTITY", "QUALIFIED_RUNTIMES",
      "M08_QUALIFIED_REGISTRY_IDENTITY_MISMATCH", "M08_QUALIFIED_EFFECT_POLICY_IDENTITY_MISMATCH",
    ]) expect(qualified).toContain(marker);
    expect(server).toContain("isQualifiedOperatorControlRuntime(config.operatorRuntime)");
    expect(server).toContain("M08_ACTIVE_RUNTIME_UNQUALIFIED");
  });

  it("requires the M08 deterministic qualification and final-review boundary", async () => {
    const script = await readFile("scripts/qualify-m08.ps1", "utf8");
    for (const marker of [
      "POWERSHELL_7_REQUIRED", "M08_ADVERSARIAL_TESTS", "M07_FINAL_CERTIFICATION_BOUND=PASS",
      "M08_QUALIFIED_RUNTIME_PROVENANCE=PASS", "M08_POST_BRAND_PROVENANCE_IMMUTABILITY=PASS",
      "FULL_TEST_PASSING_COUNT", "[StringComparer]::Ordinal", "LIVE_M08_EXACT_13_TOOLS=PASS",
      "LIVE_M08_ACTIVE_STATUS=PASS", "LIVE_M08_TASK=PASS", "LIVE_M08_PROMOTION=PASS",
      "LIVE_M08_ROLLBACK=PASS", "LIVE_M08_STALE_CAS_DENIAL=PASS", "WORKTREE_RESIDUE=0",
      "DOCKER_RESIDUE=0", "TUNNEL_INTEGRITY=PASS", "PORT_8772_FREE=PASS",
      "SECRETS_PERSISTED=FALSE", "HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_READY_FOR_INDEPENDENT_VERIFICATION",
    ]) expect(script).toContain(marker);
    expect(script).not.toContain("docker pull");
  });
});
