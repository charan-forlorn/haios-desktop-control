import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const qualifierPath = join(process.cwd(), "scripts", "qualify-m12-prelive.ps1");
const TERMINAL = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_READY_FOR_EXACT_HUMAN_ACTIVATION_DECISION";
const PARENT_TERMINAL = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED";
const PARENT_HEAD = "1c32ba789ce89872b36bfed5f7a527b917072d6b";
const PARENT_MANIFEST = "ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a";

describe("M12 pre-live qualification contract", () => {
  it("binds the exact certified M11 parent and current candidate manifest", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of [PARENT_TERMINAL, PARENT_HEAD, PARENT_MANIFEST, "m11_final_cert_sha256", "candidate_head", "candidate_manifest_sha256", "tracked_count"]) expect(source).toContain(marker);
  });
  it("requires frozen clean source and one broad regression with typecheck/build/diff-check", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of ["status --porcelain", "vitest", "--exclude", "dist/**", "npm.cmd run typecheck", "npm.cmd run build", "git.exe -C $Root diff --check"]) expect(source).toContain(marker);
  });
  it("requires Task 8 disposable B5 PASS and exact authority denials", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of ["qualify-m12-disposable-b5.mjs", "allPatternsPassed", "zeroOwnedResidue", "authorityExpanded", "exactToolSurface", "s2Enabled", "genericExec", "genericShell", 'destructive']) expect(source).toContain(marker);
  });
  it("proves real canary bytes are unchanged across pre-live qualification", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of ["canary_head_before", "canary_head_after", "canary_status_before", "canary_status_after", "M12_PRELIVE_CANARY_MUTATION_DETECTED"]) expect(source).toContain(marker);
  });
  it("runs PowerShell parser and a tracked-boundary secret scan", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of ["Parser]::ParseFile", "secret_scan", "git.exe -C $Root ls-files", "OPENAI_API_KEY", "sk-proj-"]) expect(source).toContain(marker);
  });
  it("records activation member hashes and independent-review handoff", async () => {
    const source = await readFile(qualifierPath, "utf8");
    for (const marker of ["execute-m12-b5-activation.ps1", "rollback-m12-b5-to-m11.ps1", "probe-m12-b5-host.mjs", "preflight-m12-b5-activation.ps1", "independent-review-handoff.json"]) expect(source).toContain(marker);
  });
  it("emits only the exact pre-live terminal and exact next human decision", async () => {
    const source = await readFile(qualifierPath, "utf8");
    expect(source).toContain(TERMINAL);
    expect(source).toContain("APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION");
    expect(source).not.toContain("HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_QUALIFIED");
  });
  it("keeps qualification observational with respect to production", async () => {
    const source = (await readFile(qualifierPath, "utf8")).toLowerCase();
    for (const forbidden of ["register-scheduledtask", "start-scheduledtask", "stop-scheduledtask", "unregister-scheduledtask", "worktree add", "worktree remove", "docker compose up", "set-acl"]) expect(source).not.toContain(forbidden);
  });
  it("is PowerShell parse-clean", () => {
    const command = ["$tokens=$null;$errors=$null;", `[System.Management.Automation.Language.Parser]::ParseFile('${qualifierPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;`, "if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 1}"].join("");
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
  });
});