import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scripts = ["preflight-b6-project-expansion.ps1", "qualify-b6-stage.ps1", "execute-b6-project-expansion.ps1", "rollback-b6-project-expansion.ps1"];

describe("B6 staged activation helper boundaries", () => {
  it("pins exact roots and independently currentness-checks the complete Stage-1 certificate/evidence", async () => {
    const source = await readFile(join(process.cwd(), "scripts", scripts[0]!), "utf8");
    for (const marker of [
      "haios-operator-canary", "haios-skill-fabric", "hermes-ai-operating-system-b6-canonical", "SKILL_FABRIC", "HERMES_OS", "8769",
      "B6_STAGE_ONE_CERTIFICATION_REQUIRED", "B6_STAGE_ONE_CERTIFICATION_NOT_CURRENT", "rev-parse --verify HEAD", "rev-parse --git-common-dir", "status --porcelain=v1", "git.exe -C $canonicalPath ls-files",
      "b6CandidateHeadSha", "b6CandidateTrackedCount", "b6CandidateManifestSha256", "canonicalPath", "gitCommonDirIdentity", "targetHeadSha", "targetTrackedCount", "targetManifestSha256",
      "liveQualificationEvidencePath", "liveQualificationEvidenceSha256", "Get-FileHash", "exact13Tools", "projectAdmitted", "hermesOsDenied", "canonicalPreHeadSha", "canonicalPostHeadSha", "ownedResidueCount", "rollbackRecoveryClassification", "certificationSha256", "stage1-live-qualification.json", "stage1-final-certification.json",
      "Assert-ExactFields", "Get-CanonicalSha256", "Get-Sha256 $expectedEvidencePath",
    ]) expect(source).toContain(marker);
  });
  it("uses the certified sorted physical-manifest algorithm", () => {
    const result = spawnSync("node", [join(process.cwd(), "scripts", "create-b6-source-manifest.mjs")], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).toBe(0);
    const actual = JSON.parse(result.stdout) as { trackedCount: number; manifestSha256: string };
    const paths = execFileSync("git", ["ls-files"], { cwd: process.cwd(), encoding: "utf8" }).split(/\r?\n/u).filter(Boolean).sort();
    const canonical = `${paths.map((path) => `${createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex")}  ${path.replaceAll("\\", "/")}`).join("\n")}\n`;
    expect(actual.trackedCount).toBe(paths.length);
    expect(actual.manifestSha256).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
  });  it("does not mint synthetic PASS evidence and makes qualification invoke the currentness gate", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "qualify-b6-stage.ps1"), "utf8");
    for (const marker of ["never manufactures PASS text", "preflight-b6-project-expansion.ps1", "B6_STAGE_ONE_CERTIFICATION_CURRENT", "B6_STAGE_TWO_PREFLIGHT_CURRENT"]) expect(source).toContain(marker);
    expect(source).not.toContain("WriteAllText($EvidencePath");
  });
  it("keeps live activation and rollback recovery-first and non-destructive in this source lane", async () => {
    const sources = await Promise.all(scripts.slice(2).map((name) => readFile(join(process.cwd(), "scripts", name), "utf8")));
    expect(sources.join("\n")).toContain("B6_LIVE_ACTIVATION_ORCHESTRATOR_REQUIRED");
    expect(sources.join("\n")).toContain("VERIFIED_PRESERVED");
    expect(sources.join("\n")).not.toContain("Remove-Item");
  });
  it("is PowerShell parse-clean", () => {
    for (const name of scripts) {
      const path = join(process.cwd(), "scripts", name).replaceAll("'", "''");
      const command = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){exit 1}`;
      expect(spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8" }).status).toBe(0);
    }
  });
});
