import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { TextDecoder } from "node:util";

export interface HostOperatorLaunchConfig {
  apiKeyFile: string;
  worktreeRoot: string;
  allowedProjects: Readonly<Record<string, string>>;
  port: number;
  mode: "READ_ONLY_EMERGENCY" | "ACTIVE";
  activationScope?: "M09_TEST_ONLY";
}

const CONFIG_KEYS = new Set([
  "apiKeyFile",
  "worktreeRoot",
  "allowedProjects",
  "port",
  "mode",
  "activationScope",
]);
const REQUIRED_CONFIG_KEYS = ["apiKeyFile", "worktreeRoot", "allowedProjects", "port", "mode"] as const;
const MAX_PROJECT_ID_LENGTH = 128;
const FORBIDDEN_PROJECT_IDS = new Set(["__proto__", "prototype", "constructor"]);

function fail(code: string): never { throw new Error(code); }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
function isAbsoluteWindowsPath(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z]:[\\/]/u.test(value)
    && win32.isAbsolute(value);
}

export function validateHostOperatorLaunchConfig(value: unknown): HostOperatorLaunchConfig {
  if (!isPlainObject(value)) fail("M09_HOST_CONFIG_INVALID");
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !CONFIG_KEYS.has(key))
    || REQUIRED_CONFIG_KEYS.some((key) => !Object.hasOwn(value, key))
  ) fail("M09_HOST_CONFIG_INVALID");

  if (!Number.isInteger(value.port) || (value.port as number) < 1024 || (value.port as number) > 65535) {
    fail("M09_PORT_INVALID");
  }
  if (value.mode !== "READ_ONLY_EMERGENCY" && value.mode !== "ACTIVE") {
    fail("M09_HOST_CONFIG_INVALID");
  }
  if (value.mode === "ACTIVE") {
    if (!Object.hasOwn(value, "activationScope")) fail("M09_ACTIVE_SCOPE_REQUIRED");
    if (value.activationScope !== "M09_TEST_ONLY") fail("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
  } else if (Object.hasOwn(value, "activationScope")) {
    fail("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
  }
  if (!isAbsoluteWindowsPath(value.apiKeyFile) || !isAbsoluteWindowsPath(value.worktreeRoot)) {
    fail("M09_HOST_CONFIG_INVALID");
  }
  if (!isPlainObject(value.allowedProjects)) fail("M09_HOST_CONFIG_INVALID");

  const allowedProjects: Record<string, string> = {};
  const projectIds = Reflect.ownKeys(value.allowedProjects);
  if (projectIds.some((projectId) => typeof projectId !== "string")) {
    fail("M09_HOST_CONFIG_INVALID");
  }
  for (const projectId of projectIds as string[]) {
    if (
      projectId.length === 0
      || projectId.length > MAX_PROJECT_ID_LENGTH
      || FORBIDDEN_PROJECT_IDS.has(projectId)
      || !isAbsoluteWindowsPath(value.allowedProjects[projectId])
    ) fail("M09_HOST_CONFIG_INVALID");
    allowedProjects[projectId] = value.allowedProjects[projectId];
  }

  const base: Omit<HostOperatorLaunchConfig, "activationScope"> = {
    apiKeyFile: value.apiKeyFile,
    worktreeRoot: value.worktreeRoot,
    allowedProjects: Object.freeze(allowedProjects),
    port: value.port as number,
    mode: value.mode,
  };
  return value.mode === "ACTIVE"
    ? Object.freeze({ ...base, activationScope: "M09_TEST_ONLY" as const })
    : Object.freeze(base);
}

export async function loadHostApiKey(path: string): Promise<string> {
  if (!isAbsoluteWindowsPath(path)) fail("M09_API_KEY_PATH_INVALID");

  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail("M09_API_KEY_FILE_INVALID");
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 16 || stats.size > 512) {
    fail("M09_API_KEY_FILE_INVALID");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    fail("M09_API_KEY_FILE_INVALID");
  }
  if (bytes.length !== stats.size || bytes.length < 16 || bytes.length > 512) {
    fail("M09_API_KEY_FILE_INVALID");
  }

  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M09_API_KEY_FILE_INVALID");
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);

  const characterCount = [...value].length;
  if (
    characterCount < 16
    || characterCount > 512
    || /[\0\r\n]/u.test(value)
    || value.trim() !== value
  ) fail("M09_API_KEY_FILE_INVALID");
  return value;
}
