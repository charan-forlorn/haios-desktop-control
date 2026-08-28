import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { operatorFoundationStatus } from "../src/operator/protocol.js";
import { SandboxExecutor } from "../src/operator/sandbox-executor.js";
import { OperatorTaskRunner } from "../src/operator/task-runner.js";

const root = process.cwd();
async function source(path: string) {
  return readFile(`${root}\\${path}`, "utf8");
}

describe("M07 internal runner adversarial boundaries", () => {
  it("keeps M07 execution modules disconnected from public routing", async () => {
    const server = await source("src\\server.ts");
    const foundation = await source("src\\operator\\server-foundation.ts");
    for (const text of [server, foundation]) {
      expect(text).not.toContain("task-runner");
      expect(text).not.toContain("sandbox-executor");
      expect(text).not.toContain("task-resolver");
    }
  });

  it("keeps operator13 in READ_ONLY_EMERGENCY", () => {
    expect(operatorFoundationStatus()).toMatchObject({ mode: "READ_ONLY_EMERGENCY", mutationActive: false });
  });
  it("exposes only the bounded runner entrypoint", () => {
    expect(Object.getOwnPropertyNames(OperatorTaskRunner.prototype)).toEqual(["constructor", "run"]);
  });

  it("exposes only the bounded sandbox entrypoint", () => {
    expect(Object.getOwnPropertyNames(SandboxExecutor.prototype)).toEqual(["constructor", "execute"]);
  });

  it("contains no host child-process execution in the task runner", async () => {
    const runner = await source("src\\operator\\task-runner.ts");
    expect(runner).not.toContain("execFile(");
    expect(runner).not.toContain("spawn(");
    expect(runner).not.toContain("powershell");
    expect(runner).not.toContain("cmd.exe");
  });
});
