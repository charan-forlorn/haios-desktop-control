import { describe, expect, it } from "vitest";

import { dispatchExecuteTool } from "../src/execute.js";
import type {
  DesktopCommanderExecuteClient,
  DesktopCommanderStartProcessArgs,
} from "../src/upstream.js";

function denyProbeClient(): DesktopCommanderExecuteClient & {
  starts: DesktopCommanderStartProcessArgs[];
  kills: number[];
} {
  const starts: DesktopCommanderStartProcessArgs[] = [];
  const kills: number[] = [];
  const noop = async () => ({ ok: true });
  return {
    starts,
    kills,
    startProcess: async (args) => {
      starts.push(args);
      return { content: [{ type: "text", text: "unexpected" }] };
    },
    readProcessOutput: noop,
    killProcess: async ({ pid }) => { kills.push(pid); return { ok: true }; },
    listDirectory: noop,
    readFile: noop,
    readMultipleFiles: noop,
    getFileInfo: noop,
    startSearch: noop,
    getMoreSearchResults: noop,
    stopSearch: noop,
    listSearches: noop,
    listProcesses: noop,
    listSessions: noop,
    getConfig: noop,
    close: async () => undefined,
  };
}

async function expectDeniedBeforeStart(name: string, args: unknown) {
  const upstream = denyProbeClient();
  const result = await dispatchExecuteTool(name, args, { upstream });
  expect(result.decision).toBe("DENY");
  expect(upstream.starts).toEqual([]);
  expect(upstream.kills).toEqual([]);
}

describe("M02 execute adversarial boundary", () => {
  it("blocks command injection property", async () => {
    await expectDeniedBeforeStart("project_test", { command: "whoami; Remove-Item C:\\" });
  });

  it("blocks arbitrary project path", async () => {
    await expectDeniedBeforeStart("project_build", { path: "C:\\Windows" });
  });
  it("blocks git diff enum injection", async () => {
    await expectDeniedBeforeStart("git_diff", { mode: "working; whoami" });
  });

  it("blocks git log non-integer injection", async () => {
    await expectDeniedBeforeStart("git_log", { maxCount: "1; whoami" });
  });

  it.each([
    "start_process",
    "interact_with_process",
    "kill_process",
    "force_terminate",
    "write_file",
    "set_config_value",
  ])("blocks raw capability %s", async (name) => {
    await expectDeniedBeforeStart(name, {});
  });
});
