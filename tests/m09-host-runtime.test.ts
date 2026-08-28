import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHostOperatorReadinessMetadata,
  createHostOperatorRuntime,
} from "../src/operator/host-runtime.js";
import { OPERATOR_V1_TOOL_NAMES } from "../src/operator/protocol.js";
import { M08_QUALIFIED_RUNTIME_IDENTITY } from "../src/operator/qualified-control-runtime.js";
import type { GatewayRuntime } from "../src/server.js";

const roots: string[] = [];
let gateway: GatewayRuntime | undefined;
let client: Client | undefined;
const apiKey = "M09-TASK2-LOCAL-KEY-123456";

async function tempConfig(mode: "READ_ONLY_EMERGENCY" | "ACTIVE" = "READ_ONLY_EMERGENCY") {
  const root = await mkdtemp(join(tmpdir(), "m09-host-runtime-"));
  roots.push(root);
  const apiKeyFile = join(root, "api-key.txt");
  await writeFile(apiKeyFile, apiKey, "utf8");
  const base: Record<string, unknown> = {
    apiKeyFile,
    worktreeRoot: join(root, "worktrees"),
    allowedProjects: {},
    port: 18773,
    mode,
  };
  if (mode === "ACTIVE") base.activationScope = "M09_TEST_ONLY";
  return base;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n")) as Record<string, unknown>;
}

async function connect(config: Record<string, unknown>) {
  gateway = await createHostOperatorRuntime(config);
  const address = await gateway.listen();
  expect(address.host).toBe("127.0.0.1");
  client = new Client({ name: "m09-task2", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { "X-API-Key": apiKey } },
  }));
  return client;
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await gateway?.close().catch(() => undefined);
  client = undefined;
  gateway = undefined;
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("M09 host operator runtime factory", () => {
  it("creates the exact operator13 READ_ONLY_EMERGENCY surface on loopback", async () => {
    const connected = await connect(await tempConfig());
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(OPERATOR_V1_TOOL_NAMES);
    expect(listed.tools).toHaveLength(13);
    const status = payload(await connected.callTool({ name: "operator_status", arguments: {} }));
    expect(status).toMatchObject({ mode: "READ_ONLY_EMERGENCY", mutationActive: false });
  });

  it("constructs ACTIVE only through the exact M08 qualified identities", async () => {
    const connected = await connect(await tempConfig("ACTIVE"));
    const status = payload(await connected.callTool({ name: "operator_status", arguments: {} }));
    expect(status).toMatchObject({
      mode: "ACTIVE",
      qualification: "M08_CONTROLLED_WIRING",
      taskRegistrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
      effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
      destructive: "LOCKED",
    });
    const caps = payload(await connected.callTool({ name: "operator_capabilities", arguments: {} }));
    expect(caps).toMatchObject({ s2Enabled: false, genericExec: false, genericShell: false });
  });

  it("requires M09_TEST_ONLY and rejects every runtime/host/identity injection field", async () => {
    const missingScope = await tempConfig();
    missingScope.mode = "ACTIVE";
    await expect(createHostOperatorRuntime(missingScope)).rejects.toThrow("M09_ACTIVE_SCOPE_REQUIRED");

    for (const field of ["host", "upstream", "operatorRuntime", "registryPath", "effectPolicyPath"] as const) {
      const config = await tempConfig();
      config[field] = field === "host" ? "0.0.0.0" : {};
      await expect(createHostOperatorRuntime(config)).rejects.toThrow("M09_HOST_CONFIG_INVALID");
    }
  });

  it("returns frozen non-secret readiness metadata without key or project paths", async () => {
    const config = await tempConfig("ACTIVE");
    const root = roots.at(-1)!;
    const projects: Record<string, string> = { demo: join(root, "canonical") };
    config.allowedProjects = projects;
    const metadata = createHostOperatorReadinessMetadata(config);
    projects.extra = join(root, "extra");
    const serialized = JSON.stringify(metadata);

    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.projectIds)).toBe(true);
    expect(metadata).toMatchObject({
      host: "127.0.0.1",
      port: 18773,
      mode: "ACTIVE",
      protocolMode: "operator13",
      activationScope: "M09_TEST_ONLY",
      projectIds: ["demo"],
      runtimeProfile: M08_QUALIFIED_RUNTIME_IDENTITY.profile,
      registrySha256: M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256,
      effectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
      s2Enabled: false,
      destructive: "LOCKED",
    });
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(String(config.apiKeyFile));
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("extra");
  });
});
