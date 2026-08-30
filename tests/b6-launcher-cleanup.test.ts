import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("B6 launcher failure cleanup", () => {
  it("removes its prepared build when startup fails after prepare", async () => {
    const root = process.cwd();
    const configDir = await mkdtemp(join(tmpdir(), "b6-bad-config-"));
    const configPath = join(configDir, "host-config.json");
    await writeFile(configPath, "{not-json\n", "utf8");
    const before = new Set((await readdir(join(root, "runtime"))).filter((name) => name.startsWith("b6-live-build-")));
    try {
      const result = spawnSync(process.execPath, [join(root, "scripts", "run-b6-project-expansion-runtime.mjs"), configPath],
        { cwd: root, encoding: "utf8", timeout: 20_000 });
      expect(result.status).not.toBe(0);
      const after = (await readdir(join(root, "runtime"))).filter((name) => name.startsWith("b6-live-build-"));
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  }, 30_000);
});