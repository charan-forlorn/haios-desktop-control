import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const preflightPath = join(process.cwd(), "scripts", "preflight-m11-active-canary.ps1");
const executePath = join(process.cwd(), "scripts", "execute-m11-active-canary.ps1");
const rollbackPath = join(process.cwd(), "scripts", "rollback-m11-active-canary.ps1");
const supervisorPath = join(process.cwd(), "scripts", "run-m11-active-canary-supervisor.mjs");

const DECISION = "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_ACTIVATION";
const M10_TERMINAL = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER_QUALIFIED";
const CANARY_ROOT = "C:\\Workspace\\haios-operator-canary";
const M10_TASK = "HAIOS-M10-Operator-ReadOnly";
const M11_TASK = "HAIOS-M11-Operator-Active-Canary";

async function sources() {
  return Promise.all([
    readFile(preflightPath, "utf8"),
    readFile(executePath, "utf8"),
    readFile(rollbackPath, "utf8"),
    readFile(supervisorPath, "utf8"),
  ]);
}
describe("M11 sealed activation transaction", () => {
  it("hard-binds the Human decision, parent certification, canary, and task identities", async () => {
    const [preflight, execute, rollback, supervisor] = await sources();
    for (const source of [preflight, execute, rollback]) {
      expect(source).toContain(DECISION);
      expect(source).toContain(M10_TERMINAL);
      expect(source).toContain(CANARY_ROOT);
      expect(source).toContain(M10_TASK);
      expect(source).toContain(M11_TASK);
    }
    expect(execute).toContain("C:\\Workspace\\haios-desktop-control-m11-runtime");
    expect(execute).toContain("HAIOS\\M11");
    expect(execute).toContain("operator-api-key");
    expect(supervisor).toContain("run-m11-active-canary-runtime.mjs");
    expect(supervisor).toContain("HAIOS\", \"M11\", \"host-config.json");
  });

  it("keeps preflight observational and production-mutation free", async () => {
    const [preflight] = await sources();
    for (const forbidden of [
      "Register-ScheduledTask", "Start-ScheduledTask", "Stop-ScheduledTask",
      "Unregister-ScheduledTask", "worktree add", "worktree remove",
      "docker compose up", "docker.exe compose", "Set-Acl",
    ]) expect(preflight.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
  it("places every currentness and authority gate before the first mutation marker", async () => {
    const [, execute] = await sources();
    const mutation = execute.indexOf("M11_MUTATION_BEGIN");
    expect(mutation).toBeGreaterThan(0);
    for (const marker of [
      "M11_HUMAN_AUTHORITY_ACCEPTED",
      "M11_M10_FINAL_CERT_CURRENT",
      "M11_CANDIDATE_CURRENT",
      "M11_CANARY_PREIMAGE_CURRENT",
      "M11_M10_API_KEY_CURRENT",
      "M11_M10_RUNTIME_PREIMAGE_CURRENT",
      "M11_TUNNEL_PREIMAGE_CURRENT",
    ]) {
      const index = execute.indexOf(marker);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(mutation);
    }
    expect(execute).toContain("candidate_manifest_sha256");
    expect(execute).toContain("m10_final_cert_sha256");
    expect(execute).toContain("m10_api_key_sha256");
    expect(execute).toContain("canary_head");
  });

  it("reuses but never rotates or rewrites the M10 API key", async () => {
    const [preflight, execute, rollback] = await sources();
    for (const source of [preflight, execute, rollback]) {
      expect(source).toContain('"HAIOS\\M10\\operator-api-key"');
      expect(source).not.toContain("RandomNumberGenerator");
    }
    expect(execute).not.toContain("WriteAllText($M10ApiKeyFile");
    expect(execute).not.toContain("Set-Content -LiteralPath $M10ApiKeyFile");
  });
  it("preserves both tunnel routes and the shared 8768 boundary", async () => {
    const [preflight, execute, rollback] = await sources();
    for (const source of [preflight, execute, rollback]) {
      expect(source).toContain("haios-operator-dedicated-tunnel-client");
      expect(source).toContain("haios-tunnel-client");
      expect(source).toContain("8768");
      expect(source).toContain("host.docker.internal:8769/mcp");
    }
    for (const source of [execute, rollback]) {
      expect(source).not.toContain("operator-mcp:8769/mcp,channel=main");
      expect(source).not.toContain("docker compose down");
      expect(source).not.toContain("docker system prune");
    }
    expect(execute).toContain("M11_TUNNEL_PREIMAGE_CURRENT");
    expect(execute).toContain("M11_TUNNEL_POSTIMAGE_CURRENT");
  });

  it("automatically rolls back any failure after mutation begins", async () => {
    const [, execute, rollback] = await sources();
    expect(execute).toContain("$mutationStarted=$false");
    expect(execute).toContain("M11_MUTATION_BEGIN");
    expect(execute).toContain("M11_FORWARD_FAILURE");
    expect(execute).toContain("rollback-m11-active-canary.ps1");
    expect(execute).toContain("M11_AUTOMATIC_ROLLBACK_COMPLETE");
    expect(rollback).toContain("run-m10-readonly-supervisor.mjs");
    expect(rollback).toContain("READ_ONLY_EMERGENCY");
    expect(rollback).toContain("M11_ROLLBACK_M10_RESTORED");
    expect(rollback).toContain("HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ROLLED_BACK_TO_CERTIFIED_M10_READ_ONLY_STATE");
  });
  it("keeps the M11 supervisor bounded to the exact M11 config and child launcher", async () => {
    const [, , , supervisor] = await sources();
    for (const marker of [
      "run-m11-active-canary-runtime.mjs",
      "M11_SUPERVISOR_CONFIG_REQUIRED",
      "M11_SUPERVISOR_RESTART_BOUND_INVALID",
      "M11_SUPERVISOR_BACKOFF_INVALID",
      "M11_SUPERVISOR_CONFIG_REJECTED",
      "DEFAULT_MAX_RESTARTS = 3",
    ]) expect(supervisor).toContain(marker);
    expect(supervisor).toContain('stdio: ["ignore", "inherit", "inherit"]');
    expect(supervisor).toContain("shell: false");
    expect(supervisor).not.toContain("exec(");
    expect(supervisor).not.toContain("spawnSync");
  });

  it("does not add S2, destructive, generic shell, remote Git, or cloud authority", async () => {
    const [preflight, execute, rollback, supervisor] = await sources();
    const all = [preflight, execute, rollback, supervisor].join("\n").toLowerCase();
    for (const forbidden of [
      "s2enabled=true", "s2enabled = true", "destructive=unlocked", "destructive = unlocked",
      "git push", "git fetch", "git pull", "git remote add", "force-with-lease",
      "aws ", "az ", "gcloud ", "kubectl ", "terraform apply",
    ]) expect(all).not.toContain(forbidden);
    expect(all).not.toContain("powershell -command");
    expect(all).not.toContain("cmd.exe /c");
  });
  it("keeps all three PowerShell transaction scripts parse-clean", () => {
    for (const path of [preflightPath, executePath, rollbackPath]) {
      const command = [
        "$tokens=$null;$errors=$null;",
        `[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;`,
        "if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 1}",
      ].join("");
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
        encoding: "utf8", timeout: 10_000,
      });
      expect(result.status, `${path}: ${result.stderr}`).toBe(0);
    }
  });
});

describe("M11 authenticated ACTIVE host probe", () => {
  it("proves ACTIVE canary policy without mutating the allowed canary", async () => {
    const probe = await readFile(join(process.cwd(), "scripts", "probe-m11-active-canary-host.mjs"), "utf8");
    for (const marker of [
      "http://127.0.0.1:8769/mcp",
      'result.mode === "ACTIVE"',
      "result.mutation_active === true",
      'denied.reason === "PROJECT_NOT_ALLOWED"',
      "result.s2_enabled === false",
      "result.generic_exec === false",
      "result.generic_shell === false",
      'result.destructive === "LOCKED"',
    ]) expect(probe).toContain(marker);
    expect(probe).not.toContain('projectId: "operator-canary"');
  });
});

describe("M11 independent-review remediation contracts", () => {
  it("hard-binds the trusted M10 final-cert location and proof identities", async () => {
    const [preflight, execute, rollback] = await sources();
    const exactCert = "C:\\Workspace\\haios-desktop-control-m10\\evidence\\m10\\final\\m10-final-certification.json";
    const m10Head = "f476f719be42ee40fe6ae5358930dc1662a95d3e";
    const m10Manifest = "8582819a33800d9949011f6ac07b07248b163fa19ddd8d3fd1d1e47bddd7a36f";
    for (const source of [preflight, execute, rollback]) {
      expect(source).toContain(exactCert);
      expect(source).toContain(m10Head);
      expect(source).toContain(m10Manifest);
      expect(source).toContain("remote_dispatch_proof_sha256");
      expect(source).toContain("route_divergence_proof_sha256");
    }
    const preflightParams = preflight.match(/^param\([\s\S]*?\)\r?\n/u)?.[0] ?? "";
    expect(preflightParams).not.toContain("$M10FinalCertification");
    expect(execute).toContain("M10_FINAL_CERT_PATH_MISMATCH");
  });

  it("restores M10 before non-critical M11 cleanup and verifies the canary preimage", async () => {
    const [, , rollback] = await sources();
    const restart = rollback.indexOf("Start-ScheduledTask -TaskName $M10Task");
    const deploymentCleanup = rollback.indexOf("M11_DEPLOYMENT_REMOVE_FAILED");
    const stateCleanup = rollback.indexOf("M11_STATE_REMOVE_FAILED");
    expect(restart).toBeGreaterThan(0);
    expect(deploymentCleanup).toBeGreaterThan(restart);
    expect(stateCleanup).toBeGreaterThan(restart);
    expect(rollback).toContain("M11_ROLLBACK_CANARY_PREIMAGE_DRIFT");
    expect(rollback).toContain("git.exe -C $CanaryRoot rev-parse HEAD");
    expect(rollback).toContain("git.exe -C $CanaryRoot status --porcelain");
  });
  it("binds the exact main canary branch through preflight, execution, and rollback", async () => {
    const [preflight, execute, rollback] = await sources();
    expect(preflight).toContain('$ExpectedCanaryBranch="main"');
    expect(preflight).toContain("git.exe -C $CanaryRoot branch --show-current");
    expect(preflight).toContain("M11_CANARY_BRANCH_DENIED");
    expect(preflight).toContain("canary_branch=$canaryBranch");
    for (const source of [execute, rollback]) {
      expect(source).toContain('$ExpectedCanaryBranch="main"');
      expect(source).toContain("git.exe -C $CanaryRoot branch --show-current");
      expect(source).toContain("Envelope.canary_branch");
    }
    expect(execute).toContain("CANARY_BRANCH_DRIFT");
    expect(rollback).toContain("M11_ROLLBACK_CANARY_PREIMAGE_DRIFT");
  });
});
