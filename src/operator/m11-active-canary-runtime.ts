import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayServer, type GatewayRuntime } from "../server.js";
import type { DesktopCommanderReadClient } from "../upstream.js";
import {
  validateM11ActiveCanaryConfig,
  type M11ActiveCanaryConfig,
} from "./m11-active-canary-config.js";
import { loadHostApiKey } from "./host-runtime-config.js";
import {
  createQualifiedOperatorControlRuntime,
  M08_QUALIFIED_RUNTIME_IDENTITY,
  type QualifiedOperatorControlRuntime,
} from "./qualified-control-runtime.js";

export interface M11ActiveCanaryReadinessMetadata {
  readonly host: "127.0.0.1";
  readonly port: 8769;
  readonly mode: "ACTIVE";
  readonly protocolMode: "operator13";
  readonly activationScope: "M11_CANARY_ONLY";
  readonly projectIds: readonly ["operator-canary"];
  readonly runtimeProfile: typeof M08_QUALIFIED_RUNTIME_IDENTITY.profile;
  readonly registrySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256;
  readonly effectPolicySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256;
  readonly s2Enabled: false;
  readonly genericExec: false;
  readonly genericShell: false;
  readonly destructive: "LOCKED";
}

function noAuthorityUpstream(): DesktopCommanderReadClient {
  const deny = async (): Promise<never> => { throw new Error("M11_ACTIVE_CANARY_UPSTREAM_DISABLED"); };
  return Object.freeze({
    listDirectory: deny,
    readFile: deny,
    readMultipleFiles: deny,
    getFileInfo: deny,
    startSearch: deny,
    getMoreSearchResults: deny,
    stopSearch: deny,
    listSearches: deny,
    listProcesses: deny,
    listSessions: deny,
    getConfig: deny,
    close: async () => undefined,
  });
}

function runtimeIdentityPaths() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, "../.."), resolve(moduleDir, "../../..")];
  for (const root of candidates) {
    const registryPath = join(root, "task-registry.m07.json");
    const effectPolicyPath = join(root, "task-effects.m07.json");
    if (existsSync(registryPath) && existsSync(effectPolicyPath)) {
      return Object.freeze({ root, registryPath, effectPolicyPath });
    }
  }
  throw new Error("M11_ACTIVE_CANARY_RUNTIME_IDENTITY_FILES_NOT_FOUND");
}

async function loadM11ActiveCanaryApiKey(apiKeyFile: string): Promise<string> {
  try {
    return await loadHostApiKey(apiKeyFile);
  } catch {
    throw new Error("M11_ACTIVE_CANARY_API_KEY_FILE_INVALID");
  }
}

async function createQualifiedRuntime(
  config: M11ActiveCanaryConfig,
): Promise<QualifiedOperatorControlRuntime> {
  const paths = runtimeIdentityPaths();
  return createQualifiedOperatorControlRuntime({
    worktreeRoot: config.worktreeRoot,
    allowedProjects: config.allowedProjects,
    registryPath: paths.registryPath,
    effectPolicyPath: paths.effectPolicyPath,
  });
}

export function createM11ActiveCanaryReadinessMetadata(config: unknown): M11ActiveCanaryReadinessMetadata {
  validateM11ActiveCanaryConfig(config);
  return Object.freeze({
    host: "127.0.0.1" as const,
    port: 8769 as const,
    mode: "ACTIVE" as const,
    protocolMode: "operator13" as const,
    activationScope: "M11_CANARY_ONLY" as const,
    projectIds: Object.freeze(["operator-canary"] as const),
    runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile,
    registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
    effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
    s2Enabled: false as const,
    genericExec: false as const,
    genericShell: false as const,
    destructive: "LOCKED" as const,
  });
}

export async function createM11ActiveCanaryOperatorRuntime(
  config: unknown,
): Promise<QualifiedOperatorControlRuntime> {
  return createQualifiedRuntime(validateM11ActiveCanaryConfig(config));
}

