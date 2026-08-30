import { describe, expect, it } from "vitest";

import {
  B6_HERMES_OS_ROOT,
  B6_OPERATOR_CANARY_ROOT,
  B6_SKILL_FABRIC_ROOT,
  B6_STAGE_ONE_TERMINAL,
  qualifyB6StageCertification,
  resolveB6Project,
  sealB6StageOneCertification,
  validateB6StageOneCertification,
  validateB6RuntimeConfig,
} from "../src/operator/b6-project-expansion.js";
import { createB6ReadinessMetadata } from "../src/operator/b6-active-runtime.js";
import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";

const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? "C:\\Users\\fixture\\AppData\\Local";

function stageOneCertificate() {
  return sealB6StageOneCertification({
    schema: "HAIOS_B6_STAGE_CERTIFICATION_R1", stage: "SKILL_FABRIC", terminal: B6_STAGE_ONE_TERMINAL, targetProjectId: "skill-fabric",
    b6CandidateHeadSha: "a".repeat(40), b6CandidateTrackedCount: 12, b6CandidateManifestSha256: "b".repeat(64),
    canonicalPath: B6_SKILL_FABRIC_ROOT, gitCommonDirIdentity: "C:\\Workspace\\haios-skill-fabric\\.git",
    targetHeadSha: "c".repeat(40), targetTrackedCount: 24, targetManifestSha256: "d".repeat(64),
    liveQualificationEvidencePath: "C:\\evidence\\live.json", liveQualificationEvidenceSha256: "e".repeat(64),
    liveQualificationResult: "PASS", exact13Tools: true, projectAdmitted: true, hermesOsDenied: true,
    canonicalPreHeadSha: "c".repeat(40), canonicalPostHeadSha: "c".repeat(40), canonicalPreStatusClean: true, canonicalPostStatusClean: true,
    ownedResidueCount: 0, effectPolicyVerified: true, networkAuthority: "NONE", rollbackRecoveryClassification: "SAFE_TO_ROLLBACK", createdAt: "2026-08-30T00:00:00.0000000Z",
  });
}
function config(stage: "SKILL_FABRIC" | "HERMES_OS") {
  return {
    apiKeyFile: `${LOCAL_APP_DATA}\\HAIOS\\M10\\operator-api-key`, stateRoot: `${LOCAL_APP_DATA}\\HAIOS\\B6`, worktreeRoot: `${LOCAL_APP_DATA}\\HAIOS\\B6\\worktrees`,
    port: 8769, mode: "ACTIVE", activationScope: stage === "SKILL_FABRIC" ? "B6_SKILL_FABRIC_ADMISSION" : "B6_HERMES_OS_ADMISSION", stage,
    allowedProjects: stage === "SKILL_FABRIC" ? { "operator-canary": B6_OPERATOR_CANARY_ROOT, "skill-fabric": B6_SKILL_FABRIC_ROOT }
      : { "operator-canary": B6_OPERATOR_CANARY_ROOT, "skill-fabric": B6_SKILL_FABRIC_ROOT, "hermes-os": B6_HERMES_OS_ROOT },
  };
}

