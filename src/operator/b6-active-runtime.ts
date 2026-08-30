import { createGatewayServer, type GatewayRuntime } from "../server.js";
import type { DesktopCommanderReadClient } from "../upstream.js";

import { loadHostApiKey } from "./host-runtime-config.js";
import { createFinalB5OperatorRuntime, type M12ActiveCanaryOperatorRuntime } from "./m12-active-canary-operator-core.js";
import { M08_QUALIFIED_RUNTIME_IDENTITY } from "./qualified-control-runtime.js";
import { B6_PRODUCTION_PORT, type B6RuntimeConfig, validateB6RuntimeConfig } from "./b6-project-expansion.js";

export interface B6ReadinessMetadata {
  readonly host: "127.0.0.1";
  readonly port: typeof B6_PRODUCTION_PORT;
  readonly mode: "ACTIVE";
  readonly protocolMode: "operator13";
  readonly activationScope: "B6_SKILL_FABRIC_ADMISSION" | "B6_HERMES_OS_ADMISSION";
  readonly stage: "SKILL_FABRIC" | "HERMES_OS";
  readonly projectIds: readonly string[];
  readonly runtimeProfile: typeof M08_QUALIFIED_RUNTIME_IDENTITY.profile;
  readonly registrySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256;
  readonly effectPolicySha256: typeof M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256;
  readonly s2Enabled: false;
  readonly genericExec: false;
  readonly genericShell: false;
  readonly destructive: "LOCKED";
  readonly remediationBudget: 5;
  readonly cleanStateReplanLimit: 1;
}

function noAuthorityUpstream(): DesktopCommanderReadClient {
  const deny = async (): Promise<never> => { throw new Error("B6_UPSTREAM_DISABLED"); };
  return Object.freeze({ listDirectory: deny, readFile: deny, readMultipleFiles: deny, getFileInfo: deny, startSearch: deny,
    getMoreSearchResults: deny, stopSearch: deny, listSearches: deny, listProcesses: deny, listSessions: deny, getConfig: deny,
    close: async () => undefined });
}
function projectIds(config: B6RuntimeConfig): readonly string[] { return Object.freeze(Object.keys(config.allowedProjects).sort()); }

export function createB6ReadinessMetadata(value: unknown): B6ReadinessMetadata {
  const config = validateB6RuntimeConfig(value);
  return Object.freeze({ host: "127.0.0.1", port: B6_PRODUCTION_PORT, mode: "ACTIVE", protocolMode: "operator13",
    activationScope: config.activationScope, stage: config.stage, projectIds: projectIds(config),
    runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile, registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
    effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256, s2Enabled: false, genericExec: false,
    genericShell: false, destructive: "LOCKED", remediationBudget: 5, cleanStateReplanLimit: 1 });
}

/** Composes the certified final-B5 recovery/remediation implementation under a B6-owned state root. */
export async function createB6OperatorRuntime(value: unknown): Promise<M12ActiveCanaryOperatorRuntime> {
  const config = validateB6RuntimeConfig(value);
  return createFinalB5OperatorRuntime({ stateRoot: config.stateRoot, worktreeRoot: config.worktreeRoot, allowedProjects: config.allowedProjects });
}

export async function createB6ActiveRuntime(value: unknown): Promise<GatewayRuntime> {
  const config = validateB6RuntimeConfig(value);
  let apiKey: string;
  try { apiKey = await loadHostApiKey(config.apiKeyFile); }
  catch { throw new Error("B6_API_KEY_FILE_INVALID"); }
  return createGatewayServer({ apiKey, upstream: noAuthorityUpstream(), protocolMode: "operator13", operatorMode: "ACTIVE",
    operatorRuntime: await createB6OperatorRuntime(config), host: "127.0.0.1", port: B6_PRODUCTION_PORT });
}
