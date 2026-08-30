import { createHash } from "node:crypto";
import { win32 } from "node:path";

export const B6_OPERATOR_CANARY_ROOT = "C:\\Workspace\\haios-operator-canary" as const;
export const B6_SKILL_FABRIC_ROOT = "C:\\Workspace\\haios-skill-fabric" as const;
export const B6_HERMES_OS_ROOT = "C:\\Workspace\\hermes-ai-operating-system-b6-canonical" as const;
export const B6_PRODUCTION_PORT = 8769 as const;
export const B6_STAGE_ONE_TERMINAL = "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED" as const;

export type B6ProjectId = "operator-canary" | "skill-fabric" | "hermes-os";
export type B6Stage = "SKILL_FABRIC" | "HERMES_OS";
export const B6_STAGE_PROJECTS: Readonly<Record<B6Stage, readonly B6ProjectId[]>> = Object.freeze({
  SKILL_FABRIC: Object.freeze(["operator-canary", "skill-fabric"] as const),
  HERMES_OS: Object.freeze(["operator-canary", "skill-fabric", "hermes-os"] as const),
});
const ROOTS: Readonly<Record<B6ProjectId, string>> = Object.freeze({
  "operator-canary": B6_OPERATOR_CANARY_ROOT,
  "skill-fabric": B6_SKILL_FABRIC_ROOT,
  "hermes-os": B6_HERMES_OS_ROOT,
});
const CONFIG_FIELDS = new Set(["apiKeyFile", "stateRoot", "worktreeRoot", "port", "mode", "activationScope", "stage", "allowedProjects"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40,64}$/u;
export interface B6RuntimeConfig {
  readonly apiKeyFile: string;
  readonly stateRoot: string;
  readonly worktreeRoot: string;
  readonly port: typeof B6_PRODUCTION_PORT;
  readonly mode: "ACTIVE";
  readonly activationScope: "B6_SKILL_FABRIC_ADMISSION" | "B6_HERMES_OS_ADMISSION";
  readonly stage: B6Stage;
  readonly allowedProjects: Readonly<Partial<Record<B6ProjectId, string>>>;
}
export interface B6StageCertification {
  readonly schema: "HAIOS_B6_STAGE_CERTIFICATION_R1";
  readonly stage: "SKILL_FABRIC";
  readonly terminal: typeof B6_STAGE_ONE_TERMINAL;
  readonly targetProjectId: "skill-fabric";
  readonly b6CandidateHeadSha: string;
  readonly b6CandidateTrackedCount: number;
  readonly b6CandidateManifestSha256: string;
  readonly canonicalPath: typeof B6_SKILL_FABRIC_ROOT;
  readonly gitCommonDirIdentity: string;
  readonly targetHeadSha: string;
  readonly targetTrackedCount: number;
  readonly targetManifestSha256: string;
  readonly liveQualificationEvidencePath: string;
  readonly liveQualificationEvidenceSha256: string;
  readonly liveQualificationResult: "PASS";
  readonly exact13Tools: true;
  readonly projectAdmitted: true;
  readonly hermesOsDenied: true;
  readonly canonicalPreHeadSha: string;
  readonly canonicalPostHeadSha: string;
  readonly canonicalPreStatusClean: true;
  readonly canonicalPostStatusClean: true;
  readonly ownedResidueCount: 0;
  readonly effectPolicyVerified: true;
  readonly networkAuthority: "NONE";
  readonly rollbackRecoveryClassification: "SAFE_TO_ROLLBACK";
  readonly createdAt: string;
  readonly certificationSha256: string;
}
export interface B6StageQualificationInput {
  readonly stage: B6Stage;
  readonly targetProjectId: "skill-fabric" | "hermes-os";
  readonly candidateManifestSha256: string;
  readonly stageOneCertification?: B6StageCertification;
}
type UnsignedStageOneCertification = Omit<B6StageCertification, "certificationSha256">;

function deny(code = "B6_RUNTIME_CONFIG_DENIED"): never { throw new Error(code); }
function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) deny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]!))) deny();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
function sha(value: unknown): string { return createHash("sha256").update(stableJson(value), "utf8").digest("hex"); }
function sameWindowsPath(left: string, right: string): boolean { return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase(); }
function expectedPaths(): Readonly<{ apiKeyFile: string; stateRoot: string; worktreeRoot: string }> {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0) deny();
  const stateRoot = win32.join(localAppData, "HAIOS", "B6");
  return Object.freeze({ apiKeyFile: win32.join(localAppData, "HAIOS", "M10", "operator-api-key"), stateRoot, worktreeRoot: win32.join(stateRoot, "worktrees") });
}
function expectedScope(stage: B6Stage): B6RuntimeConfig["activationScope"] { return stage === "SKILL_FABRIC" ? "B6_SKILL_FABRIC_ADMISSION" : "B6_HERMES_OS_ADMISSION"; }
function exactProjects(stage: B6Stage): Readonly<Partial<Record<B6ProjectId, string>>> {
  return Object.freeze(Object.fromEntries(B6_STAGE_PROJECTS[stage].map((id) => [id, ROOTS[id]])) as Partial<Record<B6ProjectId, string>>);
}

