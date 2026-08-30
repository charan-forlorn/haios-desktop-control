import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("B6 launcher failure cleanup", () => {
  it("removes its prepared build when startup fails after prepare", async () => {
    const root = process.cwd();
    const configDir = await mkdtemp(join(tmpdir(), "b6-bad-config-"));
    const configPath = join(configDir, "host-config.json");
    const runtimeDir = join(root, "runtime");
    await writeFile(configPath, "{not-json\n", "utf8");
    await mkdir(runtimeDir, { recursive: true });
    const before = new Set((await readdir(runtimeDir)).filter((name) => name.startsWith("b6-live-build-")));
    try {
      const result = spawnSync(process.execPath, [join(root, "scripts", "run-b6-project-expansion-runtime.mjs"), configPath],
        { cwd: root, encoding: "utf8", timeout: 20_000 });
      expect(result.status).not.toBe(0);
      const after = (await readdir(runtimeDir)).filter((name) => name.startsWith("b6-live-build-"));
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally { await rm(configDir, { recursive: true, force: true }); }
  }, 30_000);

  it("removes its ACL-locked private execution root when startup fails at listen", async () => {
    const root = process.cwd();
    const localAppData = await mkdtemp(join(tmpdir(), "b6-localappdata-"));
    const keyDir = join(localAppData, "HAIOS", "M10");
    const stateRoot = join(localAppData, "HAIOS", "B6");
    const executionParent = join(stateRoot, "runtime-exec");
    const configPath = join(localAppData, "host-config.json");
    const runtimeDir = join(root, "runtime");
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, "operator-api-key"), "0123456789abcdef0123456789abcdef\n", "utf8");
    await writeFile(configPath, `${JSON.stringify({ apiKeyFile: join(keyDir, "operator-api-key"), stateRoot, worktreeRoot: join(stateRoot, "worktrees"),
      port: 8769, mode: "ACTIVE", activationScope: "B6_SKILL_FABRIC_ADMISSION", stage: "SKILL_FABRIC",
      allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary", "skill-fabric": "C:\\Workspace\\haios-skill-fabric" } })}\n`, "utf8");
    await mkdir(runtimeDir, { recursive: true });
    const before = new Set((await readdir(runtimeDir)).filter((name) => name.startsWith("b6-live-build-")));
    let blocker: Server | undefined;
    try {
      blocker = await new Promise<Server | undefined>((resolve, reject) => {
        const server = createServer();
        server.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve(undefined) : reject(error));
        server.listen(8769, "127.0.0.1", () => resolve(server));
      });
      const result = spawnSync(process.execPath, [join(root, "scripts", "run-b6-project-expansion-runtime.mjs"), configPath],
        { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, LOCALAPPDATA: localAppData } });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("EADDRINUSE");
      const after = (await readdir(runtimeDir)).filter((name) => name.startsWith("b6-live-build-"));
      expect(after.filter((name) => !before.has(name))).toEqual([]);
      const executionChildren = await readdir(executionParent).catch(() => []);
      expect(executionChildren.filter((name) => name.startsWith("b6-exec-"))).toEqual([]);
    } finally {
      if (blocker) await new Promise<void>((resolve) => blocker!.close(() => resolve()));
      await rm(localAppData, { recursive: true, force: true });
    }
  }, 45_000);
});
