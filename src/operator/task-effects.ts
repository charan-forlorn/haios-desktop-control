import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface TaskEffectPolicy {
  readonly allowedArtifactPatterns: readonly string[];
  readonly protectedPatterns: readonly string[];
}

export interface TaskEffectPolicySet {
  readonly policySetId: string;
  readonly version: string;
  readonly policies: Readonly<Record<string, TaskEffectPolicy>>;
}

export interface BoundTaskEffectPolicy {
  readonly policySet: TaskEffectPolicySet;
  readonly sha256: string;
  readonly sourcePath: string;
}

const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_PATTERN_LENGTH = 200;
const ALLOWED_ARTIFACT_PATTERNS = new Set([
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.cache/**",
  "coverage/**",
  "dist/**",
  "*.tsbuildinfo",
]);
const REQUIRED_PROTECTED_PATTERNS = ["src/**", ".env*", "**/.env*"] as const;
const OVERBROAD_PATTERNS = new Set(["*", "**", "**/*"]);

function invalid(detail: string): never {
  throw new Error(`TASK_EFFECT_POLICY_INVALID:${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], detail: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${detail}:KEYS`);
  }
}

function identity(value: unknown, pattern: RegExp, detail: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(detail);
  return value;
}

function parsePatterns(value: unknown, detail: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalid(detail);
  const patterns = [...value] as string[];
  if (patterns.length === 0 || new Set(patterns).size !== patterns.length) invalid(detail);
  for (const pattern of patterns) {
    if (
      pattern.length === 0
      || pattern.length > MAX_PATTERN_LENGTH
      || OVERBROAD_PATTERNS.has(pattern)
      || pattern.includes("\\")
      || pattern.includes("\0")
      || pattern.startsWith("/")
      || /^[A-Za-z]:/.test(pattern)
      || pattern.split("/").includes("..")
    ) {
      invalid(detail);
    }
  }
  return patterns;
}

function parsePolicy(policyId: string, value: unknown): TaskEffectPolicy {
  const detail = `POLICY:${policyId}`;
  if (!isRecord(value)) invalid(detail);
  exactKeys(value, ["allowedArtifactPatterns", "protectedPatterns"], detail);

  const allowedArtifactPatterns = parsePatterns(value.allowedArtifactPatterns, `${detail}:ALLOWED`);
  if (allowedArtifactPatterns.some((pattern) => !ALLOWED_ARTIFACT_PATTERNS.has(pattern))) {
    invalid(`${detail}:ALLOWED`);
  }
  const protectedPatterns = parsePatterns(value.protectedPatterns, `${detail}:PROTECTED`);
  if (REQUIRED_PROTECTED_PATTERNS.some((pattern) => !protectedPatterns.includes(pattern))) {
    invalid(`${detail}:PROTECTED_REQUIRED`);
  }

  return Object.freeze({
    allowedArtifactPatterns: Object.freeze(allowedArtifactPatterns),
    protectedPatterns: Object.freeze(protectedPatterns),
  });
}

export function validateTaskEffectPolicy(raw: unknown): TaskEffectPolicySet {
  if (!isRecord(raw)) invalid("ROOT");
  exactKeys(raw, ["policySetId", "version", "policies"], "ROOT");

  const policySetId = identity(raw.policySetId, ID, "POLICY_SET_ID");
  const version = identity(raw.version, VERSION, "VERSION");
  if (!isRecord(raw.policies) || Object.keys(raw.policies).length === 0) invalid("POLICIES");

  const policies: Record<string, TaskEffectPolicy> = {};
  for (const policyId of Object.keys(raw.policies).sort()) {
    if (!ID.test(policyId)) invalid(`POLICY_ID:${policyId}`);
    policies[policyId] = parsePolicy(policyId, raw.policies[policyId]);
  }
  return Object.freeze({ policySetId, version, policies: Object.freeze(policies) });
}

export async function loadTaskEffectPolicy(sourcePath: string): Promise<BoundTaskEffectPolicy> {
  const bytes = await readFile(sourcePath);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("JSON");
  }
  const policySet = validateTaskEffectPolicy(raw);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({ policySet, sha256, sourcePath });
}
