import { createHash } from "node:crypto";

export type FailureEffectClass = "NONE" | "ALLOWED_ARTIFACT" | "UNCLASSIFIED" | "PROTECTED";
export type FailureCurrentness = "CURRENT" | "STALE" | "UNKNOWN";
export type FailureSandboxClass = "S0" | "S1" | "NONE" | "UNKNOWN";

export interface FailureEffectSummary {
  readonly total: number;
  readonly allowedArtifact: number;
  readonly unclassified: number;
  readonly protected: number;
  readonly complete: boolean;
}

export interface FailureFingerprintInput {
  readonly reason: string;
  readonly taskId: string;
  readonly effectClass: FailureEffectClass;
  readonly currentness: FailureCurrentness;
  readonly sandboxClass?: FailureSandboxClass;
  readonly exitCode?: number | null;
  readonly sandboxReason?: string | null;
  readonly timedOut?: boolean | null;
  readonly effectSummary?: FailureEffectSummary;
}

interface NormalizedFailureFingerprintInput extends FailureFingerprintInput {
  readonly sandboxClass: FailureSandboxClass;
  readonly exitCode: number | null;
  readonly sandboxReason: string | null;
  readonly timedOut: boolean | null;
  readonly effectSummary: FailureEffectSummary;
}

export interface FailureFingerprint {
  readonly coarse: string;
  readonly fine: string;
}

const INPUT_FIELDS = new Set([
  "reason",
  "taskId",
  "effectClass",
  "currentness",
  "sandboxClass",
  "exitCode",
  "sandboxReason",
  "timedOut",
  "effectSummary",
]);
const REQUIRED_INPUT_FIELDS = new Set(["reason", "taskId", "effectClass", "currentness"]);
const EFFECT_SUMMARY_FIELDS = new Set([
  "total",
  "allowedArtifact",
  "unclassified",
  "protected",
  "complete",
]);
const EFFECT_CLASSES = new Set<FailureEffectClass>(["NONE", "ALLOWED_ARTIFACT", "UNCLASSIFIED", "PROTECTED"]);
const CURRENTNESS_VALUES = new Set<FailureCurrentness>(["CURRENT", "STALE", "UNKNOWN"]);
const SANDBOX_CLASSES = new Set<FailureSandboxClass>(["S0", "S1", "NONE", "UNKNOWN"]);
const EMPTY_EFFECT_SUMMARY: FailureEffectSummary = Object.freeze({
  total: 0,
  allowedArtifact: 0,
  unclassified: 0,
  protected: 0,
  complete: false,
});

type JsonValue = string | number | boolean | null | { readonly [key: string]: JsonValue };

function deny(reason: string): never {
  throw new Error(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnDataFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  fieldsError: string,
  inputError: string,
): ReadonlyMap<string, unknown> {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) deny(fieldsError);
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") return deny(fieldsError);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return deny(inputError);
    fields.set(key, descriptor.value);
  }
  for (const key of required) if (!fields.has(key)) return deny(inputError);
  return fields;
}

function code(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) {
    return deny(`FAILURE_FINGERPRINT_${field}_DENIED`);
  }
  return value;
}

function optionalCode(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return code(value, field);
}

function optionalExitCode(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    return deny("FAILURE_FINGERPRINT_EXIT_CODE_DENIED");
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") return deny(`FAILURE_FINGERPRINT_${field}_DENIED`);
  return value;
}

function effectCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return deny("FAILURE_FINGERPRINT_EFFECT_SUMMARY_DENIED");
  }
  return value;
}

function normalizeEffectSummary(value: unknown): FailureEffectSummary {
  if (value === undefined) return EMPTY_EFFECT_SUMMARY;
  if (!isRecord(value)) return deny("FAILURE_FINGERPRINT_EFFECT_SUMMARY_DENIED");
  const fields = readOwnDataFields(
    value,
    EFFECT_SUMMARY_FIELDS,
    EFFECT_SUMMARY_FIELDS,
    "FAILURE_FINGERPRINT_EFFECT_SUMMARY_DENIED",
    "FAILURE_FINGERPRINT_EFFECT_SUMMARY_DENIED",
  );
  const complete = fields.get("complete");
  if (typeof complete !== "boolean") return deny("FAILURE_FINGERPRINT_EFFECT_SUMMARY_DENIED");
  return Object.freeze({
    total: effectCount(fields.get("total")),
    allowedArtifact: effectCount(fields.get("allowedArtifact")),
    unclassified: effectCount(fields.get("unclassified")),
    protected: effectCount(fields.get("protected")),
    complete,
  });
}

function sortedJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key]!)}`).join(",")}}`;
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(sortedJson(value), "utf8").digest("hex");
}

export function normalizeFailureFingerprintInput(input: unknown): NormalizedFailureFingerprintInput {
  if (!isRecord(input)) return deny("FAILURE_FINGERPRINT_INPUT_DENIED");
  const fields = readOwnDataFields(
    input,
    INPUT_FIELDS,
    REQUIRED_INPUT_FIELDS,
    "FAILURE_FINGERPRINT_FIELDS_DENIED",
    "FAILURE_FINGERPRINT_INPUT_DENIED",
  );
  const effectClass = code(fields.get("effectClass"), "EFFECT_CLASS") as FailureEffectClass;
  const currentness = code(fields.get("currentness"), "CURRENTNESS") as FailureCurrentness;
  const sandboxClassValue = fields.get("sandboxClass");
  const sandboxClass = sandboxClassValue === undefined ? "UNKNOWN" : code(sandboxClassValue, "SANDBOX_CLASS") as FailureSandboxClass;
  if (!EFFECT_CLASSES.has(effectClass)) return deny("FAILURE_FINGERPRINT_EFFECT_CLASS_DENIED");
  if (!CURRENTNESS_VALUES.has(currentness)) return deny("FAILURE_FINGERPRINT_CURRENTNESS_DENIED");
  if (!SANDBOX_CLASSES.has(sandboxClass)) return deny("FAILURE_FINGERPRINT_SANDBOX_CLASS_DENIED");
  return Object.freeze({
    reason: code(fields.get("reason"), "REASON"),
    taskId: code(fields.get("taskId"), "TASK_ID"),
    effectClass,
    currentness,
    sandboxClass,
    exitCode: optionalExitCode(fields.get("exitCode")),
    sandboxReason: optionalCode(fields.get("sandboxReason"), "SANDBOX_REASON"),
    timedOut: optionalBoolean(fields.get("timedOut"), "TIMED_OUT"),
    effectSummary: normalizeEffectSummary(fields.get("effectSummary")),
  });
}

export function computeFailureFingerprint(input: FailureFingerprintInput): FailureFingerprint {
  const normalized = normalizeFailureFingerprintInput(input);
  const coarse = {
    reason: normalized.reason,
    taskId: normalized.taskId,
    effectClass: normalized.effectClass,
    currentness: normalized.currentness,
    sandboxClass: normalized.sandboxClass,
  } as const;
  const fine = {
    ...coarse,
    exitCode: normalized.exitCode,
    sandboxReason: normalized.sandboxReason,
    timedOut: normalized.timedOut,
    effectSummary: {
      total: normalized.effectSummary.total,
      allowedArtifact: normalized.effectSummary.allowedArtifact,
      unclassified: normalized.effectSummary.unclassified,
      protected: normalized.effectSummary.protected,
      complete: normalized.effectSummary.complete,
    },
  } as const;
  return Object.freeze({ coarse: sha256(coarse), fine: sha256(fine) });
}
