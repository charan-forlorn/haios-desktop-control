import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type TaskSandboxProfileV2 = "S0" | "S1";
export type TaskNetworkAuthority = "NONE" | "FIXTURE_ONLY";
export type TaskParamKindV2 = "relpath" | "enum";
export type TaskParamFileTypeV2 = "file" | "directory";

export interface RelpathTaskParamSchemaV2 {
  readonly kind: "relpath";
  readonly mustExist?: boolean;
  readonly fileType?: TaskParamFileTypeV2;
}

export interface EnumTaskParamSchemaV2 {
  readonly kind: "enum";
  readonly values: readonly string[];
}

export type TaskParamSchemaV2 = RelpathTaskParamSchemaV2 | EnumTaskParamSchemaV2;

export interface TaskRecipeV2 {
  readonly argvTemplate: readonly string[];
  readonly paramSchemas: Readonly<Record<string, TaskParamSchemaV2>>;
  readonly requiredParams: readonly string[];
  readonly toolchainProfile: string;
  readonly sandboxProfile: TaskSandboxProfileV2;
  readonly networkAuthority: TaskNetworkAuthority;
  readonly childProcessPolicy: "SANDBOX_OWNED_TREE";
  readonly envAllowlist: readonly string[];
  readonly effectPolicyRef: string;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
}

export interface TaskRegistryV2 {
  readonly registryId: string;
  readonly version: string;
  readonly tasks: Readonly<Record<string, TaskRecipeV2>>;
}

export interface BoundTaskRegistryV2 {
  readonly registry: TaskRegistryV2;
  readonly sha256: string;
  readonly sourcePath: string;
}

const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_ARGV_ELEMENTS = 32;
const MAX_STRING_LENGTH = 300;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/;
const SAFE_EXECUTABLES = new Set(["node", "npm"]);
const SAFE_ENV_NAMES = new Set(["CI"]);

function invalid(detail: string): never {
  throw new Error(`TASK_REGISTRY_V2_INVALID:${detail}`);
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

function nonEmptyString(value: unknown, detail: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) invalid(detail);
  return value;
}

function stringArray(value: unknown, detail: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalid(detail);
  return [...value] as string[];
}

function parseParamSchema(taskId: string, name: string, value: unknown): TaskParamSchemaV2 {
  const detail = `TASK:${taskId}:PARAM:${name}`;
  if (!isRecord(value)) invalid(detail);

  if (value.kind === "relpath") {
    const expected = ["kind"];
    if (value.mustExist !== undefined) expected.push("mustExist");
    if (value.fileType !== undefined) expected.push("fileType");
    exactKeys(value, expected, detail);
    if (value.mustExist !== undefined && typeof value.mustExist !== "boolean") invalid(`${detail}:MUST_EXIST`);
    if (value.fileType !== undefined && value.fileType !== "file" && value.fileType !== "directory") {
      invalid(`${detail}:FILE_TYPE`);
    }
    return Object.freeze({
      kind: "relpath",
      ...(value.mustExist === undefined ? {} : { mustExist: value.mustExist }),
      ...(value.fileType === undefined ? {} : { fileType: value.fileType }),
    });
  }

  if (value.kind === "enum") {
    exactKeys(value, ["kind", "values"], detail);
    const values = stringArray(value.values, `${detail}:VALUES`);
    if (
      values.length === 0
      || new Set(values).size !== values.length
      || values.some((entry) => entry.length === 0 || entry.length > MAX_STRING_LENGTH)
    ) {
      invalid(`${detail}:VALUES`);
    }
    return Object.freeze({ kind: "enum", values: Object.freeze(values) });
  }

  invalid(`${detail}:KIND`);
}

function parseBoundInteger(value: unknown, minimum: number, maximum: number, detail: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(detail);
  return value as number;
}

