import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateManifestExpected = process.argv[2];
const stageOnePath = resolve(process.argv[3] ?? "");
const stageTwoPath = resolve(process.argv[4] ?? "");
const verifyOnly = process.argv[5] === "--verify";
if (!/^[a-f0-9]{64}$/u.test(candidateManifestExpected ?? "")) throw new Error("B6_FINAL_CANDIDATE_MANIFEST_REQUIRED");
const finalTerminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_PROJECT_EXPANSION_QUALIFIED";
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("B6_FINAL_LOCALAPPDATA_REQUIRED");
const outDir = resolve(localAppData, "HAIOS", "B6", "evidence", "final");
const expectedStageOnePath = resolve(localAppData, "HAIOS", "B6", "evidence", "stage1", "stage1-final-certification.json");
const expectedStageTwoPath = resolve(localAppData, "HAIOS", "B6", "evidence", "stage2", "stage2-final-certification.json");
const stageOneEvidencePath = resolve(localAppData, "HAIOS", "B6", "evidence", "stage1", "stage1-live-qualification.json");
const stageTwoEvidencePath = resolve(localAppData, "HAIOS", "B6", "evidence", "stage2", "stage2-live-qualification.json");
if (stageOnePath !== expectedStageOnePath || stageTwoPath !== expectedStageTwoPath) throw new Error("B6_FINAL_ARTIFACT_PATH_DENIED");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
const canonical = (value) => `${stableJson(value)}\n`;
const operatorKeyPath = resolve(localAppData, "HAIOS", "M10", "operator-api-key");
function hexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
async function loadOperatorKey() {
  const key = (await readFile(operatorKeyPath, "utf8")).trim();
  if (key.length < 16 || key.length > 512) throw new Error("B6_FINAL_OPERATOR_KEY_INVALID");
  return key;
}
const hmac = (key, bytes) => createHmac("sha256", Buffer.from(key, "utf8")).update(bytes).digest("hex");
async function verifyStageArtifactAuthentication(certBytes, evidenceBytes, cert) {
  const key = await loadOperatorKey();
  const { certificationHmacSha256, ...authenticated } = cert;
  const { certificationSha256, ...unsigned } = authenticated;
  if (!hexEqual(certificationSha256, sha(Buffer.from(stableJson(unsigned), "utf8")))
    || !hexEqual(certificationHmacSha256, hmac(key, Buffer.from(stableJson(authenticated), "utf8")))
    || !hexEqual(cert.liveQualificationEvidenceSha256, sha(evidenceBytes))
    || !hexEqual(cert.liveQualificationEvidenceHmacSha256, hmac(key, evidenceBytes))) {
    throw new Error("B6_FINAL_STAGE_AUTHENTICATION_INVALID");
  }
}
async function git(root, args) { return (await run("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim(); }
async function repositoryFacts(root) {
  const paths = (await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const rows = [];
  for (const rel of paths) rows.push(`${sha(await readFile(join(root, rel)))}  ${rel.replaceAll("\\", "/")}`);
  return { head: await git(root, ["rev-parse", "HEAD"]), trackedCount: paths.length,
    manifestSha256: sha(Buffer.from(`${rows.join("\n")}\n`, "utf8")), clean: (await git(root, ["status", "--porcelain=v1"])) === "" };
}
function validateCertification(bytes, stage, terminal) {
  const value = JSON.parse(bytes.toString("utf8"));
  const { certificationSha256, certificationHmacSha256: _certificationHmacSha256, ...unsigned } = value;
  if (value.stage !== stage || value.terminal !== terminal || value.liveQualificationResult !== "PASS"
    || certificationSha256 !== sha(Buffer.from(stableJson(unsigned), "utf8"))) throw new Error("B6_FINAL_STAGE_CERTIFICATION_INVALID");
  return value;
}
const candidate = await repositoryFacts(repoRoot);
if (!candidate.clean || candidate.manifestSha256 !== candidateManifestExpected) throw new Error("B6_FINAL_CANDIDATE_NOT_CURRENT");
const skill = await repositoryFacts("C:\\Workspace\\haios-skill-fabric");
const hermes = await repositoryFacts("C:\\Workspace\\hermes-ai-operating-system-b6-canonical");
if (!skill.clean || skill.head !== "51790d8fa098fa4b07b1424faee604dde9fa89fe" || skill.trackedCount !== 47 || skill.manifestSha256 !== "2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340") throw new Error("B6_FINAL_SKILL_BASELINE_NOT_CURRENT");
if (!hermes.clean || hermes.head !== "94b43820e43060e4504f26e514d71d3024236871" || hermes.trackedCount !== 96 || hermes.manifestSha256 !== "cc4d70d2d61f18ea03d240808022cf4894269b8a2191752c270b2f2b1640c934") throw new Error("B6_FINAL_HERMES_BASELINE_NOT_CURRENT");
const preflight = resolve(repoRoot, "scripts", "preflight-b6-project-expansion.ps1");
await run("pwsh", ["-NoProfile", "-File", preflight, "-Stage", "SKILL_FABRIC", "-CandidateManifestSha256", candidateManifestExpected,
  "-EvidencePath", stageOneEvidencePath, "-CertificationPath", stageOnePath, "-ValidateOnly"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
await run("pwsh", ["-NoProfile", "-File", preflight, "-Stage", "HERMES_OS", "-CandidateManifestSha256", candidateManifestExpected,
  "-EvidencePath", stageTwoEvidencePath, "-CertificationPath", stageTwoPath, "-StageOneCertificationPath", stageOnePath, "-ValidateOnly"],
  { cwd: repoRoot, encoding: "utf8", windowsHide: true });
const stageOneBytes = await readFile(stageOnePath);
const stageTwoBytes = await readFile(stageTwoPath);
const stageOne = validateCertification(stageOneBytes, "SKILL_FABRIC", "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED");
const stageTwo = validateCertification(stageTwoBytes, "HERMES_OS", "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_HERMES_OS_ADMISSION_QUALIFIED");
const stageOneEvidenceBytes = await readFile(stageOneEvidencePath);
const stageTwoEvidenceBytes = await readFile(stageTwoEvidencePath);
const stageOneEvidence = JSON.parse(stageOneEvidenceBytes.toString("utf8"));
const stageTwoEvidence = JSON.parse(stageTwoEvidenceBytes.toString("utf8"));
await verifyStageArtifactAuthentication(stageOneBytes, stageOneEvidenceBytes, stageOne);
await verifyStageArtifactAuthentication(stageTwoBytes, stageTwoEvidenceBytes, stageTwo);
if (stageOne.liveQualificationEvidencePath !== stageOneEvidencePath || stageOne.liveQualificationEvidenceSha256 !== sha(stageOneEvidenceBytes)
  || stageOneEvidence.result !== "PASS" || stageOneEvidence.hermesOsDenied !== true || stageOneEvidence.effectPolicyVerified !== true
  || stageOneEvidence.networkAuthority !== "NONE" || stageOneEvidence.rollbackRecoveryClassification !== "SAFE_TO_ROLLBACK") throw new Error("B6_FINAL_STAGE1_LIVE_EVIDENCE_INVALID");
if (stageTwo.liveQualificationEvidencePath !== stageTwoEvidencePath || stageTwo.liveQualificationEvidenceSha256 !== sha(stageTwoEvidenceBytes)
  || stageTwoEvidence.result !== "PASS" || stageTwoEvidence.skillFabricRegression !== true || stageTwoEvidence.operatorCanaryRegression !== true
  || stageTwoEvidence.wrongRootDenied !== true || stageTwoEvidence.unknownProjectDenied !== true || stageTwoEvidence.effectPolicyVerified !== true
  || stageTwoEvidence.networkAuthority !== "NONE" || stageTwoEvidence.rollbackRecoveryClassification !== "SAFE_TO_ROLLBACK") throw new Error("B6_FINAL_STAGE2_LIVE_EVIDENCE_INVALID");
if (stageOne.b6CandidateHeadSha !== candidate.head || stageTwo.b6CandidateHeadSha !== candidate.head
  || stageOne.b6CandidateManifestSha256 !== candidate.manifestSha256 || stageTwo.b6CandidateManifestSha256 !== candidate.manifestSha256
  || stageOne.targetHeadSha !== skill.head || stageOne.targetManifestSha256 !== skill.manifestSha256
  || stageTwo.targetHeadSha !== hermes.head || stageTwo.targetManifestSha256 !== hermes.manifestSha256
  || resolve(stageTwo.stageOneCertificationPath) !== stageOnePath || stageTwo.stageOneCertificationSha256 !== sha(stageOneBytes)) {
  throw new Error("B6_FINAL_STAGE_BINDING_NOT_CURRENT");
}
const stageOneSealPath = resolve(dirname(stageOnePath), "stage1-final-seal.json");
const stageTwoSealPath = resolve(dirname(stageTwoPath), "stage2-final-seal.json");
const stageOneBindingsPath = resolve(dirname(stageOnePath), "stage1-evidence-bindings.json");
const stageTwoBindingsPath = resolve(dirname(stageTwoPath), "stage2-evidence-bindings.json");
const stageOneSumsPath = resolve(dirname(stageOnePath), "SHA256SUMS.stage1.txt");
const stageTwoSumsPath = resolve(dirname(stageTwoPath), "SHA256SUMS.stage2.txt");
const stageOneSealBytes = await readFile(stageOneSealPath);
const stageTwoSealBytes = await readFile(stageTwoSealPath);
const STAGE_SEAL_FIELDS = ["schema","stage","terminal","certificationFileSha256","evidenceSha256","bindingsSha256","sha256SumsSha256","b6CandidateHeadSha","b6CandidateManifestSha256","targetHeadSha","targetManifestSha256","sealSha256"].sort();
async function verifyStageSeal({ sealBytes, stage, terminal, certBytes, cert, evidenceBytes, evidencePath, bindingsPath, sumsPath }) {
  const [bindingsBytes, sumsBytes] = await Promise.all([readFile(bindingsPath), readFile(sumsPath)]);
  const value = JSON.parse(sealBytes.toString("utf8"));
  const fields = Object.keys(value).sort();
  const bindings = JSON.parse(bindingsBytes.toString("utf8"));
  const expectedSums = [
    `${sha(certBytes)}  ${basename(stage === "SKILL_FABRIC" ? stageOnePath : stageTwoPath)}`,
    `${sha(evidenceBytes)}  ${basename(evidencePath)}`,
    `${sha(bindingsBytes)}  ${basename(bindingsPath)}`,
  ].join("\n") + "\n";
  const { sealSha256, ...unsigned } = value;
  if (fields.length !== STAGE_SEAL_FIELDS.length || fields.some((field, index) => field !== STAGE_SEAL_FIELDS[index])
    || value.schema !== "HAIOS_B6_STAGE_FINAL_SEAL_R1" || value.stage !== stage || value.terminal !== terminal
    || sealSha256 !== sha(Buffer.from(stableJson(unsigned), "utf8")) || value.certificationFileSha256 !== sha(certBytes)
    || value.evidenceSha256 !== sha(evidenceBytes) || value.bindingsSha256 !== sha(bindingsBytes) || value.sha256SumsSha256 !== sha(sumsBytes)
    || sumsBytes.toString("utf8") !== expectedSums || value.b6CandidateHeadSha !== candidate.head
    || value.b6CandidateManifestSha256 !== candidate.manifestSha256 || value.targetHeadSha !== cert.targetHeadSha
    || value.targetManifestSha256 !== cert.targetManifestSha256) throw new Error("B6_FINAL_STAGE_SEAL_INVALID");
  if (bindings.schema !== "HAIOS_B6_STAGE_EVIDENCE_BINDINGS_R1" || bindings.stage !== stage || bindings.terminal !== terminal
    || resolve(bindings.certificationPath) !== (stage === "SKILL_FABRIC" ? stageOnePath : stageTwoPath)
    || bindings.certificationFileSha256 !== sha(certBytes) || bindings.certificationSha256 !== cert.certificationSha256
    || resolve(bindings.evidencePath) !== evidencePath || bindings.evidenceSha256 !== sha(evidenceBytes)
    || bindings.b6CandidateHeadSha !== candidate.head || bindings.b6CandidateManifestSha256 !== candidate.manifestSha256
    || bindings.targetHeadSha !== cert.targetHeadSha || bindings.targetManifestSha256 !== cert.targetManifestSha256) {
    throw new Error("B6_FINAL_STAGE_BINDINGS_INVALID");
  }
}
await verifyStageSeal({ sealBytes: stageOneSealBytes, stage: "SKILL_FABRIC", terminal: stageOne.terminal, certBytes: stageOneBytes,
  cert: stageOne, evidenceBytes: stageOneEvidenceBytes, evidencePath: stageOneEvidencePath, bindingsPath: stageOneBindingsPath, sumsPath: stageOneSumsPath });
await verifyStageSeal({ sealBytes: stageTwoSealBytes, stage: "HERMES_OS", terminal: stageTwo.terminal, certBytes: stageTwoBytes,
  cert: stageTwo, evidenceBytes: stageTwoEvidenceBytes, evidencePath: stageTwoEvidencePath, bindingsPath: stageTwoBindingsPath, sumsPath: stageTwoSumsPath });
const probe = await run("node", [resolve(repoRoot, "scripts", "probe-b6-project-expansion-host.mjs"), "HERMES_OS"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
const probeResult = JSON.parse(probe.stdout.trim().split(/\r?\n/u).at(-1));
if (!probeResult.exact_13_tools || !probeResult.target_admitted || !probeResult.target_rollback || probeResult.stage !== "HERMES_OS"
  || probeResult.s2_enabled !== false || probeResult.generic_exec !== false || probeResult.generic_shell !== false || probeResult.destructive !== "LOCKED") {
  throw new Error("B6_FINAL_ACTIVE_STAGE_NOT_CURRENT");
}
await mkdir(outDir, { recursive: true });
const finalCertificationPath = resolve(outDir, "b6-final-certification.json");
const finalSealPath = resolve(outDir, "b6-final-seal.json");
const sumsPath = resolve(outDir, "SHA256SUMS.final.txt");
const finalShaPath = resolve(outDir, "b6-final-certification.sha256");
if (!verifyOnly) {
  const unsigned = Object.freeze({ schema: "HAIOS_B6_PROJECT_EXPANSION_FINAL_CERTIFICATION_R1", terminal: finalTerminal,
    b6CandidateHeadSha: candidate.head, b6CandidateTrackedCount: candidate.trackedCount, b6CandidateManifestSha256: candidate.manifestSha256,
    stageOneCertificationPath: stageOnePath, stageOneCertificationFileSha256: sha(stageOneBytes), stageOneEvidencePath, stageOneEvidenceSha256: sha(stageOneEvidenceBytes), stageOneSealPath, stageOneSealSha256: sha(stageOneSealBytes),
    stageTwoCertificationPath: stageTwoPath, stageTwoCertificationFileSha256: sha(stageTwoBytes), stageTwoEvidencePath, stageTwoEvidenceSha256: sha(stageTwoEvidenceBytes), stageTwoSealPath, stageTwoSealSha256: sha(stageTwoSealBytes),
    skillFabricHeadSha: skill.head, skillFabricManifestSha256: skill.manifestSha256, hermesOsHeadSha: hermes.head, hermesOsManifestSha256: hermes.manifestSha256,
    activeStage: "HERMES_OS", exact13Tools: true, s2Enabled: false, genericExec: false, genericShell: false, destructive: "LOCKED", networkAuthority: "NONE",
    rollbackTarget: "QUALIFIED_B6_SKILL_FABRIC", createdAt: new Date().toISOString() });
  const finalCertification = Object.freeze({ ...unsigned, certificationSha256: sha(Buffer.from(stableJson(unsigned), "utf8")) });
  await writeFile(finalCertificationPath, canonical(finalCertification), "utf8");
  const finalBytes = await readFile(finalCertificationPath);
  await writeFile(finalShaPath, `${sha(finalBytes)}  ${basename(finalCertificationPath)}\n`, "utf8");
  const sums = [
    `${sha(finalBytes)}  ${basename(finalCertificationPath)}`,
    `${sha(stageOneBytes)}  ${basename(stageOnePath)}`,
    `${sha(stageOneEvidenceBytes)}  ${basename(stageOneEvidencePath)}`,
    `${sha(stageOneSealBytes)}  ${basename(stageOneSealPath)}`,
    `${sha(stageTwoBytes)}  ${basename(stageTwoPath)}`,
    `${sha(stageTwoEvidenceBytes)}  ${basename(stageTwoEvidencePath)}`,
    `${sha(stageTwoSealBytes)}  ${basename(stageTwoSealPath)}`,
  ].join("\n") + "\n";
  await writeFile(sumsPath, sums, "utf8");
  const sumsBytes = await readFile(sumsPath);
  const sealUnsigned = Object.freeze({ schema: "HAIOS_B6_PROJECT_EXPANSION_FINAL_SEAL_R1", terminal: finalTerminal,
    finalCertificationSha256: sha(finalBytes), stageOneCertificationSha256: sha(stageOneBytes), stageOneEvidenceSha256: sha(stageOneEvidenceBytes), stageOneSealSha256: sha(stageOneSealBytes),
    stageTwoCertificationSha256: sha(stageTwoBytes), stageTwoEvidenceSha256: sha(stageTwoEvidenceBytes), stageTwoSealSha256: sha(stageTwoSealBytes), sha256SumsSha256: sha(sumsBytes),
    b6CandidateHeadSha: candidate.head, b6CandidateManifestSha256: candidate.manifestSha256 });
  const seal = Object.freeze({ ...sealUnsigned, sealSha256: sha(Buffer.from(stableJson(sealUnsigned), "utf8")) });
  await writeFile(finalSealPath, canonical(seal), "utf8");
  process.stdout.write(`${JSON.stringify({ terminal: finalTerminal, finalCertificationPath, finalSealPath, sumsPath, finalShaPath })}\n`);
} else {
  const finalBytes = await readFile(finalCertificationPath);
  const finalCertification = JSON.parse(finalBytes.toString("utf8"));
  const { certificationSha256, ...unsigned } = finalCertification;
  if (finalCertification.terminal !== finalTerminal || finalCertification.b6CandidateHeadSha !== candidate.head
    || finalCertification.b6CandidateManifestSha256 !== candidate.manifestSha256 || certificationSha256 !== sha(Buffer.from(stableJson(unsigned), "utf8"))) {
    throw new Error("B6_FINAL_CERTIFICATION_REPRODUCTION_FAILED");
  }
  const sumsBytes = await readFile(sumsPath);
  const expectedSums = [
    `${sha(finalBytes)}  ${basename(finalCertificationPath)}`,
    `${sha(stageOneBytes)}  ${basename(stageOnePath)}`,
    `${sha(stageOneEvidenceBytes)}  ${basename(stageOneEvidencePath)}`,
    `${sha(stageOneSealBytes)}  ${basename(stageOneSealPath)}`,
    `${sha(stageTwoBytes)}  ${basename(stageTwoPath)}`,
    `${sha(stageTwoEvidenceBytes)}  ${basename(stageTwoEvidencePath)}`,
    `${sha(stageTwoSealBytes)}  ${basename(stageTwoSealPath)}`,
  ].join("\n") + "\n";
  if (sumsBytes.toString("utf8") !== expectedSums) throw new Error("B6_FINAL_SUMS_REPRODUCTION_FAILED");
  const finalShaText = (await readFile(finalShaPath, "utf8")).trim();
  if (finalShaText !== `${sha(finalBytes)}  ${basename(finalCertificationPath)}`) throw new Error("B6_FINAL_CERT_SHA_REPRODUCTION_FAILED");
  const seal = JSON.parse((await readFile(finalSealPath)).toString("utf8"));
  const { sealSha256, ...sealUnsigned } = seal;
  if (seal.terminal !== finalTerminal || seal.finalCertificationSha256 !== sha(finalBytes)
    || seal.stageOneCertificationSha256 !== sha(stageOneBytes) || seal.stageOneEvidenceSha256 !== sha(stageOneEvidenceBytes)
    || seal.stageOneSealSha256 !== sha(stageOneSealBytes)
    || seal.stageTwoCertificationSha256 !== sha(stageTwoBytes) || seal.stageTwoEvidenceSha256 !== sha(stageTwoEvidenceBytes)
    || seal.stageTwoSealSha256 !== sha(stageTwoSealBytes)
    || seal.sha256SumsSha256 !== sha(sumsBytes) || sealSha256 !== sha(Buffer.from(stableJson(sealUnsigned), "utf8"))) {
    throw new Error("B6_FINAL_SEAL_REPRODUCTION_FAILED");
  }
  process.stdout.write(`POST_SEAL_REPRODUCTION=PASS\n${finalTerminal}\n`);
}
