import { createGatewayServer, type GatewayRuntime } from "../server.js";
import type { DesktopCommanderReadClient } from "../upstream.js";

import { loadHostApiKey } from "./host-runtime-config.js";
import {
  createM12ActiveCanaryOperatorRuntime,
  createM12ActiveCanaryReadinessMetadata,
  type M12ActiveCanaryOperatorRuntime,
  type M12ActiveCanaryReadinessMetadata,
} from "./m12-active-canary-operator-core.js";
import { validateM12ActiveCanaryConfig } from "./m12-active-canary-config.js";

export {
  createM12ActiveCanaryOperatorRuntime,
  createM12ActiveCanaryReadinessMetadata,
  type M12ActiveCanaryOperatorRuntime,
  type M12ActiveCanaryReadinessMetadata,
} from "./m12-active-canary-operator-core.js";
export { M12RecoveryLeaseHeartbeat, scanM12CanonicalGitCommonDirForLocks } from "./m12-active-canary-operator-core.js";

function noAuthorityUpstream(): DesktopCommanderReadClient {
  const deny = async (): Promise<never> => { throw new Error("M12_ACTIVE_CANARY_UPSTREAM_DISABLED"); };
  return Object.freeze({
    listDirectory: deny, readFile: deny, readMultipleFiles: deny, getFileInfo: deny,
    startSearch: deny, getMoreSearchResults: deny, stopSearch: deny, listSearches: deny,
    listProcesses: deny, listSessions: deny, getConfig: deny, close: async () => undefined,
  });
}

async function loadM12ApiKey(apiKeyFile: string): Promise<string> {
  try { return await loadHostApiKey(apiKeyFile); }
  catch { throw new Error("M12_ACTIVE_CANARY_API_KEY_FILE_INVALID"); }
}

/** Gateway-only wrapper; exact M12 provenance is minted in the operator core. */
export async function createM12ActiveCanaryRuntime(config: unknown): Promise<GatewayRuntime> {
  const validated = validateM12ActiveCanaryConfig(config);
  const [apiKey, operatorRuntime] = await Promise.all([
    loadM12ApiKey(validated.apiKeyFile),
    createM12ActiveCanaryOperatorRuntime(validated),
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
