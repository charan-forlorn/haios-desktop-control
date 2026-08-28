import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type TaskSandboxProfile = "S0" | "S1";
export type TaskParamKind = "relpath" | "enum";

export interface TaskParamSchema {
  readonly kind: TaskParamKind;
  readonly mustExist?: boolean;
  readonly values?: readonly string[];
}

export interface TaskRecipe {
  readonly argvTemplate: readonly string[];
  readonly paramSchemas: Readonly<Record<string, TaskParamSchema>>;
  readonly requiredParams: readonly string[];
  readonly sandboxProfile: TaskSandboxProfile;
  readonly effectPolicyRef: string;
  readonly timeoutMs: number;
}

export interface TaskRegistry {
  readonly registryId: string;
  readonly version: string;
  readonly tasks: Readonly<Record<string, TaskRecipe>>;
}

export interface BoundTaskRegistry {
  readonly registry: TaskRegistry;
  readonly sha256: string;
  readonly sourcePath: string;
}

const MAX_TIMEOUT_MS = 600_000;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

function invalid(detail: string): never {
  throw new Error(`TASK_REGISTRY_INVALID:${detail}`);
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
  if (typeof value !== "string" || value.length === 0 || value.length > 200) invalid(detail);
  return value;
}

function stringArray(value: unknown, detail: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalid(detail);
  return [...value] as string[];
}

function parseParamSchema(name: string, value: unknown): TaskParamSchema {
  if (!isRecord(value)) invalid(`PARAM:${name}`);
  const kind = value.kind;
  if (kind === "relpath") {
    exactKeys(value, value.mustExist === undefined ? ["kind"] : ["kind", "mustExist"], `PARAM:${name}`);
    if (value.mustExist !== undefined && typeof value.mustExist !== "boolean") invalid(`PARAM:${name}:MUST_EXIST`);
    return Object.freeze({ kind, ...(value.mustExist === undefined ? {} : { mustExist: value.mustExist }) });
  }
  if (kind === "enum") {
    exactKeys(value, ["kind", "values"], `PARAM:${name}`);
    const values = stringArray(value.values, `PARAM:${name}:VALUES`);
    if (values.length === 0 || new Set(values).size !== values.length || values.some((entry) => entry.length === 0)) {
      invalid(`PARAM:${name}:VALUES`);
    }
    return Object.freeze({ kind, values: Object.freeze(values) });
  }
  invalid(`PARAM:${name}:KIND`);
}

function parseRecipe(taskId: string, value: unknown): TaskRecipe {
  if (!isRecord(value)) invalid(`TASK:${taskId}`);
  exactKeys(value, [
    "argvTemplate", "paramSchemas", "requiredParams",
    "sandboxProfile", "effectPolicyRef", "timeoutMs",
  ], `TASK:${taskId}`);

  const argv = stringArray(value.argvTemplate, `TASK:${taskId}:ARGV`);
  if (argv.length === 0 || argv.length > 32 || argv.some((entry) => entry.length === 0 || entry.length > 300)) {
    invalid(`TASK:${taskId}:ARGV`);
  }
  if (argv[0]!.includes("{{") || argv[0]!.includes("}}")) invalid(`TASK:${taskId}:EXECUTABLE`);

  if (!isRecord(value.paramSchemas)) invalid(`TASK:${taskId}:PARAM_SCHEMAS`);
  const schemas: Record<string, TaskParamSchema> = {};
  for (const [name, schema] of Object.entries(value.paramSchemas)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) invalid(`TASK:${taskId}:PARAM_NAME`);
    schemas[name] = parseParamSchema(name, schema);
  }

  const required = stringArray(value.requiredParams, `TASK:${taskId}:REQUIRED`);
  if (new Set(required).size !== required.length || required.some((name) => schemas[name] === undefined)) {
    invalid(`TASK:${taskId}:REQUIRED`);
  }

  const placeholders = new Set<string>();
  for (const arg of argv) {
    for (const match of arg.matchAll(PLACEHOLDER)) placeholders.add(match[1]!);
    const stripped = arg.replace(PLACEHOLDER, "");
    if (stripped.includes("{{") || stripped.includes("}}")) invalid(`TASK:${taskId}:PLACEHOLDER_SYNTAX`);
  }
  for (const name of placeholders) if (schemas[name] === undefined) invalid(`TASK:${taskId}:PLACEHOLDER:${name}`);
  for (const name of Object.keys(schemas)) if (!placeholders.has(name)) invalid(`TASK:${taskId}:UNUSED_PARAM:${name}`);
  for (const name of required) if (!placeholders.has(name)) invalid(`TASK:${taskId}:REQUIRED_UNUSED:${name}`);

  if (value.sandboxProfile !== "S0" && value.sandboxProfile !== "S1") invalid(`TASK:${taskId}:SANDBOX`);
  const effectPolicyRef = nonEmptyString(value.effectPolicyRef, `TASK:${taskId}:EFFECT_POLICY`);
  if (!ID.test(effectPolicyRef)) invalid(`TASK:${taskId}:EFFECT_POLICY`);
  if (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1000 || (value.timeoutMs as number) > MAX_TIMEOUT_MS) {
    invalid(`TASK:${taskId}:TIMEOUT`);
  }

  return Object.freeze({
    argvTemplate: Object.freeze(argv),
    paramSchemas: Object.freeze(schemas),
    requiredParams: Object.freeze(required),
    sandboxProfile: value.sandboxProfile,
    effectPolicyRef,
    timeoutMs: value.timeoutMs as number,
  });
}

export function validateTaskRegistry(raw: unknown): TaskRegistry {
  if (!isRecord(raw)) invalid("ROOT");
  exactKeys(raw, ["registryId", "version", "tasks"], "ROOT");

  const registryId = nonEmptyString(raw.registryId, "REGISTRY_ID");
  const version = nonEmptyString(raw.version, "VERSION");
  if (!ID.test(registryId) || !VERSION.test(version)) invalid("IDENTITY");
  if (!isRecord(raw.tasks) || Object.keys(raw.tasks).length === 0) invalid("TASKS");

  const tasks: Record<string, TaskRecipe> = {};
  for (const taskId of Object.keys(raw.tasks).sort()) {
    if (!ID.test(taskId)) invalid(`TASK_ID:${taskId}`);
    tasks[taskId] = parseRecipe(taskId, raw.tasks[taskId]);
  }

  return Object.freeze({
    registryId,
    version,
    tasks: Object.freeze(tasks),
  });
}

export async function loadTaskRegistry(sourcePath: string): Promise<BoundTaskRegistry> {
  const bytes = await readFile(sourcePath);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("JSON");
  }
  const registry = validateTaskRegistry(raw);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({ registry, sha256, sourcePath });
}
