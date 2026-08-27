import { describe, expect, it } from "vitest";

import { dispatchExecuteTool } from "../src/execute.js";
import type {
  DesktopCommanderExecuteClient,
  DesktopCommanderStartProcessArgs,
} from "../src/upstream.js";

function resultText(text: string) {
  return { content: [{ type: "text", text }] };
}

function completed(text: string, exitCode = 0) {
  return resultText(`${text}\n✅ Process completed with exit code ${exitCode}`);
}

const STABLE_STATE = "HAIOS_STATE_BEGIN\nHEAD=abc123\nHAIOS_STATE_END";

function fakeClient(outputs: unknown[]): DesktopCommanderExecuteClient & {
  starts: DesktopCommanderStartProcessArgs[];
  kills: number[];
} {
  const starts: DesktopCommanderStartProcessArgs[] = [];
  const kills: number[] = [];
  let pid = 100;
  let outputIndex = 0;
  const noop = async () => ({ ok: true });
  return {
    starts,
    kills,
    startProcess: async (args) => {
      starts.push(args);
      pid += 1;
      return resultText(`Process started with PID ${pid} (shell: powershell)\nInitial output:`);
    },    readProcessOutput: async () => outputs[outputIndex++],
    killProcess: async ({ pid }) => {
      kills.push(pid);
      return resultText(`Successfully terminated process ${pid}`);
    },
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

describe("M02 execute guard", () => {
  it("executes an approved profile only when tracked state is stable", async () => {
    const upstream = fakeClient([
      completed(STABLE_STATE),
      completed("TEST_OK"),
      completed(STABLE_STATE),
    ]);
    const result = await dispatchExecuteTool("project_test", {}, { upstream });
    expect(result).toMatchObject({ decision: "ALLOW", exitCode: 0, truncated: false });
    expect(JSON.stringify(result)).toContain("TEST_OK");
    expect(upstream.starts).toHaveLength(3);
    expect(upstream.kills).toEqual([]);
  });
  it("denies extra command input before any upstream process starts", async () => {
    const upstream = fakeClient([]);
    const result = await dispatchExecuteTool(
      "project_test",
      { command: "whoami; Remove-Item C:\\" },
      { upstream },
    );
    expect(result).toEqual({ decision: "DENY", reason: "INVALID_ARGUMENTS" });
    expect(upstream.starts).toEqual([]);
  });

  it("denies raw process tools before upstream", async () => {
    const upstream = fakeClient([]);
    const result = await dispatchExecuteTool("start_process", {}, { upstream });
    expect(result).toEqual({ decision: "DENY", reason: "TOOL_DENIED" });
    expect(upstream.starts).toEqual([]);
  });

  it("fails closed when tracked state changes during execution", async () => {
    const upstream = fakeClient([
      completed(STABLE_STATE),
      completed("TEST_OK"),
      completed("HAIOS_STATE_BEGIN\nHEAD=changed\nHAIOS_STATE_END"),
    ]);
    const result = await dispatchExecuteTool("project_test", {}, { upstream });
    expect(result).toEqual({ decision: "DENY", reason: "UNAUTHORIZED_MUTATION_DETECTED" });
  });
  it("reports a nonzero process exit without promoting success", async () => {
    const upstream = fakeClient([
      completed(STABLE_STATE),
      completed("TEST_FAILED", 1),
      completed(STABLE_STATE),
    ]);
    const result = await dispatchExecuteTool("project_test", {}, { upstream });
    expect(result).toEqual({ decision: "DENY", reason: "PROCESS_EXIT_NONZERO", exitCode: 1 });
  });

  it("kills only the exact gateway-owned PID when completion times out", async () => {
    const upstream = fakeClient([
      completed(STABLE_STATE),
      resultText("still running"),
    ]);
    const result = await dispatchExecuteTool("project_test", {}, { upstream });
    expect(result).toEqual({ decision: "DENY", reason: "PROCESS_TIMEOUT" });
    expect(upstream.kills).toEqual([102]);
  });

  it("bounds large execution output explicitly", async () => {
    const upstream = fakeClient([
      completed(STABLE_STATE),
      completed("x".repeat(70_000)),
      completed(STABLE_STATE),
    ]);
    const result = await dispatchExecuteTool("project_test", {}, { upstream });
    expect(result).toMatchObject({ decision: "ALLOW", truncated: true, exitCode: 0 });
    if (result.decision !== "ALLOW") throw new Error("expected allow");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
});
