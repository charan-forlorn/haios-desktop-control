import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const preflightPath = join(process.cwd(), "scripts", "preflight-m12-b5-activation.ps1");
const executePath = join(process.cwd(), "scripts", "execute-m12-b5-activation.ps1");
const rollbackPath = join(process.cwd(), "scripts", "rollback-m12-b5-to-m11.ps1");
const probePath = join(process.cwd(), "scripts", "probe-m12-b5-host.mjs");

const DECISION = "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION";
const PARENT_TERMINAL = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED";
const PARENT_HEAD = "1c32ba789ce89872b36bfed5f7a527b917072d6b";
const PARENT_MANIFEST = "ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a";
const M11_TASK = "HAIOS-M11-Operator-Active-Canary";
const M12_TASK = "HAIOS-M12-Operator-B5-Canary-Stability";
const CANARY_ROOT = "C:\\Workspace\\haios-operator-canary";

async function sources(): Promise<[string, string, string, string]> {
  const [preflight, execute, rollback, probe] = await Promise.all([preflightPath, executePath, rollbackPath, probePath].map((path) => readFile(path, "utf8")));
  if (preflight === undefined || execute === undefined || rollback === undefined || probe === undefined) throw new Error("M12_ACTIVATION_TEST_SOURCE_MISSING");
  return [preflight, execute, rollback, probe];
}

