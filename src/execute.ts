import { createHash } from "node:crypto";

import { authorizeTool } from "./policy.js";
import { resolveExecutionProfile } from "./execute-profiles.js";
import type {
  DesktopCommanderExecuteClient,
  DesktopCommanderStartProcessArgs,
} from "./upstream.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROJECT_ROOT = "C:\\Workspace\\haios-desktop-control";
const STATE_COMMAND = [
  `Set-Location -LiteralPath '${PROJECT_ROOT}'`,
  "Write-Output 'HAIOS_STATE_BEGIN'",
  "Write-Output ('HEAD=' + (git rev-parse HEAD))",
  "Write-Output ('REF=' + (git symbolic-ref -q HEAD))",
  "git ls-files -s",
  "git ls-files | ForEach-Object { $h = git hash-object -- $_; Write-Output ($h + \"  \" + $_) }",
  "Write-Output 'HAIOS_STATE_END'",
].join("; ");

export interface ExecuteDispatchContext {
  readonly upstream: DesktopCommanderExecuteClient;
}

export type ExecuteDispatchResult =
  | {
      readonly decision: "ALLOW";
      readonly exitCode: 0;
      readonly output: string;
      readonly truncated: boolean;
      readonly preStateDigest: string;
      readonly postStateDigest: string;
    }
  | {
      readonly decision: "DENY";
      readonly reason: string;
      readonly exitCode?: number;
    };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function extractPid(result: unknown): number | null {
  const text = extractText(result);
  const match = /Process started with PID\s+(\d+)/i.exec(text);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function extractExitCode(text: string): number | null {
  const match = /Process completed with exit code\s+(-?\d+)/i.exec(text);
  if (!match) return null;
  const exitCode = Number(match[1]);
  return Number.isSafeInteger(exitCode) ? exitCode : null;
}

function extractTrackedState(text: string): string | null {
  const match = /HAIOS_STATE_BEGIN\s*([\s\S]*?)\s*HAIOS_STATE_END/i.exec(text);
  const state = match?.[1];
  return state === undefined ? null : state.trim().replace(/\r\n/g, "\n");
}
interface CompletedProcess {
  readonly status: "COMPLETE";
  readonly pid: number;
  readonly exitCode: number;
  readonly output: string;
}

interface TimedOutProcess {
  readonly status: "TIMEOUT";
  readonly pid: number;
}

type OwnedProcessResult = CompletedProcess | TimedOutProcess;

async function runOwnedProcess(
  upstream: DesktopCommanderExecuteClient,
  args: DesktopCommanderStartProcessArgs,
): Promise<OwnedProcessResult> {
  const started = await upstream.startProcess(args);
  const pid = extractPid(started);
  if (pid === null) throw new Error("M02_START_PID_UNAVAILABLE");

  let observed: unknown;
  try {
    observed = await upstream.readProcessOutput({
      pid,
      timeout_ms: args.timeout_ms,
      offset: 0,
    });
  } catch (error) {
    await upstream.killProcess({ pid }).catch(() => undefined);
    throw error;
  }

  const output = extractText(observed);
  const exitCode = extractExitCode(output);
  if (exitCode === null) {
    await upstream.killProcess({ pid });
    return { status: "TIMEOUT", pid };
  }
  return { status: "COMPLETE", pid, exitCode, output };
}

async function captureTrackedState(
  upstream: DesktopCommanderExecuteClient,
): Promise<string | null> {
  const result = await runOwnedProcess(upstream, {
    command: STATE_COMMAND,
    timeout_ms: 30_000,
    shell: "powershell",
  });
  if (result.status !== "COMPLETE" || result.exitCode !== 0) return null;
  return extractTrackedState(result.output);
}
function digestState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function boundOutput(output: string): { output: string; truncated: boolean } {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) {
    return { output, truncated: false };
  }
  let bounded = bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  while (Buffer.byteLength(bounded, "utf8") > MAX_OUTPUT_BYTES) {
    bounded = bounded.slice(0, -1);
  }
  return { output: bounded, truncated: true };
}

export async function dispatchExecuteTool(
  name: string,
  rawArgs: unknown,
  context: ExecuteDispatchContext,
): Promise<ExecuteDispatchResult> {
  if (authorizeTool(name, "EXECUTE") !== "ALLOW") {
    return { decision: "DENY", reason: "TOOL_DENIED" };
  }

  const resolution = resolveExecutionProfile(name, rawArgs);
  if (resolution.decision !== "ALLOW") {
    return { decision: "DENY", reason: resolution.reason };
  }

  const preState = await captureTrackedState(context.upstream);
  if (preState === null) {
    return { decision: "DENY", reason: "CURRENTNESS_UNAVAILABLE" };
  }
  const executed = await runOwnedProcess(context.upstream, {
    command: resolution.profile.command,
    timeout_ms: Math.min(resolution.profile.timeoutMs, 180_000),
    shell: resolution.profile.shell,
  });

  if (executed.status === "TIMEOUT") {
    return { decision: "DENY", reason: "PROCESS_TIMEOUT" };
  }

  const postState = await captureTrackedState(context.upstream);
  if (postState === null) {
    return { decision: "DENY", reason: "CURRENTNESS_UNAVAILABLE" };
  }

  if (preState !== postState) {
    return { decision: "DENY", reason: "UNAUTHORIZED_MUTATION_DETECTED" };
  }

  if (executed.exitCode !== 0) {
    return {
      decision: "DENY",
      reason: "PROCESS_EXIT_NONZERO",
      exitCode: executed.exitCode,
    };
  }

  const bounded = boundOutput(executed.output);
  return {
    decision: "ALLOW",
    exitCode: 0,
    output: bounded.output,
    truncated: bounded.truncated,
    preStateDigest: digestState(preState),
    postStateDigest: digestState(postState),
  };
}
