import { access, lstat, realpath } from "node:fs/promises";
import { win32 } from "node:path";

import type {
  BoundTaskRegistryV2,
  TaskParamSchemaV2,
} from "./task-contract-v2.js";

export interface ResolvedTaskExecution {
  readonly taskId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly toolchainProfile: string;
  readonly sandboxProfile: "S0" | "S1";
  readonly networkAuthority: "NONE" | "FIXTURE_ONLY";
  readonly envAllowlist: readonly string[];
  readonly effectPolicyRef: string;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly registrySha256: string;
  readonly worktreePath: string;
}

function deny(reason: string): never {
  throw new Error(`TASK_RESOLUTION_DENIED:${reason}`);
}

function within(root: string, candidate: string): boolean {
  const base = win32.resolve(root).replace(/[\\/]+$/, "").toLowerCase();
  const value = win32.resolve(candidate).replace(/[\\/]+$/, "").toLowerCase();
  return value === base || value.startsWith(`${base}\\`);
}
function normalizeRelPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) deny("REL_PATH");
  const segments = value.replace(/\//g, "\\").split("\\");
  if (
    win32.isAbsolute(value)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) deny("REL_PATH");
  if (segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".git" || lower === ".env" || lower.startsWith(".env.")
      || lower === "secrets" || lower === "credentials" || lower.endsWith(".pem") || lower.endsWith(".key");
  })) deny("REL_PATH");
  return win32.normalize(segments.join("\\"));
}

async function nearestExistingRealpath(path: string): Promise<string> {
  let candidate = win32.resolve(path);
  const volumeRoot = win32.parse(candidate).root;
  while (true) {
    try { return win32.normalize(await realpath(candidate)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") deny("REL_PATH_REALPATH");
    }
    const parent = win32.dirname(candidate);
    if (parent === candidate || candidate === volumeRoot) deny("REL_PATH_REALPATH");
    candidate = parent;
  }
}

async function resolveRelPath(root: string, value: unknown, schema: TaskParamSchemaV2): Promise<string> {
  const rel = normalizeRelPath(value);
  const rootReal = win32.normalize(await realpath(root));
  const absolute = win32.resolve(root, rel);
  if (!within(root, absolute)) deny("REL_PATH_ESCAPE");
  const ancestor = await nearestExistingRealpath(absolute);
  if (!within(rootReal, ancestor)) deny("REL_PATH_ESCAPE");  if (schema.kind === "relpath" && schema.mustExist) {
    try {
      await access(absolute);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) deny("REL_PATH_REPARSE");
      const targetReal = win32.normalize(await realpath(absolute));
      if (!within(rootReal, targetReal)) deny("REL_PATH_ESCAPE");
      if (schema.fileType === "file" && !stat.isFile()) deny("REL_PATH_FILE_TYPE");
      if (schema.fileType === "directory" && !stat.isDirectory()) deny("REL_PATH_FILE_TYPE");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TASK_RESOLUTION_DENIED:")) throw error;
      deny("REL_PATH_MISSING");
    }
  }
  return rel.replace(/\\/g, "/");
}

function exactParamKeys(params: Readonly<Record<string, unknown>>, declared: readonly string[]): void {
  const actual = Object.keys(params).sort();
  const wanted = [...declared].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) deny("PARAM_KEYS");
}

export async function resolveTaskExecution(
  registry: BoundTaskRegistryV2,
  taskId: string,
  params: Readonly<Record<string, unknown>>,
  expectedRegistrySha256: string,
  worktreePath: string,
): Promise<ResolvedTaskExecution> {
  if (expectedRegistrySha256 !== registry.sha256) deny("REGISTRY_CURRENTNESS_MISMATCH");
  if (!Object.hasOwn(registry.registry.tasks, taskId)) deny("TASK_NOT_FOUND");
  const recipe = registry.registry.tasks[taskId]!;
  const paramNames = Object.keys(recipe.paramSchemas);
  exactParamKeys(params, paramNames);
  for (const required of recipe.requiredParams) {
    if (!Object.hasOwn(params, required)) deny("PARAM_REQUIRED");
  }
  const rootReal = win32.normalize(await realpath(worktreePath));
  if (!within(worktreePath, rootReal)) deny("WORKTREE_REALPATH");  const resolved = new Map<string, string>();
  for (const name of paramNames) {
    const schema = recipe.paramSchemas[name]!;
    const value = params[name];
    if (schema.kind === "enum") {
      if (typeof value !== "string" || !schema.values.includes(value)) deny("PARAM_ENUM");
      resolved.set(name, value);
    } else {
      resolved.set(name, await resolveRelPath(rootReal, value, schema));
    }
  }
  const argv = recipe.argvTemplate.map((argument, index) => {
    if (index === 0) return argument;
    const match = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/.exec(argument);
    if (!match) return argument;
    const value = resolved.get(match[1]!);
    if (value === undefined) deny("PARAM_UNRESOLVED");
    return value;
  });
  const result: ResolvedTaskExecution = {
    taskId,
    executable: argv[0]!,
    argv: Object.freeze(argv.slice(1)),
    toolchainProfile: recipe.toolchainProfile,
    sandboxProfile: recipe.sandboxProfile,
    networkAuthority: recipe.networkAuthority,
    envAllowlist: Object.freeze([...recipe.envAllowlist]),
    effectPolicyRef: recipe.effectPolicyRef,
    timeoutMs: recipe.timeoutMs,
    stdoutMaxBytes: recipe.stdoutMaxBytes,
    stderrMaxBytes: recipe.stderrMaxBytes,
    registrySha256: registry.sha256,
    worktreePath: rootReal,
  };
  return Object.freeze(result);
}
