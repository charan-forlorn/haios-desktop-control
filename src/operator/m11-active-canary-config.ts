import { win32 } from "node:path";

export const M11_ACTIVE_CANARY_PRODUCTION_PORT = 8769 as const;
export const M11_ACTIVE_CANARY_PROJECT_ID = "operator-canary" as const;
export const M11_ACTIVE_CANARY_PROJECT_ROOT = "C:\\Workspace\\haios-operator-canary" as const;

function expectedProductionPaths() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) deny();
  return Object.freeze({
    apiKeyFile: win32.join(localAppData, "HAIOS", "M10", "operator-api-key"),
    worktreeRoot: win32.join(localAppData, "HAIOS", "M11", "worktrees"),
  });
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

declare const m11ActiveCanaryConfigBrand: unique symbol;

export interface M11ActiveCanaryConfig {
  readonly apiKeyFile: string;
  readonly worktreeRoot: string;
  readonly allowedProjects: Readonly<{
    readonly "operator-canary": typeof M11_ACTIVE_CANARY_PROJECT_ROOT;
  }>;
  readonly port: typeof M11_ACTIVE_CANARY_PRODUCTION_PORT;
  readonly mode: "ACTIVE";
  readonly activationScope: "M11_CANARY_ONLY";
  readonly [m11ActiveCanaryConfigBrand]: true;
}

const CONFIG_KEYS = new Set([
  "apiKeyFile",
  "worktreeRoot",
  "allowedProjects",
  "port",
  "mode",
  "activationScope",
]);

function deny(): never {
  throw new Error("M11_ACTIVE_CANARY_CONFIG_DENIED");
}

function snapshotPlainDataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) deny();

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    deny();
  }
  if (prototype !== Object.prototype) deny();

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") deny();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) deny();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isAbsoluteWindowsPath(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z]:[\\/]/u.test(value)
    && win32.isAbsolute(value);
}

export function validateM11ActiveCanaryConfig(value: unknown): M11ActiveCanaryConfig {
  const config = snapshotPlainDataObject(value);
  const keys = Object.keys(config);
  const expected = expectedProductionPaths();
  if (
    keys.length !== CONFIG_KEYS.size
    || keys.some((key) => !CONFIG_KEYS.has(key))
    || !Object.hasOwn(config, "apiKeyFile")
    || !Object.hasOwn(config, "worktreeRoot")
    || !Object.hasOwn(config, "allowedProjects")
    || !Object.hasOwn(config, "port")
    || !Object.hasOwn(config, "mode")
    || !Object.hasOwn(config, "activationScope")
    || !isAbsoluteWindowsPath(config.apiKeyFile)
    || !isAbsoluteWindowsPath(config.worktreeRoot)
    || !sameWindowsPath(config.apiKeyFile, expected.apiKeyFile)
    || !sameWindowsPath(config.worktreeRoot, expected.worktreeRoot)
    || typeof config.port !== "number"
    || config.port !== M11_ACTIVE_CANARY_PRODUCTION_PORT
    || config.mode !== "ACTIVE"
    || config.activationScope !== "M11_CANARY_ONLY"
  ) deny();

  const projectInput = snapshotPlainDataObject(config.allowedProjects);
  if (
    Object.keys(projectInput).length !== 1
    || !Object.hasOwn(projectInput, M11_ACTIVE_CANARY_PROJECT_ID)
    || projectInput[M11_ACTIVE_CANARY_PROJECT_ID] !== M11_ACTIVE_CANARY_PROJECT_ROOT
  ) deny();

  return Object.freeze({
    apiKeyFile: expected.apiKeyFile,
    worktreeRoot: expected.worktreeRoot,
    allowedProjects: Object.freeze({
      [M11_ACTIVE_CANARY_PROJECT_ID]: M11_ACTIVE_CANARY_PROJECT_ROOT,
    }),
    port: M11_ACTIVE_CANARY_PRODUCTION_PORT,
    mode: "ACTIVE" as const,
    activationScope: "M11_CANARY_ONLY" as const,
  }) as M11ActiveCanaryConfig;
}
