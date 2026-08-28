import { lstat, open, realpath } from "node:fs/promises";
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
function snapshotPlainDataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) fail("M09_HOST_CONFIG_INVALID");
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("M09_HOST_CONFIG_INVALID");
  }
  if (prototype !== Object.prototype) fail("M09_HOST_CONFIG_INVALID");

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("M09_HOST_CONFIG_INVALID");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("M09_HOST_CONFIG_INVALID");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) fail("M09_HOST_CONFIG_INVALID");
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function isAbsoluteWindowsPath(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z]:[\\/]/u.test(value)
    && win32.isAbsolute(value);
}

export function validateHostOperatorLaunchConfig(value: unknown): HostOperatorLaunchConfig {
  const config = snapshotPlainDataObject(value);
  const keys = Object.keys(config);
  if (
    keys.some((key) => !CONFIG_KEYS.has(key))
    || REQUIRED_CONFIG_KEYS.some((key) => !Object.hasOwn(config, key))
  ) fail("M09_HOST_CONFIG_INVALID");

  if (!Number.isInteger(config.port) || (config.port as number) < 1024 || (config.port as number) > 65535) {
    fail("M09_PORT_INVALID");
  }
  if (config.mode !== "READ_ONLY_EMERGENCY" && config.mode !== "ACTIVE") {
    fail("M09_HOST_CONFIG_INVALID");
  }
  if (config.mode === "ACTIVE") {
    if (!Object.hasOwn(config, "activationScope")) fail("M09_ACTIVE_SCOPE_REQUIRED");
    if (config.activationScope !== "M09_TEST_ONLY") fail("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
  } else if (Object.hasOwn(config, "activationScope")) {
    fail("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
  }
  if (!isAbsoluteWindowsPath(config.apiKeyFile) || !isAbsoluteWindowsPath(config.worktreeRoot)) {
    fail("M09_HOST_CONFIG_INVALID");
  }

  const projectInput = snapshotPlainDataObject(config.allowedProjects);
  const allowedProjects: Record<string, string> = {};
  for (const projectId of Object.keys(projectInput)) {
    const root = projectInput[projectId];
    if (
      projectId.length === 0
      || projectId.length > MAX_PROJECT_ID_LENGTH
      || FORBIDDEN_PROJECT_IDS.has(projectId)
      || !isAbsoluteWindowsPath(root)
    ) fail("M09_HOST_CONFIG_INVALID");
    allowedProjects[projectId] = root;
  }

  const base: Omit<HostOperatorLaunchConfig, "activationScope"> = {
    apiKeyFile: config.apiKeyFile,
    worktreeRoot: config.worktreeRoot,
    allowedProjects: Object.freeze(allowedProjects),
    port: config.port as number,
    mode: config.mode,
  };
  return config.mode === "ACTIVE"
    ? Object.freeze({ ...base, activationScope: "M09_TEST_ONLY" as const })
    : Object.freeze(base);
}

export async function loadHostApiKey(path: string): Promise<string> {
  if (!isAbsoluteWindowsPath(path)) fail("M09_API_KEY_PATH_INVALID");

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    fail("M09_API_KEY_FILE_INVALID");
  }
  const normalizeCanonical = (value: string) => win32.normalize(value).toLowerCase();
  const requestedCanonical = normalizeCanonical(path);
  if (normalizeCanonical(canonicalPath) !== requestedCanonical) {
    fail("M09_API_KEY_FILE_INVALID");
  }

  let before;
  try {
    before = await lstat(path);
  } catch {
    fail("M09_API_KEY_FILE_INVALID");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 16 || before.size > 512) {
    fail("M09_API_KEY_FILE_INVALID");
  }

  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    fail("M09_API_KEY_FILE_INVALID");
  }

  let bytes: Buffer;
  try {
    let opened;
    try {
      opened = await handle.stat();
    } catch {
      fail("M09_API_KEY_FILE_INVALID");
    }
    const sameSnapshot = (left: typeof opened, right: typeof opened) =>
      left.dev === right.dev
      && left.ino === right.ino
      && left.birthtimeMs === right.birthtimeMs
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs;
    if (!opened.isFile() || opened.size < 16 || opened.size > 512 || !sameSnapshot(before, opened)) {
      fail("M09_API_KEY_FILE_INVALID");
    }

    let canonicalAfterOpen: string;
    let currentAfterOpen;
    try {
      canonicalAfterOpen = await realpath(path);
      currentAfterOpen = await lstat(path);
    } catch {
      fail("M09_API_KEY_FILE_INVALID");
    }
    if (
      normalizeCanonical(canonicalAfterOpen) !== requestedCanonical
      || normalizeCanonical(canonicalAfterOpen) !== normalizeCanonical(canonicalPath)
      || !currentAfterOpen.isFile()
      || currentAfterOpen.isSymbolicLink()
      || !sameSnapshot(opened, currentAfterOpen)
    ) fail("M09_API_KEY_FILE_INVALID");

    try {
      bytes = await handle.readFile();
    } catch {
      fail("M09_API_KEY_FILE_INVALID");
    }

    let afterRead;
    let current;
    let canonicalAfterRead: string;
    try {
      afterRead = await handle.stat();
      current = await lstat(path);
      canonicalAfterRead = await realpath(path);
    } catch {
      fail("M09_API_KEY_FILE_INVALID");
    }
    if (
      normalizeCanonical(canonicalAfterRead) !== requestedCanonical
      || normalizeCanonical(canonicalAfterRead) !== normalizeCanonical(canonicalPath)
      || !current.isFile()
      || current.isSymbolicLink()
      || !sameSnapshot(opened, afterRead)
      || !sameSnapshot(opened, current)
    ) fail("M09_API_KEY_FILE_INVALID");
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (bytes.length !== before.size || bytes.length < 16 || bytes.length > 512 || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
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
    || /[\p{Cc}\p{Cf}\p{White_Space}]/u.test(value)
  ) fail("M09_API_KEY_FILE_INVALID");
  return value;
}
