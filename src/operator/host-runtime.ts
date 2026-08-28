import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayServer, type GatewayRuntime } from "../server.js";
import type { DesktopCommanderReadClient } from "../upstream.js";
import {
  loadHostApiKey,
  validateHostOperatorLaunchConfig,
} from "./host-runtime-config.js";
import {
  createQualifiedOperatorControlRuntime,
  M08_QUALIFIED_RUNTIME_IDENTITY,
} from "./qualified-control-runtime.js";

export interface HostOperatorReadinessMetadata {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly mode: "READ_ONLY_EMERGENCY" | "ACTIVE";
  readonly protocolMode: "operator13";
  readonly activationScope?: "M09_TEST_ONLY";
  readonly projectIds: readonly string[];
  readonly runtimeProfile: typeof M08_QUALIFIED_RUNTIME_IDENTITY.profile;
  readonly registrySha256: string;
  readonly effectPolicySha256: string;
  readonly s2Enabled: false;
  readonly destructive: "LOCKED";
}

function noAuthorityUpstream(): DesktopCommanderReadClient {
  const deny = async (): Promise<never> => { throw new Error("M09_HOST_UPSTREAM_DISABLED"); };
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
    const foundationRegistryPath = join(root, "task-registry.m05.json");
    const registryPath = join(root, "task-registry.m07.json");
    const effectPolicyPath = join(root, "task-effects.m07.json");
    if (existsSync(foundationRegistryPath) && existsSync(registryPath) && existsSync(effectPolicyPath)) {
      return Object.freeze({ foundationRegistryPath, registryPath, effectPolicyPath });
    }
  }
  throw new Error("M09_RUNTIME_IDENTITY_FILES_NOT_FOUND");
}

export function createHostOperatorReadinessMetadata(config: unknown): HostOperatorReadinessMetadata {
  const validated = validateHostOperatorLaunchConfig(config);
  const base = {
    host: "127.0.0.1" as const,
    port: validated.port,
    mode: validated.mode,
    protocolMode: "operator13" as const,
    projectIds: Object.freeze(Object.keys(validated.allowedProjects).sort()),
    runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile,
    registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
    effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
    s2Enabled: false as const,
    destructive: "LOCKED" as const,
  };
  return validated.mode === "ACTIVE"
    ? Object.freeze({ ...base, activationScope: "M09_TEST_ONLY" as const })
    : Object.freeze(base);
}

export async function createHostOperatorRuntime(config: unknown): Promise<GatewayRuntime> {
  const validated = validateHostOperatorLaunchConfig(config);
  const apiKey = await loadHostApiKey(validated.apiKeyFile);
  const upstream = noAuthorityUpstream();

  if (validated.mode === "ACTIVE") {
    const paths = runtimeIdentityPaths();
    const operatorRuntime = await createQualifiedOperatorControlRuntime({
      worktreeRoot: validated.worktreeRoot,
      allowedProjects: validated.allowedProjects,
      registryPath: paths.registryPath,
      effectPolicyPath: paths.effectPolicyPath,
    });
    return createGatewayServer({
      apiKey,
      upstream,
      protocolMode: "operator13",
      operatorMode: "ACTIVE",
      operatorRuntime,
      host: "127.0.0.1",
      port: validated.port,
    });
  }

  const paths = runtimeIdentityPaths();
  return createGatewayServer({
    apiKey,
    upstream,
    protocolMode: "operator13",
    operatorMode: "READ_ONLY_EMERGENCY",
    operatorTaskRegistryPath: paths.foundationRegistryPath,
    host: "127.0.0.1",
    port: validated.port,
  });
}