export function validateB6RuntimeConfig(value: unknown): B6RuntimeConfig {
  const data = plain(value);
  if (Object.keys(data).length !== CONFIG_FIELDS.size || Object.keys(data).some((key) => !CONFIG_FIELDS.has(key))) deny();
  const stage = data.stage;
  if (stage !== "SKILL_FABRIC" && stage !== "HERMES_OS") deny();
  const paths = expectedPaths();
  if (data.port !== B6_PRODUCTION_PORT || data.mode !== "ACTIVE" || data.activationScope !== expectedScope(stage)
    || typeof data.apiKeyFile !== "string" || typeof data.stateRoot !== "string" || typeof data.worktreeRoot !== "string"
    || !sameWindowsPath(data.apiKeyFile, paths.apiKeyFile) || !sameWindowsPath(data.stateRoot, paths.stateRoot)
    || !sameWindowsPath(data.worktreeRoot, paths.worktreeRoot)) deny();
  const supplied = plain(data.allowedProjects);
  const expected = exactProjects(stage);
  const suppliedKeys = Object.keys(supplied).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (suppliedKeys.length !== expectedKeys.length || suppliedKeys.some((key, index) => key !== expectedKeys[index]
    || supplied[key] !== expected[key as B6ProjectId])) deny();
  return Object.freeze({ ...paths, port: B6_PRODUCTION_PORT, mode: "ACTIVE", activationScope: expectedScope(stage), stage, allowedProjects: exactProjects(stage) });
}
export function resolveB6Project(stage: B6Stage, projectId: unknown): Readonly<{ projectId: B6ProjectId; canonicalRoot: string }> {
  if (typeof projectId !== "string" || !B6_STAGE_PROJECTS[stage].includes(projectId as B6ProjectId)) deny("B6_PROJECT_NOT_ADMITTED");
  const id = projectId as B6ProjectId;
  return Object.freeze({ projectId: id, canonicalRoot: ROOTS[id] });
}
const CERT_FIELDS = Object.freeze([
  "schema","stage","terminal","targetProjectId","b6CandidateHeadSha","b6CandidateTrackedCount","b6CandidateManifestSha256","canonicalPath","gitCommonDirIdentity",
  "targetHeadSha","targetTrackedCount","targetManifestSha256","liveQualificationEvidencePath","liveQualificationEvidenceSha256","liveQualificationResult","exact13Tools",
  "projectAdmitted","hermesOsDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified",
  "networkAuthority","rollbackRecoveryClassification","createdAt","certificationSha256",
] as const);
export function sealB6StageOneCertification(input: UnsignedStageOneCertification): B6StageCertification {
  const record = plain(input) as unknown as UnsignedStageOneCertification;
  if (Object.keys(record as unknown as Record<string, unknown>).length !== CERT_FIELDS.length - 1) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  return validateB6StageOneCertification({ ...record, certificationSha256: sha(record) });
}
export function validateB6StageOneCertification(value: unknown, candidateManifestSha256?: string): B6StageCertification {
  let data: Record<string, unknown>;
  try { data = plain(value); } catch { return deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED"); }
  const keys = Object.keys(data).sort(); const expectedKeys = [...CERT_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  if (data.schema !== "HAIOS_B6_STAGE_CERTIFICATION_R1" || data.stage !== "SKILL_FABRIC" || data.terminal !== B6_STAGE_ONE_TERMINAL
    || data.targetProjectId !== "skill-fabric" || data.canonicalPath !== B6_SKILL_FABRIC_ROOT || data.liveQualificationResult !== "PASS"
    || data.exact13Tools !== true || data.projectAdmitted !== true || data.hermesOsDenied !== true || data.canonicalPreStatusClean !== true
    || data.canonicalPostStatusClean !== true || data.ownedResidueCount !== 0 || data.effectPolicyVerified !== true || data.networkAuthority !== "NONE"
    || data.rollbackRecoveryClassification !== "SAFE_TO_ROLLBACK") deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  for (const field of ["b6CandidateManifestSha256","targetManifestSha256","liveQualificationEvidenceSha256","certificationSha256"] as const) {
    if (typeof data[field] !== "string" || !SHA256.test(data[field] as string)) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  }
  for (const field of ["b6CandidateHeadSha","targetHeadSha","canonicalPreHeadSha","canonicalPostHeadSha"] as const) {
    if (typeof data[field] !== "string" || !GIT_SHA.test(data[field] as string)) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  }
  if (data.canonicalPreHeadSha !== data.targetHeadSha || data.canonicalPostHeadSha !== data.targetHeadSha) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  if (!Number.isSafeInteger(data.b6CandidateTrackedCount) || (data.b6CandidateTrackedCount as number) <= 0
    || !Number.isSafeInteger(data.targetTrackedCount) || (data.targetTrackedCount as number) <= 0
    || typeof data.gitCommonDirIdentity !== "string" || !win32.isAbsolute(data.gitCommonDirIdentity)
    || typeof data.liveQualificationEvidencePath !== "string" || !win32.isAbsolute(data.liveQualificationEvidencePath)
    || typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  if (candidateManifestSha256 !== undefined && data.b6CandidateManifestSha256 !== candidateManifestSha256) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  const { certificationSha256, ...unsigned } = data;
  if (certificationSha256 !== sha(unsigned)) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  return Object.freeze(data as unknown as B6StageCertification);
}
export function qualifyB6StageCertification(input: B6StageQualificationInput): Readonly<{
  stage: B6Stage; targetProjectId: string; candidateManifestSha256: string; stageOneCertificationSha256?: string;
}> {
  const data = plain(input);
  if (Object.keys(data).some((key) => !["stage", "targetProjectId", "candidateManifestSha256", "stageOneCertification"].includes(key))
    || (data.stage !== "SKILL_FABRIC" && data.stage !== "HERMES_OS")
    || typeof data.candidateManifestSha256 !== "string" || !SHA256.test(data.candidateManifestSha256)) deny("B6_STAGE_QUALIFICATION_DENIED");
  if (data.stage === "SKILL_FABRIC") {
    if (data.targetProjectId !== "skill-fabric" || data.stageOneCertification !== undefined) deny("B6_STAGE_QUALIFICATION_DENIED");
    return Object.freeze({ stage: "SKILL_FABRIC", targetProjectId: "skill-fabric", candidateManifestSha256: data.candidateManifestSha256 });
  }
  if (data.targetProjectId !== "hermes-os") deny("B6_STAGE_QUALIFICATION_DENIED");
  if (data.stageOneCertification === undefined) deny("B6_STAGE_ONE_CERTIFICATION_REQUIRED");
  try { validateB6StageOneCertification(data.stageOneCertification, data.candidateManifestSha256); }
  catch { return deny("B6_STAGE_ONE_CERTIFICATION_NOT_CURRENT"); }
  // A public record and deterministic digest do not establish currentness. Stage 2 is admitted
  // only by the PowerShell preflight after independently reading live Git and evidence bytes.
  return deny("B6_STAGE_ONE_CERTIFICATION_NOT_CURRENT");
}
