import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-ignore -- production supervisor is an intentionally plain ESM module tested directly by Vitest.
import { superviseM10Runtime } from "../scripts/run-m10-readonly-supervisor.mjs";

class FakeChild extends EventEmitter {
  killed = false;
  kill() {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0, "SIGTERM"));
    return true;
  }
}

describe("M10 read-only supervisor", () => {
  it("restarts the exact child after unexpected exit", async () => {
    const controller = new AbortController();
    const children: FakeChild[] = [];
    const spawnRuntime = () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.emit("exit", 7, null));
      else queueMicrotask(() => controller.abort());
      return child as never;
    };
    await expect(superviseM10Runtime({ configPath: "C:/safe/host-config.json", signal: controller.signal, spawnRuntime, sleep: async () => {} })).resolves.toBe(0);
    expect(children).toHaveLength(2);
    expect(children[1]!.killed).toBe(true);
  });

  it("intentional supervisor stop does not restart", async () => {
    const controller = new AbortController();
    let spawned = 0;
    const spawnRuntime = () => {
      spawned += 1;
      const child = new FakeChild();
      queueMicrotask(() => controller.abort());
      return child as never;
    };
    await expect(superviseM10Runtime({ configPath: "C:/safe/host-config.json", signal: controller.signal, spawnRuntime, sleep: async () => {} })).resolves.toBe(0);
    expect(spawned).toBe(1);
  });

  it("bounds retries and never overlaps child ownership", async () => {
    let spawned = 0;
    let active = 0;
    let maxActive = 0;
    const spawnRuntime = () => {
      spawned += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const child = new FakeChild();
      queueMicrotask(() => { active -= 1; child.emit("exit", 9, null); });
      return child as never;
    };
    await expect(superviseM10Runtime({ configPath: "C:/safe/host-config.json", signal: new AbortController().signal, spawnRuntime, sleep: async () => {}, maxRestarts: 2 })).resolves.toBe(9);
    expect(spawned).toBe(3);
    expect(maxActive).toBe(1);
  });

  it("hard-binds child launcher, exact M10 config path and secret-safe CLI", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "run-m10-readonly-supervisor.mjs"), "utf8");
    expect(source).toContain("run-m10-readonly-runtime.mjs");
    expect(source).toContain("process.execPath");
    expect(source).toContain("process.argv.length !== 3");
    expect(source).toContain('resolve(localAppData, "HAIOS", "M10", "host-config.json")');
    expect(source).toContain("M10_SUPERVISOR_CONFIG_REJECTED");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("apiKey");
    expect(source).not.toContain("shell: true");
  });
});