export async function createM11ActiveCanaryRuntime(config: unknown): Promise<GatewayRuntime> {
  const validated = validateM11ActiveCanaryConfig(config);
  const [apiKey, operatorRuntime] = await Promise.all([
    loadM11ActiveCanaryApiKey(validated.apiKeyFile),
    createQualifiedRuntime(validated),
  ]);
  return createGatewayServer({
    apiKey,
    upstream: noAuthorityUpstream(),
    protocolMode: "operator13",
    operatorMode: "ACTIVE",
    operatorRuntime,
    host: "127.0.0.1",
    port: validated.port,
  });
}

export interface M11DisposableFixtureConfig {
  readonly apiKeyFile: string;
  readonly worktreeRoot: string;
  readonly canonicalRoot: string;
  readonly projectId: "m11-fixture";
  readonly port: number;
  readonly mode: "ACTIVE";
  readonly activationScope: "M11_DISPOSABLE_FIXTURE_ONLY";
}

const FIXTURE_KEYS = new Set([
  "apiKeyFile", "worktreeRoot", "canonicalRoot", "projectId",
  "port", "mode", "activationScope",
]);

function fixtureDeny(): never {
  throw new Error("M11_DISPOSABLE_FIXTURE_CONFIG_DENIED");
}

function fixtureObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) fixtureDeny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fixtureDeny();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) fixtureDeny();
    out[key] = descriptor.value;
  }
  return out;
}
function validateDisposableFixtureConfig(value: unknown): M11DisposableFixtureConfig {
  const config = fixtureObject(value);
  const keys = Object.keys(config);
  const paths = runtimeIdentityPaths();
  const fixtureBase = resolve(paths.root, "runtime", "m11-fixture");
  const prefix = `${fixtureBase.toLowerCase()}\\`;
  const underFixture = (candidate: unknown) => typeof candidate === "string"
    && resolve(candidate).toLowerCase().startsWith(prefix);

  if (
    keys.length !== FIXTURE_KEYS.size
    || keys.some((key) => !FIXTURE_KEYS.has(key))
    || !underFixture(config.apiKeyFile)
    || !underFixture(config.worktreeRoot)
    || !underFixture(config.canonicalRoot)
    || config.projectId !== "m11-fixture"
    || config.mode !== "ACTIVE"
    || config.activationScope !== "M11_DISPOSABLE_FIXTURE_ONLY"
    || typeof config.port !== "number"
    || !Number.isInteger(config.port)
    || config.port < 1024
    || config.port > 65535
    || config.port === 8768
    || config.port === 8769
    || resolve(config.worktreeRoot as string) === resolve(config.canonicalRoot as string)
  ) fixtureDeny();

  return Object.freeze({
    apiKeyFile: config.apiKeyFile as string,
    worktreeRoot: config.worktreeRoot as string,
    canonicalRoot: config.canonicalRoot as string,
    projectId: "m11-fixture" as const,
    port: config.port as number,
    mode: "ACTIVE" as const,
    activationScope: "M11_DISPOSABLE_FIXTURE_ONLY" as const,
  });
}
export async function createM11DisposableFixtureRuntime(config: unknown): Promise<GatewayRuntime> {
  const validated = validateDisposableFixtureConfig(config);
  const paths = runtimeIdentityPaths();
  const [apiKey, operatorRuntime] = await Promise.all([
    loadM11ActiveCanaryApiKey(validated.apiKeyFile),
    createQualifiedOperatorControlRuntime({
      worktreeRoot: validated.worktreeRoot,
      allowedProjects: Object.freeze({ [validated.projectId]: validated.canonicalRoot }),
      registryPath: paths.registryPath,
      effectPolicyPath: paths.effectPolicyPath,
    }),
  ]);
  return createGatewayServer({
    apiKey,
    upstream: noAuthorityUpstream(),
    protocolMode: "operator13",
    operatorMode: "ACTIVE",
    operatorRuntime,
    host: "127.0.0.1",
    port: validated.port,
  });
}
