import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stage = process.argv[2];
const certificationPath = resolve(process.argv[3] ?? "");
const evidencePath = resolve(process.argv[4] ?? "");
if (stage !== "SKILL_FABRIC" && stage !== "HERMES_OS") throw new Error("B6_STAGE_SEAL_STAGE_REQUIRED");
const prefix = stage === "SKILL_FABRIC" ? "stage1" : "stage2";
const names = stage === "SKILL_FABRIC"
  ? { bindings: "stage1-evidence-bindings.json", sums: "SHA256SUMS.stage1.txt", seal: "stage1-final-seal.json", certSha: "stage1-final-certification.sha256" }
  : { bindings: "stage2-evidence-bindings.json", sums: "SHA256SUMS.stage2.txt", seal: "stage2-final-seal.json", certSha: "stage2-final-certification.sha256" };
const terminal = stage === "SKILL_FABRIC"
  ? "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED"
  : "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_HERMES_OS_ADMISSION_QUALIFIED";
const outDir = dirname(certificationPath);
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("B6_STAGE_SEAL_LOCALAPPDATA_REQUIRED");
const expectedRoot = resolve(localAppData, "HAIOS", "B6", "evidence", stage === "SKILL_FABRIC" ? "stage1" : "stage2");
const expectedCertificationPath = resolve(expectedRoot, stage === "SKILL_FABRIC" ? "stage1-final-certification.json" : "stage2-final-certification.json");
const expectedEvidencePath = resolve(expectedRoot, stage === "SKILL_FABRIC" ? "stage1-live-qualification.json" : "stage2-live-qualification.json");
if (certificationPath !== expectedCertificationPath || evidencePath !== expectedEvidencePath) throw new Error("B6_STAGE_ARTIFACT_PATH_DENIED");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
const canonical = (value) => `${stableJson(value)}\n`;
const certBytes = await readFile(certificationPath);
const evidenceBytes = await readFile(evidencePath);
const cert = JSON.parse(certBytes.toString("utf8"));
const evidence = JSON.parse(evidenceBytes.toString("utf8"));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preflightPath = join(repoRoot, "scripts", "preflight-b6-project-expansion.ps1");
const preflightArgs = ["-NoProfile", "-File", preflightPath, "-Stage", stage, "-CandidateManifestSha256", cert.b6CandidateManifestSha256,
  "-EvidencePath", evidencePath, "-CertificationPath", certificationPath, "-ValidateOnly"];
if (stage === "HERMES_OS") preflightArgs.push("-StageOneCertificationPath", resolve(localAppData, "HAIOS", "B6", "evidence", "stage1", "stage1-final-certification.json"));
try { execFileSync("pwsh", preflightArgs, { cwd: repoRoot, stdio: "pipe", windowsHide: true }); }
catch { throw new Error("B6_STAGE_PREFLIGHT_NOT_CURRENT"); }
const certDigest = cert.certificationSha256;
const { certificationSha256, certificationHmacSha256: _certificationHmacSha256, ...unsigned } = cert;
if (!/^[a-f0-9]{64}$/u.test(certDigest ?? "") || certDigest !== sha(Buffer.from(stableJson(unsigned), "utf8"))) throw new Error("B6_STAGE_CERTIFICATION_HASH_INVALID");
if (cert.stage !== stage || cert.terminal !== terminal || cert.liveQualificationResult !== "PASS" || evidence.stage !== stage || evidence.result !== "PASS") throw new Error("B6_STAGE_SEAL_TERMINAL_INVALID");
if (resolve(cert.liveQualificationEvidencePath) !== evidencePath || cert.liveQualificationEvidenceSha256 !== sha(evidenceBytes)) throw new Error("B6_STAGE_EVIDENCE_BINDING_INVALID");
if (evidence.b6CandidateHeadSha !== cert.b6CandidateHeadSha || evidence.b6CandidateManifestSha256 !== cert.b6CandidateManifestSha256
  || evidence.canonicalPreHeadSha !== cert.targetHeadSha || evidence.canonicalPostHeadSha !== cert.targetHeadSha
  || evidence.effectPolicyVerified !== true || evidence.networkAuthority !== "NONE" || evidence.rollbackRecoveryClassification !== "SAFE_TO_ROLLBACK") {
  throw new Error("B6_STAGE_EVIDENCE_CURRENTNESS_INVALID");
}
if (stage === "SKILL_FABRIC" && (evidence.skillFabricHeadSha !== cert.targetHeadSha || evidence.skillFabricManifestSha256 !== cert.targetManifestSha256)) throw new Error("B6_STAGE1_TARGET_BINDING_INVALID");
if (stage === "HERMES_OS" && (evidence.hermesOsHeadSha !== cert.targetHeadSha || evidence.hermesOsManifestSha256 !== cert.targetManifestSha256
  || evidence.stageOneCertificationSha256 !== cert.stageOneCertificationSha256)) throw new Error("B6_STAGE2_TARGET_BINDING_INVALID");
const bindings = Object.freeze({ schema: "HAIOS_B6_STAGE_EVIDENCE_BINDINGS_R1", stage, terminal,
  certificationPath, certificationFileSha256: sha(certBytes), certificationSha256: certDigest,
  evidencePath, evidenceSha256: sha(evidenceBytes), b6CandidateHeadSha: cert.b6CandidateHeadSha,
  b6CandidateManifestSha256: cert.b6CandidateManifestSha256, targetHeadSha: cert.targetHeadSha,
  targetManifestSha256: cert.targetManifestSha256 });
const bindingsPath = resolve(outDir, names.bindings);
await writeFile(bindingsPath, canonical(bindings), "utf8");
const bindingsBytes = await readFile(bindingsPath);
const certificateShaPath = resolve(outDir, names.certSha);
await writeFile(certificateShaPath, `${sha(certBytes)}  ${basename(certificationPath)}\n`, "utf8");
const sumsPath = resolve(outDir, names.sums);
const sums = [
  `${sha(certBytes)}  ${basename(certificationPath)}`,
  `${sha(evidenceBytes)}  ${basename(evidencePath)}`,
  `${sha(bindingsBytes)}  ${basename(bindingsPath)}`,
].join("\n") + "\n";
await writeFile(sumsPath, sums, "utf8");
const sumsBytes = await readFile(sumsPath);
const sealUnsigned = Object.freeze({ schema: "HAIOS_B6_STAGE_FINAL_SEAL_R1", stage, terminal,
  certificationFileSha256: sha(certBytes), evidenceSha256: sha(evidenceBytes), bindingsSha256: sha(bindingsBytes),
  sha256SumsSha256: sha(sumsBytes), b6CandidateHeadSha: cert.b6CandidateHeadSha,
  b6CandidateManifestSha256: cert.b6CandidateManifestSha256, targetHeadSha: cert.targetHeadSha,
  targetManifestSha256: cert.targetManifestSha256 });
const seal = Object.freeze({ ...sealUnsigned, sealSha256: sha(Buffer.from(stableJson(sealUnsigned), "utf8")) });
const sealPath = resolve(outDir, names.seal);
await writeFile(sealPath, canonical(seal), "utf8");
process.stdout.write(`${JSON.stringify({ stage, terminal, certificationPath, evidencePath, bindingsPath, sumsPath, sealPath, certificateShaPath })}\n`);