describe("M12 sealed B5 activation transaction", () => {
  it("hard-binds Human authority, certified M11 parent, canary, API-key and task identities", async () => {
    const [preflight, execute, rollback] = await sources();
    for (const source of [preflight, execute, rollback]) {
      for (const marker of [DECISION, PARENT_TERMINAL, PARENT_HEAD, PARENT_MANIFEST, M11_TASK, M12_TASK, CANARY_ROOT, "HAIOS\\M10\\operator-api-key"]) {
        expect(source).toContain(marker);
      }
    }
    expect(preflight).toContain("m11_final_cert_sha256");
    expect(preflight).toContain("candidate_manifest_sha256");
    expect(preflight).toContain("executor_sha256");
    expect(preflight).toContain("rollback_sha256");
  });

  it("keeps preflight observational and production-mutation free", async () => {
    const [preflight] = await sources();
    for (const forbidden of ["Register-ScheduledTask", "Start-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask", "worktree add", "worktree remove", "docker compose up", "docker.exe compose", "Set-Acl"]) {
      expect(preflight.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("places every authority/currentness gate before M12_MUTATION_BEGIN", async () => {
    const [, execute] = await sources();
    const mutation = execute.indexOf("M12_MUTATION_BEGIN");
    expect(mutation).toBeGreaterThan(0);
    for (const marker of [
      "M12_HUMAN_AUTHORITY_ACCEPTED", "M12_M11_FINAL_CERT_CURRENT", "M12_CANDIDATE_CURRENT",
      "M12_M11_TASK_PREIMAGE_CURRENT", "M12_CANARY_PREIMAGE_CURRENT", "M12_M10_API_KEY_CURRENT",
      "M12_TUNNEL_PREIMAGE_CURRENT", "M12_LISTENERS_PREIMAGE_CURRENT", "M12_EXECUTOR_CURRENT", "M12_ROLLBACK_CURRENT",
    ]) {
      const index = execute.indexOf(marker);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(mutation);
    }
  });

  it("binds tunnel identity to stable config and excludes volatile health state", async () => {
    const [preflight, execute, rollback] = await sources();
    for (const source of [preflight, execute, rollback]) {
      for (const marker of ["config_image", "restart_policy", "network_mode", "mounts=$mount", "networks=$net"]) expect(source).toContain(marker);
      expect(source).not.toContain('UTF8.GetBytes(($raw -join "`n"))');
    }
  });

  it("temporarily disables native error preference only inside bounded readiness probes", async () => {
    const [, execute, rollback] = await sources();
    for (const source of [execute, rollback]) {
      expect(source).toContain("$oldNativeErrorPreference=$PSNativeCommandUseErrorActionPreference");
      expect(source).toContain("$PSNativeCommandUseErrorActionPreference=$false");
      expect(source).toContain("$probeExit=$LASTEXITCODE");
      expect(source).toContain("$PSNativeCommandUseErrorActionPreference=$oldNativeErrorPreference");
      expect(source).toContain("$probeExit -eq 0");
    }
  });

  it("automatically invokes recovery-first rollback on every post-mutation failure", async () => {
    const [, execute, rollback] = await sources();
    expect(execute).toContain("$mutationStarted=$false");
    expect(execute).toContain("M12_MUTATION_BEGIN");
    expect(execute).toContain("M12_FORWARD_FAILURE");
    expect(execute).toContain("rollback-m12-b5-to-m11.ps1");
    expect(execute).toContain("M12_AUTOMATIC_ROLLBACK_COMPLETE");
    const restore = rollback.indexOf("Start-ScheduledTask -TaskName $M11Task");
    const cleanup = rollback.indexOf("M12_DEPLOYMENT_REMOVE_FAILED");
    expect(restore).toBeGreaterThan(0);
    expect(cleanup).toBeGreaterThan(restore);
    expect(rollback).toContain("M12_ROLLBACK_M11_RESTORED");
    expect(rollback).toContain("HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_ROLLED_BACK_TO_CERTIFIED_M11_ACTIVE_CANARY");
  });

  it("fails closed on dependency installation without network download authority", async () => {
    const [, execute] = await sources();
    expect(execute).toContain("npm.cmd ci --offline --ignore-scripts --no-audit --no-fund");
  });

  it("requires every forbidden-authority envelope field to be present and exact false", async () => {
    const [, execute] = await sources();
    for (const field of ["tunnel_mutation_authorized", "m10_api_key_rotation_authorized", "s2_authorized", "destructive_authorized", "generic_exec_authorized", "generic_shell_authorized"]) {
      expect(execute).toContain(`\"${field}\"`);
    }
    expect(execute).toContain("$Envelope.PSObject.Properties[$field]");
    expect(execute).toContain("-isnot [bool]");
    expect(execute).toContain("-ne $false");
    expect(execute).toContain("FORBIDDEN_AUTHORITY_FIELD_INVALID");
  });

  it("re-proves exact certified M11 runtime bytes before rollback starts M11", async () => {
    const [, , rollback] = await sources();
    const start = rollback.indexOf("Start-ScheduledTask -TaskName $M11Task");
    expect(start).toBeGreaterThan(0);
    for (const marker of ["M11_FINAL_CERT_NOT_CURRENT", "M11_RUNTIME_HEAD_DRIFT", "M11_RUNTIME_DIRTY", "M11_RUNTIME_MANIFEST_DRIFT"]) {
      const index = rollback.indexOf(marker);
      expect(index).toBeGreaterThan(0);
      expect(index).toBeLessThan(start);
    }
    expect(rollback).toContain("Get-ManifestDigest $M11RuntimeRoot");
  });

  it("keeps exact authority boundaries and authenticated ACTIVE B5 host proof", async () => {
    const [preflight, execute, rollback, probe] = await sources();
    const all = [preflight, execute, rollback, probe].join("\n").toLowerCase();
    for (const forbidden of ["s2enabled=true", "destructive=unlocked", "git push", "git fetch", "git pull", "docker system prune", "powershell -command", "cmd.exe /c"]) expect(all).not.toContain(forbidden);
    for (const marker of ["http://127.0.0.1:8769/mcp", 'result.mode === "ACTIVE"', 'result.activation_scope === "M12_B5_CANARY_STABILITY_ONLY"', "result.mutation_active === true", "result.s2_enabled === false", "result.generic_exec === false", "result.generic_shell === false", 'result.destructive === "LOCKED"']) expect(probe).toContain(marker);
  });

  it("preserves verified durable M12 state and fails closed on unknown rollback residue", async () => {
    const [preflight, execute, rollback] = await sources();
    for (const source of [preflight, execute, rollback]) expect(source).toContain("verify-m12-preserved-state.mjs");
    expect(rollback).not.toContain("Remove-Item -LiteralPath $StateRoot -Recurse -Force");
    expect(rollback).toContain("M12_STATE_RECONCILIATION_REQUIRED");
    expect(rollback).toContain("m12_state_preserved=$true");
    expect(execute).not.toContain('if(Test-Path -LiteralPath $StateRoot){AuthorityFail "M12_STATE_COLLISION"}');
    expect(execute).toContain("preserved_state_digest");
    expect(preflight).toContain("preserved_state_digest");
  });
  it("keeps all three PowerShell transaction scripts parse-clean", () => {
    for (const path of [preflightPath, executePath, rollbackPath]) {
      const command = ["$tokens=$null;$errors=$null;", `[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;`, "if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 1}"].join("");
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 10_000 });
      expect(result.status, `${path}: ${result.stderr}`).toBe(0);
    }
  });
});
