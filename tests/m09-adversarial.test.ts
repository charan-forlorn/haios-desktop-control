import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadHostApiKey,
  validateHostOperatorLaunchConfig,
} from "../src/operator/host-runtime-config.js";
import { createHostOperatorReadinessMetadata } from "../src/operator/host-runtime.js";
import { M08_QUALIFIED_RUNTIME_IDENTITY } from "../src/operator/qualified-control-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await rm(root, { recursive: true, force: true });
  }
});

function validConfig(): Record<string, unknown> {
  return {
    apiKeyFile: "C:\\operator\\m09.key",
    worktreeRoot: "C:\\operator\\worktrees",
    allowedProjects: { demo: "C:\\projects\\demo" },
    port: 8773,
    mode: "READ_ONLY_EMERGENCY",
  };
}

describe("M09 adversarial authority boundary", () => {
  it("rejects caller-supplied secret, network, runtime, executable, env, and registry authority", () => {
    const forbidden = [
      { apiKey: "INLINE_SECRET" },
      { host: "0.0.0.0" },
      { upstream: {} },
      { operatorRuntime: {} },
      { registryPath: "C:\\attacker\\registry.json" },
      { effectPolicyPath: "C:\\attacker\\effects.json" },
      { executable: "cmd.exe" },
      { cwd: "C:\\attacker" },
      { env: { PATH: "C:\\attacker" } },
      { tunnelId: "tunnel_deadbeefdeadbeefdeadbeefdeadbeef" },
      { dockerSocket: "//./pipe/docker_engine" },
    ];
    for (const extra of forbidden) {
      expect(() => validateHostOperatorLaunchConfig({ ...validConfig(), ...extra }))
        .toThrow("M09_HOST_CONFIG_INVALID");
    }
  });

  it("requires the exact test-only scope for ACTIVE", () => {
    expect(() => validateHostOperatorLaunchConfig({ ...validConfig(), mode: "ACTIVE" }))
      .toThrow("M09_ACTIVE_SCOPE_REQUIRED");
    expect(() => validateHostOperatorLaunchConfig({
      ...validConfig(), mode: "ACTIVE", activationScope: "PRODUCTION",
    })).toThrow("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
  });

  it("snapshots project authority and inherits immutable M08 provenance", () => {
    const config = validConfig();
    const projects = config.allowedProjects as Record<string, string>;
    const metadata = createHostOperatorReadinessMetadata(config);
    projects.evil = "C:\\projects\\evil";

    expect(metadata.host).toBe("127.0.0.1");
    expect(metadata.projectIds).toEqual(["demo"]);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.projectIds)).toBe(true);
    expect(metadata.runtimeProfile).toBe(M08_QUALIFIED_RUNTIME_IDENTITY.profile);
    expect(metadata.registrySha256).toBe(M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256);
    expect(metadata.effectPolicySha256).toBe(M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256);
    expect(metadata.s2Enabled).toBe(false);
    expect(metadata.destructive).toBe("LOCKED");
  });

  it("rejects a secret path traversing a junction ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "m09-adv-"));
    roots.push(root);
    const targetDir = join(root, "real");
    const linkDir = join(root, "linked");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "secret.key"), "q".repeat(32), "utf8");
    await symlink(targetDir, linkDir, "junction");
    await expect(loadHostApiKey(join(linkDir, "secret.key")))
      .rejects.toThrow("M09_API_KEY_FILE_INVALID");
  });
});

import { readFile as readText } from "node:fs/promises";

describe("M09 qualification fail-closed contract", () => {
  it("requires long-lived emergency mode before any disposable ACTIVE proof", async () => {
    const qualifier = await readText(join(process.cwd(), "scripts", "qualify-m09.ps1"), "utf8");
    for (const marker of [
      "POWERSHELL_7_REQUIRED",
      "WORKTREE_NOT_CLEAN",
      "M08_FINAL_CERTIFICATION_BOUND",
      "M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY",
      "M09_PREEXISTING_RUNTIME_RESIDUE",
      "Get-M09RuntimeResidue",
      "long_lived_container_integrity",
      "full_regression_started",
      "Sort-Object Destination,Type",
      "live_helper_started",
      "READ_ONLY_EMERGENCY",
      "scripts\\live-m09-host-parity.mjs",
      "HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_READY_FOR_INDEPENDENT_VERIFICATION",
    ]) expect(qualifier).toContain(marker);

    const precondition = qualifier.indexOf("M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY");
    const live = qualifier.indexOf("scripts\\live-m09-host-parity.mjs");
    expect(precondition).toBeGreaterThanOrEqual(0);
    expect(live).toBeGreaterThan(precondition);
  });

  it("keeps production/tunnel authority out of the live helper", async () => {
    const helper = await readText(join(process.cwd(), "scripts", "live-m09-host-parity.mjs"), "utf8");
    expect(helper).not.toContain("docker.sock");
    expect(helper).not.toContain("OPENAI_API_KEY");
    expect(helper).not.toContain("GITHUB_TOKEN");
    expect(helper).not.toContain("git push");
    expect(helper.match(/tunnel_[0-9a-f]{32}/g)?.filter((id) => id !== "tunnel_22222222222222222222222222222222") ?? [])
      .toEqual([]);
  });
});