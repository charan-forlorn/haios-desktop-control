import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createGatewayServer, type GatewayRuntime } from "../server.js";
import type { DesktopCommanderReadClient } from "../upstream.js";

import { loadHostApiKey } from "./host-runtime-config.js";
import { createB6FinalB5OperatorRuntime, type M12ActiveCanaryOperatorRuntime } from "./m12-active-canary-operator-core.js";
import { M08_QUALIFIED_RUNTIME_IDENTITY } from "./qualified-control-runtime.js";
import { B6_PRODUCTION_PORT, type B6RuntimeConfig, validateB6RuntimeConfig } from "./b6-project-expansion.js";

export interface B6ReadinessMetadata {
  readonly host: "127.0.0.1";
  readonly port: typeof B6_PRODUCTION_PORT;
  readonly mode: "ACTIVE";
  readonly protocolMode: "operator13";
  readonly activationScope: "B6_SKILL_FABRIC_ADMISSION" | "B6_HERMES_OS_ADMISSION";
  readonly stage: "SKILL_FABRIC" | "HERMES_OS";
  readonly projectIds: readonly string[];
  readonly runtimeProfile: typeof M08_QUALIFIED_RUNTIME_IDENTITY.profile;
  readonly registrySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256;
  readonly effectPolicySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256;
  readonly s2Enabled: false;
  readonly genericExec: false;
  readonly genericShell: false;
  readonly destructive: "LOCKED";
  readonly remediationBudget: 5;
  readonly cleanStateReplanLimit: 1;
}

function noAuthorityUpstream(): DesktopCommanderReadClient {
  const deny = async (): Promise<never> => { throw new Error("B6_UPSTREAM_DISABLED"); };
  return Object.freeze({ listDirectory: deny, readFile: deny, readMultipleFiles: deny, getFileInfo: deny, startSearch: deny,
    getMoreSearchResults: deny, stopSearch: deny, listSearches: deny, listProcesses: deny, listSessions: deny, getConfig: deny,
    close: async () => undefined });
}
function projectIds(config: B6RuntimeConfig): readonly string[] { return Object.freeze(Object.keys(config.allowedProjects).sort()); }

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
function hmacHex(apiKey: string, bytes: Buffer): string { return createHmac("sha256", Buffer.from(apiKey, "utf8")).update(bytes).digest("hex"); }
function shaHex(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function verifyB6StageOneAdmission(apiKey: string): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
  const root = resolve(localAppData, "HAIOS", "B6", "evidence", "stage1");
  const certificationPath = resolve(root, "stage1-final-certification.json");
  const evidencePath = resolve(root, "stage1-live-qualification.json");
  let certBytes: Buffer; let evidenceBytes: Buffer;
  try { [certBytes, evidenceBytes] = await Promise.all([readFile(certificationPath), readFile(evidencePath)]); }
  catch { throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED"); }
  let cert: Record<string, unknown>; let evidence: Record<string, unknown>;
  try { cert = JSON.parse(certBytes.toString("utf8")); evidence = JSON.parse(evidenceBytes.toString("utf8")); }
  catch { throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED"); }
  const certificationHmacSha256 = cert.certificationHmacSha256;
  const certificationSha256 = cert.certificationSha256;
  const authUnsigned = { ...cert }; delete authUnsigned.certificationHmacSha256;
  const hashUnsigned = { ...authUnsigned }; delete hashUnsigned.certificationSha256;
  if (!hexEqual(certificationHmacSha256, hmacHex(apiKey, Buffer.from(stableJson(authUnsigned), "utf8")))
    || !hexEqual(certificationSha256, shaHex(Buffer.from(stableJson(hashUnsigned), "utf8")))
    || !hexEqual(cert.liveQualificationEvidenceSha256, shaHex(evidenceBytes))
    || !hexEqual(cert.liveQualificationEvidenceHmacSha256, hmacHex(apiKey, evidenceBytes))) {
    throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
  }
  const createdAt = typeof cert.createdAt === "string" ? Date.parse(cert.createdAt) : Number.NaN;
  const ageMs = Date.now() - createdAt;
  if (cert.schema !== "HAIOS_B6_STAGE_CERTIFICATION_R1" || cert.stage !== "SKILL_FABRIC"
    || cert.terminal !== "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED"
    || cert.targetProjectId !== "skill-fabric" || cert.targetHeadSha !== "51790d8fa098fa4b07b1424faee604dde9fa89fe"
    || cert.targetManifestSha256 !== "2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340"
    || cert.liveQualificationEvidencePath !== evidencePath || cert.liveQualificationResult !== "PASS"
    || evidence.schema !== "HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1" || evidence.result !== "PASS" || evidence.hermesOsDenied !== true
    || !Number.isFinite(createdAt) || ageMs < -60_000 || ageMs > 900_000) throw new Error("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
}

export function createB6ReadinessMetadata(value: unknown): B6ReadinessMetadata {
  const config = validateB6RuntimeConfig(value);
  return Object.freeze({ host: "127.0.0.1", port: B6_PRODUCTION_PORT, mode: "ACTIVE", protocolMode: "operator13",
    activationScope: config.activationScope, stage: config.stage, projectIds: projectIds(config),
    runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile, registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
    effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256, s2Enabled: false, genericExec: false,
    genericShell: false, destructive: "LOCKED", remediationBudget: 5, cleanStateReplanLimit: 1 });
}

/** Composes the certified final-B5 recovery/remediation implementation under a B6-owned state root. */
export async function createB6OperatorRuntime(value: unknown): Promise<M12ActiveCanaryOperatorRuntime> {
  const config = validateB6RuntimeConfig(value);
  return createB6FinalB5OperatorRuntime({ stateRoot: config.stateRoot, worktreeRoot: config.worktreeRoot, stage: config.stage });
}

export async function createB6ActiveRuntime(value: unknown): Promise<GatewayRuntime> {
  const config = validateB6RuntimeConfig(value);
  let apiKey: string;
  try { apiKey = await loadHostApiKey(config.apiKeyFile); }
  catch { throw new Error("B6_API_KEY_FILE_INVALID"); }
  if (config.stage === "HERMES_OS") await verifyB6StageOneAdmission(apiKey);
  return createGatewayServer({ apiKey, upstream: noAuthorityUpstream(), protocolMode: "operator13", operatorMode: "ACTIVE",
    operatorRuntime: await createB6OperatorRuntime(config), host: "127.0.0.1", port: B6_PRODUCTION_PORT });
}