function parseRecipe(taskId: string, value: unknown): TaskRecipeV2 {
  if (!isRecord(value)) invalid(`TASK:${taskId}`);
  exactKeys(value, [
    "argvTemplate",
    "paramSchemas",
    "requiredParams",
    "toolchainProfile",
    "sandboxProfile",
    "networkAuthority",
    "childProcessPolicy",
    "envAllowlist",
    "effectPolicyRef",
    "timeoutMs",
    "stdoutMaxBytes",
    "stderrMaxBytes",
  ], `TASK:${taskId}`);

  const argvTemplate = stringArray(value.argvTemplate, `TASK:${taskId}:ARGV`);
  if (
    argvTemplate.length === 0
    || argvTemplate.length > MAX_ARGV_ELEMENTS
    || argvTemplate.some((entry) => entry.length === 0 || entry.length > MAX_STRING_LENGTH)
  ) {
    invalid(`TASK:${taskId}:ARGV`);
  }
  if (!SAFE_EXECUTABLES.has(argvTemplate[0]!)) invalid(`TASK:${taskId}:EXECUTABLE`);

  if (!isRecord(value.paramSchemas)) invalid(`TASK:${taskId}:PARAM_SCHEMAS`);
  const paramSchemas: Record<string, TaskParamSchemaV2> = {};
  for (const name of Object.keys(value.paramSchemas).sort()) {
    if (!PARAM_NAME.test(name)) invalid(`TASK:${taskId}:PARAM_NAME`);
    paramSchemas[name] = parseParamSchema(taskId, name, value.paramSchemas[name]);
  }

  const requiredParams = stringArray(value.requiredParams, `TASK:${taskId}:REQUIRED`);
  if (
    new Set(requiredParams).size !== requiredParams.length
    || requiredParams.some((name) => paramSchemas[name] === undefined)
  ) {
    invalid(`TASK:${taskId}:REQUIRED`);
  }

  const placeholders = new Set<string>();
  for (let index = 1; index < argvTemplate.length; index += 1) {
    const argument = argvTemplate[index]!;
    const match = PLACEHOLDER.exec(argument);
    if (match) {
      const name = match[1]!;
      if (paramSchemas[name] === undefined) invalid(`TASK:${taskId}:PLACEHOLDER:${name}`);
      placeholders.add(name);
    } else if (argument.includes("{{") || argument.includes("}}")) {
      invalid(`TASK:${taskId}:PLACEHOLDER_SYNTAX`);
    }
  }
  for (const name of Object.keys(paramSchemas)) {
    if (!placeholders.has(name)) invalid(`TASK:${taskId}:UNUSED_PARAM:${name}`);
  }
  for (const name of requiredParams) {
    if (!placeholders.has(name)) invalid(`TASK:${taskId}:REQUIRED_UNUSED:${name}`);
  }

  const toolchainProfile = nonEmptyString(value.toolchainProfile, `TASK:${taskId}:TOOLCHAIN`);
  if (!ID.test(toolchainProfile)) invalid(`TASK:${taskId}:TOOLCHAIN`);
  if (value.sandboxProfile !== "S0" && value.sandboxProfile !== "S1") invalid(`TASK:${taskId}:SANDBOX`);
  if (value.networkAuthority !== "NONE" && value.networkAuthority !== "FIXTURE_ONLY") {
    invalid(`TASK:${taskId}:NETWORK`);
  }
  if (
    (value.sandboxProfile === "S0" && value.networkAuthority !== "NONE")
    || (value.sandboxProfile === "S1" && value.networkAuthority !== "FIXTURE_ONLY")
  ) {
    invalid(`TASK:${taskId}:NETWORK_PROFILE`);
  }
  if (value.childProcessPolicy !== "SANDBOX_OWNED_TREE") invalid(`TASK:${taskId}:CHILD_PROCESS_POLICY`);

  const envAllowlist = stringArray(value.envAllowlist, `TASK:${taskId}:ENV_ALLOWLIST`);
  if (
    new Set(envAllowlist).size !== envAllowlist.length
    || envAllowlist.some((name) => !SAFE_ENV_NAMES.has(name))
  ) {
    invalid(`TASK:${taskId}:ENV_ALLOWLIST`);
  }

  const effectPolicyRef = nonEmptyString(value.effectPolicyRef, `TASK:${taskId}:EFFECT_POLICY`);
  if (!ID.test(effectPolicyRef)) invalid(`TASK:${taskId}:EFFECT_POLICY`);

  return Object.freeze({
    argvTemplate: Object.freeze(argvTemplate),
    paramSchemas: Object.freeze(paramSchemas),
    requiredParams: Object.freeze(requiredParams),
    toolchainProfile,
    sandboxProfile: value.sandboxProfile,
    networkAuthority: value.networkAuthority,
    childProcessPolicy: "SANDBOX_OWNED_TREE",
    envAllowlist: Object.freeze(envAllowlist),
    effectPolicyRef,
    timeoutMs: parseBoundInteger(value.timeoutMs, 1_000, MAX_TIMEOUT_MS, `TASK:${taskId}:TIMEOUT`),
    stdoutMaxBytes: parseBoundInteger(value.stdoutMaxBytes, 1, MAX_OUTPUT_BYTES, `TASK:${taskId}:STDOUT_MAX`),
    stderrMaxBytes: parseBoundInteger(value.stderrMaxBytes, 1, MAX_OUTPUT_BYTES, `TASK:${taskId}:STDERR_MAX`),
  });
}

export function validateTaskRegistryV2(raw: unknown): TaskRegistryV2 {
  if (!isRecord(raw)) invalid("ROOT");
  exactKeys(raw, ["registryId", "version", "tasks"], "ROOT");

  const registryId = nonEmptyString(raw.registryId, "REGISTRY_ID");
  const version = nonEmptyString(raw.version, "VERSION");
  if (!ID.test(registryId) || !VERSION.test(version)) invalid("IDENTITY");
  if (!isRecord(raw.tasks) || Object.keys(raw.tasks).length === 0) invalid("TASKS");

  const tasks: Record<string, TaskRecipeV2> = {};
  for (const taskId of Object.keys(raw.tasks).sort()) {
    if (!ID.test(taskId)) invalid(`TASK_ID:${taskId}`);
    tasks[taskId] = parseRecipe(taskId, raw.tasks[taskId]);
  }

  return Object.freeze({ registryId, version, tasks: Object.freeze(tasks) });
}

export async function loadTaskRegistryV2(sourcePath: string): Promise<BoundTaskRegistryV2> {
  const bytes = await readFile(sourcePath);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("JSON");
  }
  const registry = validateTaskRegistryV2(raw);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({ registry, sha256, sourcePath });
}
