import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "scripts", "run-m09-host-runtime.mjs");
const roots: string[] = [];
const apiKey = "M09-LAUNCHER-LOCAL-KEY-123456";

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "m09-launcher-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("M09 durable host launcher", () => {
  it("has a one-config-path, no-inline-secret, loopback-only static contract", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain('../dist/src/operator/host-runtime.js');
    expect(source).toContain("process.argv.slice(2)");
    expect(source).toContain("args.length !== 1");
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain("close()");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("--api-key");
    expect(source).not.toContain("--host");
    expect(source).not.toContain("0.0.0.0");
  });

  it("fails closed when argv does not contain exactly one config path", () => {
    for (const args of [[], ["a.json", "b.json"]]) {
      const run = spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("M09_HOST_CONFIG_PATH_REQUIRED");
    }
  });

  it("sanitizes JSON/config read failures without echoing bytes or paths", async () => {
    const root = await tempRoot();
    const configPath = join(root, "SENSITIVE-CONFIG-PATH.json");
    const marker = "SENSITIVE-CONFIG-CONTENT";
    await writeFile(configPath, `{not-json:${marker}}`, "utf8");
    const run = spawnSync(process.execPath, [scriptPath, configPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr.trim()).toBe("M09_HOST_CONFIG_INVALID");
    expect(run.stderr).not.toContain(marker);
    expect(run.stderr).not.toContain(configPath);
  });

  it("starts built host runtime, emits only readiness metadata, and closes cleanly", async () => {
    const root = await tempRoot();
    const keyPath = join(root, "api-key.txt");
    const configPath = join(root, "launcher.json");
    await writeFile(keyPath, apiKey, "utf8");
    await writeFile(configPath, JSON.stringify({
      apiKeyFile: keyPath,
      worktreeRoot: join(root, "worktrees"),
      allowedProjects: {},
      port: 18774,
      mode: "READ_ONLY_EMERGENCY",
    }), "utf8");

    const probe = [
      'import { startM09HostRuntime } from "./scripts/run-m09-host-runtime.mjs";',
      'const started = await startM09HostRuntime(process.argv[1]);',
      'console.log(JSON.stringify(started.metadata));',
      'await started.close();',
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe, configPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const metadata = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      host: "127.0.0.1",
      port: 18774,
      mode: "READ_ONLY_EMERGENCY",
      protocolMode: "operator13",
      s2Enabled: false,
      destructive: "LOCKED",
    });
    expect(run.stdout).not.toContain(apiKey);
    expect(run.stdout).not.toContain(keyPath);
    expect(run.stdout).not.toContain(root);
  });
});
