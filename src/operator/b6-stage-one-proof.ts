import { execFileSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { validateB6StageOneCertification } from "./b6-project-expansion.js";
import { loadHostApiKey } from "./host-runtime-config.js";

const B6_CANDIDATE_ROOT = "C:\\Workspace\\haios-desktop-control-b6";
const SKILL_ROOT = "C:\\Workspace\\haios-skill-fabric";
const SKILL_HEAD = "51790d8fa098fa4b07b1424faee604dde9fa89fe";
const SKILL_TRACKED_COUNT = 47;
const SKILL_MANIFEST = "2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340";

const STAGE1_EVIDENCE_FIELDS = new Set([
  "schema","stage","targetProjectId","result","b6CandidateHeadSha","b6CandidateManifestSha256",
  "skillFabricHeadSha","skillFabricManifestSha256","exact13Tools","projectAdmitted","hermesOsDenied",
  "canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean",
  "ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification",
]);
function exactRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return deny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key) || !("value" in descriptors[key]!))) return deny();
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
function hexEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function hmacHex(apiKey: string, bytes: Buffer): string {
  return createHmac("sha256", Buffer.from(apiKey, "utf8")).update(bytes).digest("hex");
}
function shaHex(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function deny(): never { throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED"); }
function gitRaw(root: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  } catch { return deny(); }
}
function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
async function repositoryFacts(root: string) {
  const paths = gitRaw(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const rows: string[] = [];
  for (const relPath of paths) {
    let bytes: Buffer;
    try { bytes = await readFile(resolve(root, relPath)); } catch { return deny(); }
    rows.push(`${shaHex(bytes)}  ${relPath.replaceAll("\\", "/")}`);
  }
  const commonRaw = gitRaw(root, ["rev-parse", "--git-common-dir"]).trim();
  let canonicalPath: string; let gitCommonDirIdentity: string;
  try {
    canonicalPath = await realpath(root);
    gitCommonDirIdentity = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
  } catch { return deny(); }
  return Object.freeze({
    canonicalPath, gitCommonDirIdentity,
    head: gitRaw(root, ["rev-parse", "--verify", "HEAD"]).trim(),
    trackedCount: paths.length,
    manifestSha256: shaHex(Buffer.from(`${rows.join("\n")}\n`, "utf8")),
    clean: gitRaw(root, ["status", "--porcelain=v1"]).trim() === "",
  });
}

export async function verifyB6StageOneAdmission(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return deny();
  const root = resolve(localAppData, "HAIOS", "B6", "evidence", "stage1");
  const certificationPath = resolve(root, "stage1-final-certification.json");
  const evidencePath = resolve(root, "stage1-live-qualification.json");
  const apiKeyPath = resolve(localAppData, "HAIOS", "M10", "operator-api-key");
  let apiKey: string; let certBytes: Buffer; let evidenceBytes: Buffer;
  try {
    [apiKey, certBytes, evidenceBytes] = await Promise.all([
      loadHostApiKey(apiKeyPath), readFile(certificationPath), readFile(evidencePath),
    ]);
  } catch { return deny(); }
  let cert: Record<string, unknown>; let evidence: Record<string, unknown>;
  try {
    cert = JSON.parse(certBytes.toString("utf8"));
    validateB6StageOneCertification(cert);
    evidence = exactRecord(JSON.parse(evidenceBytes.toString("utf8")), STAGE1_EVIDENCE_FIELDS);
  } catch { return deny(); }
  const certificationHmacSha256 = cert.certificationHmacSha256;
  const certificationSha256 = cert.certificationSha256;
  const authUnsigned = { ...cert }; delete authUnsigned.certificationHmacSha256;
  const hashUnsigned = { ...authUnsigned }; delete hashUnsigned.certificationSha256;
  if (!hexEqual(certificationHmacSha256, hmacHex(apiKey, Buffer.from(stableJson(authUnsigned), "utf8")))
    || !hexEqual(certificationSha256, shaHex(Buffer.from(stableJson(hashUnsigned), "utf8")))
    || !hexEqual(cert.liveQualificationEvidenceSha256, shaHex(evidenceBytes))
    || !hexEqual(cert.liveQualificationEvidenceHmacSha256, hmacHex(apiKey, evidenceBytes))) return deny();
  const createdAt = typeof cert.createdAt === "string" ? Date.parse(cert.createdAt) : Number.NaN;
  const ageMs = Date.now() - createdAt;
  if (cert.schema !== "HAIOS_B6_STAGE_CERTIFICATION_R1" || cert.stage !== "SKILL_FABRIC"
    || cert.terminal !== "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED"
    || cert.targetProjectId !== "skill-fabric" || cert.targetHeadSha !== SKILL_HEAD
    || cert.targetManifestSha256 !== SKILL_MANIFEST || cert.liveQualificationEvidencePath !== evidencePath
    || cert.liveQualificationResult !== "PASS" || evidence.schema !== "HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1"
    || evidence.stage !== "SKILL_FABRIC" || evidence.targetProjectId !== "skill-fabric" || evidence.result !== "PASS"
    || evidence.exact13Tools !== true || evidence.projectAdmitted !== true || evidence.hermesOsDenied !== true
    || evidence.b6CandidateHeadSha !== cert.b6CandidateHeadSha
    || evidence.b6CandidateManifestSha256 !== cert.b6CandidateManifestSha256
    || evidence.skillFabricHeadSha !== cert.targetHeadSha || evidence.skillFabricManifestSha256 !== cert.targetManifestSha256
    || evidence.canonicalPreHeadSha !== cert.targetHeadSha || evidence.canonicalPostHeadSha !== cert.targetHeadSha
    || evidence.canonicalPreStatusClean !== true || evidence.canonicalPostStatusClean !== true || evidence.ownedResidueCount !== 0
    || evidence.effectPolicyVerified !== true || evidence.networkAuthority !== "NONE" || evidence.rollbackRecoveryClassification !== "SAFE_TO_ROLLBACK"
    || !Number.isFinite(createdAt) || ageMs < -60_000 || ageMs > 900_000) return deny();

  const [candidate, skill] = await Promise.all([repositoryFacts(B6_CANDIDATE_ROOT), repositoryFacts(SKILL_ROOT)]);
  if (!candidate.clean || candidate.head !== cert.b6CandidateHeadSha || candidate.trackedCount !== cert.b6CandidateTrackedCount
    || candidate.manifestSha256 !== cert.b6CandidateManifestSha256 || !skill.clean || skill.head !== SKILL_HEAD
    || skill.trackedCount !== SKILL_TRACKED_COUNT || skill.manifestSha256 !== SKILL_MANIFEST
    || cert.targetHeadSha !== skill.head || cert.targetTrackedCount !== skill.trackedCount
    || cert.targetManifestSha256 !== skill.manifestSha256
    || typeof cert.canonicalPath !== "string" || !samePath(cert.canonicalPath, skill.canonicalPath)
    || typeof cert.gitCommonDirIdentity !== "string" || !samePath(cert.gitCommonDirIdentity, skill.gitCommonDirIdentity)) return deny();
}
