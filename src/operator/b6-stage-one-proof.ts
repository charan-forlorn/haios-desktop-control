import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadHostApiKey } from "./host-runtime-config.js";

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
  try { cert = JSON.parse(certBytes.toString("utf8")); evidence = JSON.parse(evidenceBytes.toString("utf8")); }
  catch { return deny(); }
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
    || cert.targetProjectId !== "skill-fabric" || cert.targetHeadSha !== "51790d8fa098fa4b07b1424faee604dde9fa89fe"
    || cert.targetManifestSha256 !== "2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340"
    || cert.liveQualificationEvidencePath !== evidencePath || cert.liveQualificationResult !== "PASS"
    || evidence.schema !== "HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1" || evidence.result !== "PASS"
    || evidence.hermesOsDenied !== true
    || evidence.b6CandidateHeadSha !== cert.b6CandidateHeadSha
    || evidence.b6CandidateManifestSha256 !== cert.b6CandidateManifestSha256
    || evidence.skillFabricHeadSha !== cert.targetHeadSha
    || evidence.skillFabricManifestSha256 !== cert.targetManifestSha256
    || !Number.isFinite(createdAt) || ageMs < -60_000 || ageMs > 900_000) return deny();
}
