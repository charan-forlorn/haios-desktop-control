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
  it("requires authenticated Stage-1 proof before constructing Stage-2 runtime", async () => {
    const runtime = await readFile(join(process.cwd(), "src", "operator", "b6-active-runtime.ts"), "utf8");
    const launcher = await readFile(join(process.cwd(), "scripts", "run-b6-project-expansion-runtime.mjs"), "utf8");
    const preflight = await readFile(join(process.cwd(), "scripts", "preflight-b6-project-expansion.ps1"), "utf8");
    for (const marker of ["certificationHmacSha256", "liveQualificationEvidenceHmacSha256", "HMACSHA256", "operator-api-key"]) expect(preflight).toContain(marker);
    expect(runtime).toContain("verifyB6StageOneAdmission");
    const proof = await readFile(join(process.cwd(), "src", "operator", "b6-stage-one-proof.ts"), "utf8");
    for (const marker of ["certificationHmacSha256", "liveQualificationEvidenceHmacSha256", "B6_CANDIDATE_ROOT", "SKILL_ROOT", "ls-files", "gitCommonDirIdentity", "porcelain=v1"]) expect(proof).toContain(marker);
    expect(launcher).toContain('config.stage === "HERMES_OS"');
    expect(launcher).toContain("-ValidateOnly");
    expect(launcher).toContain("stage1-final-certification.json");
  });
  it("rejects cross-volume or outside runtime build roots", async () => {
    const launcher = await readFile(join(process.cwd(), "scripts", "run-b6-project-expansion-runtime.mjs"), "utf8");
    const attestation = await readFile(join(process.cwd(), "scripts", "b6-runtime-attestation.mjs"), "utf8");
    for (const source of [launcher, attestation]) expect(source).toContain("isAbsolute");
    expect(attestation).toContain("realpath");
  });
  it("starts the B6 gateway and authenticates/decodes the MCP host probe", async () => {
    const runtime = await readFile(join(process.cwd(), "scripts", "run-b6-project-expansion-runtime.mjs"), "utf8");
    const probe = await readFile(join(process.cwd(), "scripts", "probe-b6-project-expansion-host.mjs"), "utf8");
    expect(runtime.indexOf("await started.listen()")) .toBeGreaterThan(-1);
    expect(runtime.indexOf("await started.listen()")).toBeLessThan(runtime.indexOf("process.stdout.write"));
    for (const expected of ["StreamableHTTPClientTransport", "loadHostApiKey", "X-API-Key", "result.content", "mutationActive", "s2Enabled", "genericExec", "genericShell", "PROJECT_NOT_ALLOWED", "hermes_os_denied"]) {
      expect(probe).toContain(expected);
    }
    expect(probe).not.toContain('headers: { "content-type"');
  });
  it("pins the certified target baselines instead of certifying arbitrary clean repositories", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "preflight-b6-project-expansion.ps1"), "utf8");
    for (const marker of [
      "51790d8fa098fa4b07b1424faee604dde9fa89fe", "47", "2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340",
      "94b43820e43060e4504f26e514d71d3024236871", "96", "cc4d70d2d61f18ea03d240808022cf4894269b8a2191752c270b2f2b1640c934",
      "B6_CERTIFIED_BASELINE_NOT_CURRENT", "900",
    ]) expect(source).toContain(marker);
  });
  it("mints Stage-1 evidence only from a fresh authenticated live transaction replay", async () => {
    const preflight = await readFile(join(process.cwd(), "scripts", "preflight-b6-project-expansion.ps1"), "utf8");
    const live = await readFile(join(process.cwd(), "scripts", "qualify-b6-live-stage.mjs"), "utf8");
    expect(preflight).toContain("qualify-b6-live-stage.mjs");
    expect(preflight.indexOf("qualify-b6-live-stage.mjs")).toBeLessThan(preflight.indexOf("Assert-LiveEvidence $stagedEvidence"));
    for (const marker of ["StreamableHTTPClientTransport", "X-API-Key", "operator_begin_transaction", "operator_stage_create", "operator_validate_transaction",
      "operator_apply_transaction", "operator_run_task", "node.test.run", "operator_rollback_transaction", "stage1-live-qualification.json"]) expect(live).toContain(marker);
  });
  it("proves the connected server actually admits the stage target and rolls the probe transaction back", async () => {
    const probe = await readFile(join(process.cwd(), "scripts", "probe-b6-project-expansion-host.mjs"), "utf8");
    for (const marker of ["target_admitted", "operator_rollback_transaction", "hermes-os", "skill-fabric", "transaction.txId"]) expect(probe).toContain(marker);
  });
  it("preserves an existing Stage-1 evidence artifact until a fresh replacement is validated", async () => {
    const preflight = await readFile(join(process.cwd(), "scripts", "preflight-b6-project-expansion.ps1"), "utf8");
    expect(preflight).not.toContain("Remove-Item -LiteralPath $EvidencePath");
    for (const marker of ["$stagedEvidencePath", "[IO.File]::Replace", "[IO.File]::Move", "Assert-LiveEvidence $stagedEvidence"]) expect(preflight).toContain(marker);
    expect(preflight).toContain('[DateTimeOffset]::UtcNow.ToString("o")');
    expect(preflight).not.toContain('[DateTime]::UtcNow.ToString("o")');
    expect(preflight).toContain('ConvertFrom-Json -DateKind String -ErrorAction Stop');
    expect(preflight).toContain('$DestinationPath.replace-backup-');
  });
  it("builds and independently reproduces every live B6 runtime from the current tracked candidate", async () => {
    const launcher = await readFile(join(process.cwd(), "scripts", "run-b6-project-expansion-runtime.mjs"), "utf8");
    const prepare = await readFile(join(process.cwd(), "scripts", "prepare-b6-runtime-build.mjs"), "utf8");
    const attestation = await readFile(join(process.cwd(), "scripts", "b6-runtime-attestation.mjs"), "utf8");
    expect(launcher).not.toContain('"../dist/src/operator/b6-active-runtime.js"');
    for (const marker of ["prepare-b6-runtime-build.mjs", "pathToFileURL", "candidateManifestSha256", "compiledOutputSha256"]) expect(launcher).toContain(marker);
    expect(launcher).toContain("const prepared = JSON.parse(preparedProcess.stdout.trim()");
    expect(launcher).not.toContain("const build = JSON.parse(prepared.stdout");
    const buildVerifyCalls = [...launcher.matchAll(/verifyPreparedB6RuntimeBuild\(prepared\)/gu)].map((match) => match.index ?? -1);
    const executionDigest = launcher.indexOf("const executionDigest = await compiledDigest(executionRoot)");
    const runtimeImport = launcher.indexOf("await import(pathToFileURL(join(executionRoot");
    expect(buildVerifyCalls).toHaveLength(1);
    expect(buildVerifyCalls[0]).toBeLessThan(executionDigest);
    expect(executionDigest).toBeLessThan(runtimeImport);
    for (const marker of ["--outDir", "mkdtemp", "runtime", "task-registry.m07.json", "task-effects.m07.json", "candidateManifestSha256", "compiledOutputSha256", "B6_RUNTIME_SOURCE_CHANGED_DURING_BUILD"]) expect(prepare).toContain(marker);
    for (const marker of ["independentlyRebuildCurrentRuntime", "prepare-b6-runtime-build.mjs", "B6_RUNTIME_BUILD_REPRODUCTION_FAILED", "verifier.buildRoot"]) expect(attestation).toContain(marker);
    expect(attestation).toContain('join(buildRoot, "src", "operator", "host-runtime-config.js")');
    expect(attestation).toContain('join(buildRoot, "src", "operator", "protocol.js")');
    expect(attestation).not.toContain('join(verifier.buildRoot, "src", "operator", "host-runtime-config.js")');
  });
  it("stage and final sealing validate canonical artifacts against current repository facts before issuing seals", async () => {
    const stageSeal = await readFile(join(process.cwd(), "scripts", "seal-b6-stage.mjs"), "utf8");
    for (const marker of ["preflight-b6-project-expansion.ps1", "-ValidateOnly", "B6_STAGE_PREFLIGHT_NOT_CURRENT"]) expect(stageSeal).toContain(marker);
    const finalSeal = await readFile(join(process.cwd(), "scripts", "seal-b6-final.mjs"), "utf8");
    for (const marker of ["stage1-final-certification.json", "stage2-final-certification.json", "stage1-live-qualification.json", "stage2-live-qualification.json",
      "liveQualificationEvidenceSha256", "effectPolicyVerified", "rollbackRecoveryClassification", "hermesOsDenied", "skillFabricRegression", "operatorCanaryRegression", "wrongRootDenied", "unknownProjectDenied", "stageOneSealSha256", "stageTwoSealSha256", "B6_FINAL_ARTIFACT_PATH_DENIED"]) expect(finalSeal).toContain(marker);
  });
  it("moves verified runtime bytes into an ACL-locked private execution root before import", async () => {
    const launcher = await readFile(join(process.cwd(), "scripts", "run-b6-project-expansion-runtime.mjs"), "utf8");
    const attestation = await readFile(join(process.cwd(), "scripts", "b6-runtime-attestation.mjs"), "utf8");
    for (const marker of ["runtime-exec", "compiledDigest", "lockExecutionRoot", "unlockExecutionRoot", "icacls", "executionRoot"]) expect(launcher).toContain(marker);
    expect(launcher).toContain("await cp(buildRoot, executionRoot");
    expect(launcher).toContain('[executionRoot, "/reset", "/T", "/C"]');
    expect(launcher.indexOf("await lockExecutionRoot(executionRoot, executionSid)")).toBeLessThan(launcher.indexOf("await import(pathToFileURL(join(executionRoot"));
    expect(launcher.indexOf("await rm(preparedBuildRoot")).toBeLessThan(launcher.indexOf("await import(pathToFileURL(join(executionRoot"));
    expect(attestation).toContain("runtime-exec");
    expect(attestation).toContain("B6_RUNTIME_EXECUTION_ROOT_DENIED");
  });  it("final sealer re-authenticates the exact stage bytes and validates every stage-seal dependency", async () => {
    const finalSeal = await readFile(join(process.cwd(), "scripts", "seal-b6-final.mjs"), "utf8");
    for (const marker of ["createHmac", "timingSafeEqual", "loadOperatorKey", "verifyStageArtifactAuthentication",
      "certificationHmacSha256", "liveQualificationEvidenceHmacSha256", "HAIOS_B6_STAGE_FINAL_SEAL_R1",
      "stage1-evidence-bindings.json", "stage2-evidence-bindings.json", "SHA256SUMS.stage1.txt", "SHA256SUMS.stage2.txt",
      "evidenceSha256", "bindingsSha256", "sha256SumsSha256"]) expect(finalSeal).toContain(marker);
    expect(finalSeal.indexOf("await verifyStageArtifactAuthentication(stageOneBytes")).toBeGreaterThan(finalSeal.indexOf("stageOneEvidenceBytes = await readFile"));
  });
  it("implements live Stage-2 qualification and durable stage/final seal artifacts", async () => {
    const live = await readFile(join(process.cwd(), "scripts", "qualify-b6-live-stage.mjs"), "utf8");
    const qualify = await readFile(join(process.cwd(), "scripts", "qualify-b6-stage.ps1"), "utf8");
    const sealStage = await readFile(join(process.cwd(), "scripts", "seal-b6-stage.mjs"), "utf8");
    const sealFinal = await readFile(join(process.cwd(), "scripts", "seal-b6-final.mjs"), "utf8");
    for (const marker of ["HERMES_OS", "stage2-live-qualification.json", "skillFabricRegression", "operatorCanaryRegression", "wrongRootDenied", "regressionCleanupTxIds", "for (const regressionTxId of regressionCleanupTxIds)"]) expect(live).toContain(marker);
    for (const marker of ["transaction-recovery", "leases", "remediation", "B6_LIVE_OWNED_STATE_RESIDUE"]) expect(live).toContain(marker);
    for (const marker of ["HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_HERMES_OS_ADMISSION_QUALIFIED", "stage2-final-certification.json", "B6_STAGE_TWO_CERTIFICATION_CURRENT"]) expect(qualify).toContain(marker);
    for (const marker of ["stage1-evidence-bindings.json", "SHA256SUMS.stage1.txt", "stage1-final-seal.json", "stage1-final-certification.sha256", "stage2-final-seal.json"]) expect(sealStage).toContain(marker);
    for (const marker of ["HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_PROJECT_EXPANSION_QUALIFIED", "b6-final-certification.json", "b6-final-seal.json", "SHA256SUMS.final.txt"]) expect(sealFinal).toContain(marker);
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
