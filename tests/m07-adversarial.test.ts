import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { M07_NODE_TOOLCHAIN } from "../src/operator/sandbox-toolchains.js";
import { SandboxExecutor } from "../src/operator/sandbox-executor.js";
import { operatorFoundationStatus } from "../src/operator/protocol.js";

const ROOT = process.cwd();
const read = (relative: string) => readFile(join(ROOT, relative), "utf8");

async function exists(relative: string) {
  try { await stat(join(ROOT, relative)); return true; } catch { return false; }
}

describe("M07 adversarial authority boundaries", () => {
  it("keeps public operator13 in READ_ONLY_EMERGENCY", () => {
    expect(operatorFoundationStatus()).toMatchObject({
      mode: "READ_ONLY_EMERGENCY",
      mutationActive: false,
      destructive: "LOCKED",
    });
  });

  it("keeps M07 runner disconnected from public routing", async () => {
    const server = await read("src/server.ts");
    const foundation = await read("src/operator/server-foundation.ts");
    for (const source of [server, foundation]) {
      expect(source).not.toContain("task-runner");
      expect(source).not.toContain("sandbox-executor");
      expect(source).not.toContain("task-contract-v2");
    }
  });
  it("pins the qualified image and exposes no generic Docker primitive", () => {
    expect(M07_NODE_TOOLCHAIN.image).toBe(
      "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe",
    );
    expect(Object.getOwnPropertyNames(SandboxExecutor.prototype)).toEqual(["constructor", "execute"]);
  });

  it("contains no image-pull, privileged, host-network, or Docker-socket authority", async () => {
    const source = await read("src/operator/sandbox-executor.ts");
    expect(source).not.toContain('"pull"');
    expect(source).not.toContain('"--privileged"');
    expect(source).not.toContain('"host"');
    expect(source).not.toContain("docker.sock");
    expect(source).toContain('"--network-alias", "m07-fixture"');
  });

  it("uses execFile Docker invocation and overrides the image shell entrypoint", async () => {
    const source = await read("src/operator/sandbox-executor.ts");
    expect(source).toContain('execFile("docker"');
    expect(source).toContain('"--entrypoint", request.execution.executable');
    expect(source).not.toContain("exec(");
    expect(source).not.toContain("shell: true");
  });

  it("keeps S2 absent from M07 production configuration", async () => {
    const registry = await read("task-registry.m07.json");
    expect(registry).not.toContain('"S2"');
    expect(registry).not.toContain('"HOST_SERVICE_RESTRICTED"');
  });
  it("binds secret-sensitive descendants in the effect deny policy", async () => {
    const policy = JSON.parse(await read("task-effects.m07.json"));
    const protectedPatterns = policy.policies["default-artifacts-v1"].protectedPatterns as string[];
    expect(protectedPatterns).toEqual(expect.arrayContaining([
      ".env*", "**/.env*", "**/*secret*/**", "**/*credential*/**",
    ]));
  });

  it("requires the deterministic qualification contract before candidate freeze", async () => {
    expect(await exists("scripts/qualify-m07.ps1")).toBe(true);
    const script = await read("scripts/qualify-m07.ps1");
    for (const marker of [
      "POWERSHELL_7_REQUIRED",
      "M07_ADVERSARIAL_TESTS",
      "FULL_TEST_PASSING_COUNT",
      "SOURCE_MANIFEST_DIGEST",
      "M07_S0_PRODUCTION_TASKS=PASS",
      "M07_S1_FIXTURE_ONLY=PASS",
      "M07_EFFECT_CLASSIFICATION=PASS",
      "OPERATOR13_STILL_INACTIVE=PASS",
      "DOCKER_RESIDUE=0",
      "TUNNEL_INTEGRITY=PASS",
      "PORT_8772_FREE=PASS",
      "SECRETS_PERSISTED=FALSE",
      "HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_READY_FOR_INDEPENDENT_VERIFICATION",
    ]) expect(script).toContain(marker);
    expect(script).toContain("[StringComparer]::Ordinal");
    expect(script).not.toContain("docker pull");
  });
});