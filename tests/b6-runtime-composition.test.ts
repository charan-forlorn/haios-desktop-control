import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import * as core from "../src/operator/m12-active-canary-operator-core.js";
import { createB6ActiveRuntime } from "../src/operator/b6-active-runtime.js";
import { verifyB6StageOneAdmission } from "../src/operator/b6-stage-one-proof.js";

describe("B6 final-B5 composition boundary", () => {
  it("exposes only the B6 server-owned composition seam", () => {
    expect(Object.hasOwn(core, "createFinalB5OperatorRuntime")).toBe(false);
    expect(Object.hasOwn(core, "createB6FinalB5OperatorRuntime")).toBe(true);
  });

  it("denies direct Hermes runtime construction without authenticated Stage-1 proof", async () => {
    const previous = process.env.LOCALAPPDATA;
    const root = await mkdtemp(join(tmpdir(), "b6-stage1-auth-"));
    try {
      process.env.LOCALAPPDATA = root;
      const keyDir = join(root, "HAIOS", "M10");
      await mkdir(keyDir, { recursive: true });
      await writeFile(join(keyDir, "operator-api-key"), "0123456789abcdef0123456789abcdef\n", "utf8");
      const stateRoot = win32.join(root, "HAIOS", "B6");
      await expect(createB6ActiveRuntime({
        apiKeyFile: win32.join(root, "HAIOS", "M10", "operator-api-key"), stateRoot, worktreeRoot: win32.join(stateRoot, "worktrees"),
        port: 8769, mode: "ACTIVE", activationScope: "B6_HERMES_OS_ADMISSION", stage: "HERMES_OS",
        allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary", "skill-fabric": "C:\\Workspace\\haios-skill-fabric",
          "hermes-os": "C:\\Workspace\\hermes-ai-operating-system-b6-canonical" },
      })).rejects.toThrow("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
      const direct = (core as Record<string, unknown>).createB6FinalB5OperatorRuntime as ((value: unknown) => Promise<unknown>);
      await expect(direct({ stateRoot, worktreeRoot: win32.join(stateRoot, "worktrees"), stage: "HERMES_OS" }))
        .rejects.toThrow("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a valid authenticated Stage-1 certificate when current B6 bytes have drifted", async () => {
    const previous = process.env.LOCALAPPDATA; const root = await mkdtemp(join(tmpdir(), "b6-stale-proof-"));
    try {
      process.env.LOCALAPPDATA = root; const key = "0123456789abcdef0123456789abcdef";
      const keyDir = join(root, "HAIOS", "M10"); const evidenceDir = join(root, "HAIOS", "B6", "evidence", "stage1");
      await mkdir(keyDir, { recursive: true }); await mkdir(evidenceDir, { recursive: true }); await writeFile(join(keyDir, "operator-api-key"), `${key}\n`, "utf8");
      const stable = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
      const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex"); const hmac = (b: Buffer) => createHmac("sha256", Buffer.from(key)).update(b).digest("hex");
      const evidence = { schema:"HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1", result:"PASS", hermesOsDenied:true, b6CandidateHeadSha:"0000000000000000000000000000000000000000", b6CandidateManifestSha256:"0".repeat(64), skillFabricHeadSha:"51790d8fa098fa4b07b1424faee604dde9fa89fe", skillFabricManifestSha256:"2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340" };
      const evidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`); const evidencePath = join(evidenceDir, "stage1-live-qualification.json"); await writeFile(evidencePath, evidenceBytes);
      const unsigned: Record<string, unknown> = { schema:"HAIOS_B6_STAGE_CERTIFICATION_R1", stage:"SKILL_FABRIC", terminal:"HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED", targetProjectId:"skill-fabric", b6CandidateHeadSha:evidence.b6CandidateHeadSha, b6CandidateTrackedCount:223, b6CandidateManifestSha256:evidence.b6CandidateManifestSha256, canonicalPath:"C:\\Workspace\\haios-skill-fabric", gitCommonDirIdentity:"C:\\Workspace\\haios-skill-fabric\\.git", targetHeadSha:evidence.skillFabricHeadSha, targetTrackedCount:47, targetManifestSha256:evidence.skillFabricManifestSha256, liveQualificationEvidencePath:evidencePath, liveQualificationEvidenceSha256:sha(evidenceBytes), liveQualificationEvidenceHmacSha256:hmac(evidenceBytes), liveQualificationResult:"PASS", createdAt:new Date().toISOString() };
      const certificationSha256 = sha(Buffer.from(stable(unsigned))); const authenticated = { ...unsigned, certificationSha256 }; const cert = { ...authenticated, certificationHmacSha256:hmac(Buffer.from(stable(authenticated))) };
      await writeFile(join(evidenceDir, "stage1-final-certification.json"), `${JSON.stringify(cert)}\n`, "utf8");
      await expect(verifyB6StageOneAdmission()).rejects.toThrow("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
    } finally { if(previous===undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA=previous; await rm(root,{recursive:true,force:true}); }
  });

  it("rejects a signed current but incomplete Stage-1 proof record", async () => {
    const previous=process.env.LOCALAPPDATA; const root=await mkdtemp(join(tmpdir(),"b6-incomplete-proof-")); const key="0123456789abcdef0123456789abcdef";
    try {
      process.env.LOCALAPPDATA=root; const keyDir=join(root,"HAIOS","M10"); const evidenceDir=join(root,"HAIOS","B6","evidence","stage1"); await mkdir(keyDir,{recursive:true}); await mkdir(evidenceDir,{recursive:true}); await writeFile(join(keyDir,"operator-api-key"),`${key}\n`);
      const manifest=JSON.parse(execFileSync(process.execPath,[join(process.cwd(),"scripts","create-b6-source-manifest.mjs")],{cwd:process.cwd(),encoding:"utf8"})); const head=execFileSync("git",["rev-parse","HEAD"],{cwd:process.cwd(),encoding:"utf8"}).trim();
      const stable=(v:unknown):string=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?`[${v.map(stable).join(",")}]`:`{${Object.keys(v as Record<string,unknown>).sort().map(k=>`${JSON.stringify(k)}:${stable((v as Record<string,unknown>)[k])}`).join(",")}}`; const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex"); const hmac=(b:Buffer)=>createHmac("sha256",Buffer.from(key)).update(b).digest("hex");
      const evidence={schema:"HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1",result:"PASS",hermesOsDenied:true,b6CandidateHeadSha:head,b6CandidateManifestSha256:manifest.manifestSha256,skillFabricHeadSha:"51790d8fa098fa4b07b1424faee604dde9fa89fe",skillFabricManifestSha256:"2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340"}; const evidenceBytes=Buffer.from(`${JSON.stringify(evidence)}\n`); const evidencePath=join(evidenceDir,"stage1-live-qualification.json"); await writeFile(evidencePath,evidenceBytes);
      const unsigned:Record<string,unknown>={schema:"HAIOS_B6_STAGE_CERTIFICATION_R1",stage:"SKILL_FABRIC",terminal:"HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED",targetProjectId:"skill-fabric",b6CandidateHeadSha:head,b6CandidateTrackedCount:manifest.trackedCount,b6CandidateManifestSha256:manifest.manifestSha256,canonicalPath:"C:\\Workspace\\haios-skill-fabric",gitCommonDirIdentity:"C:\\Workspace\\haios-skill-fabric\\.git",targetHeadSha:evidence.skillFabricHeadSha,targetTrackedCount:47,targetManifestSha256:evidence.skillFabricManifestSha256,liveQualificationEvidencePath:evidencePath,liveQualificationEvidenceSha256:sha(evidenceBytes),liveQualificationEvidenceHmacSha256:hmac(evidenceBytes),liveQualificationResult:"PASS",createdAt:new Date().toISOString()}; const certificationSha256=sha(Buffer.from(stable(unsigned))); const authenticated={...unsigned,certificationSha256}; await writeFile(join(evidenceDir,"stage1-final-certification.json"),`${JSON.stringify({...authenticated,certificationHmacSha256:hmac(Buffer.from(stable(authenticated)))})}\n`);
      await expect(verifyB6StageOneAdmission()).rejects.toThrow("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
    } finally { if(previous===undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA=previous; await rm(root,{recursive:true,force:true}); }
  });

  it("denies caller-selected state paths and project maps before composition", async () => {
    const secure = (core as Record<string, unknown>).createB6FinalB5OperatorRuntime;
    expect(typeof secure).toBe("function");
    if (typeof secure !== "function") return;
    const invoke = secure as (value: unknown) => Promise<unknown>;
    await expect(invoke({ stateRoot: "C:\\other", worktreeRoot: "C:\\other\\worktrees", stage: "SKILL_FABRIC" }))
      .rejects.toThrow("M12_FINAL_B5_PROJECT_POLICY_DENIED");
    const localAppData = process.env.LOCALAPPDATA!;
    const stateRoot = win32.join(localAppData, "HAIOS", "B6");
    const worktreeRoot = win32.join(stateRoot, "worktrees");
    await expect(invoke({ stateRoot, worktreeRoot, stage: "SKILL_FABRIC", allowedProjects: { forged: "C:\\forged" } }))
      .rejects.toThrow("M12_FINAL_B5_PROJECT_POLICY_DENIED");
  });
});