describe("B6 closed project admission boundary", () => {
  it("admits only the exact server-owned mappings per strictly ordered stage", () => {
    expect(validateB6RuntimeConfig(config("SKILL_FABRIC")).allowedProjects).toEqual(config("SKILL_FABRIC").allowedProjects);
    expect(validateB6RuntimeConfig(config("HERMES_OS")).allowedProjects).toEqual(config("HERMES_OS").allowedProjects);
    for (const bad of [
      { ...config("SKILL_FABRIC"), allowedProjects: { "operator-canary": B6_OPERATOR_CANARY_ROOT, "skill-fabric": "C:\\other" } },
      { ...config("SKILL_FABRIC"), allowedProjects: { "operator-canary": B6_OPERATOR_CANARY_ROOT, "skill-fabric": B6_SKILL_FABRIC_ROOT, "hermes-os": B6_HERMES_OS_ROOT } },
      { ...config("HERMES_OS"), activationScope: "B6_SKILL_FABRIC_ADMISSION" }, { ...config("HERMES_OS"), stage: "SKILL_FABRIC" }, { ...config("SKILL_FABRIC"), port: 8770 },
    ]) expect(() => validateB6RuntimeConfig(bad)).toThrow("B6_RUNTIME_CONFIG_DENIED");
  });

  it("makes Stage-2 admission preflight-only instead of accepting a deterministic public certificate", () => {
    const stageOne = stageOneCertificate();
    expect(validateB6StageOneCertification(stageOne)).toEqual(stageOne);
    expect(() => qualifyB6StageCertification({ stage: "HERMES_OS", candidateManifestSha256: "a".repeat(64), targetProjectId: "hermes-os" }))
      .toThrow("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
    expect(() => qualifyB6StageCertification({ stage: "HERMES_OS", candidateManifestSha256: "a".repeat(64), targetProjectId: "hermes-os", stageOneCertification: stageOne }))
      .toThrow("B6_STAGE_ONE_CERTIFICATION_NOT_CURRENT");
    expect(() => qualifyB6StageCertification({ stage: "HERMES_OS", candidateManifestSha256: "b".repeat(64), targetProjectId: "hermes-os", stageOneCertification: stageOne }))
      .toThrow("B6_STAGE_ONE_CERTIFICATION_NOT_CURRENT");
    expect(qualifyB6StageCertification({ stage: "SKILL_FABRIC", candidateManifestSha256: "a".repeat(64), targetProjectId: "skill-fabric" }))
      .toEqual({ stage: "SKILL_FABRIC", targetProjectId: "skill-fabric", candidateManifestSha256: "a".repeat(64) });
  });

  it("rejects malformed, extended, and tampered Stage-1 certificates before preflight", () => {
    const certificate = stageOneCertificate();
    for (const invalid of [
      { schema: certificate.schema }, { ...certificate, b6CandidateHeadSha: "not-a-git-head" }, { ...certificate, exact13Tools: false },
      { ...certificate, hermesOsDenied: false }, { ...certificate, ownedResidueCount: 1 }, { ...certificate, rollbackRecoveryClassification: "MANUAL_RECONCILIATION_REQUIRED" },
      { ...certificate, unexpected: true }, { ...certificate, certificationSha256: "f".repeat(64) },
    ]) expect(() => validateB6StageOneCertification(invalid)).toThrow("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  });

  it("retains the exact 13-tool authority envelope without exposing roots in readiness", () => {
    const metadata = createB6ReadinessMetadata(config("SKILL_FABRIC"));
    expect(OPERATOR_V1_TOOL_NAMES).toHaveLength(13);
    expect(metadata).toMatchObject({ mode: "ACTIVE", protocolMode: "operator13", stage: "SKILL_FABRIC", projectIds: ["operator-canary", "skill-fabric"], s2Enabled: false, genericExec: false, genericShell: false, destructive: "LOCKED" });
    expect(JSON.stringify(metadata)).not.toContain(B6_SKILL_FABRIC_ROOT);
  });

  it("rejects forged project identity, root substitution, and a stage-two skip", () => {
    expect(() => resolveB6Project("SKILL_FABRIC", "hermes-os")).toThrow("B6_PROJECT_NOT_ADMITTED");
    expect(() => resolveB6Project("HERMES_OS", "forged-project")).toThrow("B6_PROJECT_NOT_ADMITTED");
    expect(() => validateB6RuntimeConfig({ ...config("HERMES_OS"), allowedProjects: { "operator-canary": B6_OPERATOR_CANARY_ROOT, "skill-fabric": B6_SKILL_FABRIC_ROOT, "hermes-os": B6_SKILL_FABRIC_ROOT } })).toThrow("B6_RUNTIME_CONFIG_DENIED");
    expect(() => qualifyB6StageCertification({ stage: "HERMES_OS", targetProjectId: "hermes-os", candidateManifestSha256: "c".repeat(64) })).toThrow("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  });
});
