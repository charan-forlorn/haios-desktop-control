import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ResolvedTaskExecution } from "./task-resolver.js";
import { M07_NODE_TOOLCHAIN } from "./sandbox-toolchains.js";

export interface DockerExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}
export type DockerExecutor = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<DockerExecResult>;
export interface SandboxExecutionRequest {
  readonly transactionId: string;
  readonly execution: ResolvedTaskExecution;
  readonly worktreePath: string;
  readonly safeEnvironment: Readonly<Record<string, string>>;
  readonly fixtureProfileId?: string;
}
export interface SandboxExecutionResult {
  readonly decision: "ALLOW" | "DENY";
  readonly reason?: string;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly cleanupVerified: boolean;
  readonly durationMs: number;
}
const OWNER = "m07";
const FIXTURE_PROFILE = "m07-http-fixture-v1";
const MAX_DOCKER_BUFFER = 2 * 1024 * 1024;
const SECRET_OUTPUT_PATTERNS = Object.freeze([
  /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /\b(?:GITHUB_TOKEN|OPENAI_API_KEY|API_KEY|PASSWORD|SECRET|TOKEN)\s*[:=]\s*\S+/i,
]);
function containsSecretOutput(value: string): boolean {
  return SECRET_OUTPUT_PATTERNS.some((pattern) => pattern.test(value));
}

const defaultDocker: DockerExecutor = (args, timeoutMs) => new Promise((resolve) => {
  execFile("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_DOCKER_BUFFER,
  }, (error, stdout, stderr) => {
    const timedOut = Boolean(error && "killed" in error && error.killed);
    const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
    resolve({ stdout: String(stdout), stderr: String(stderr), exitCode, timedOut });
  });
});

function boundText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

function safeId(value: string): boolean {
  return /^txn_[A-Za-z0-9_-]{1,120}$/.test(value) || /^txn_test$/.test(value);
}

export interface SandboxExecutorConfig {
  readonly docker?: DockerExecutor;
  readonly idFactory?: () => string;
}
export class SandboxExecutor {
  readonly #docker: DockerExecutor;
  readonly #idFactory: () => string;
  constructor(config: SandboxExecutorConfig = {}) {
    this.#docker = config.docker ?? defaultDocker;
    this.#idFactory = config.idFactory ?? (() => randomUUID().replace(/-/g, "").slice(0, 12));
  }

  async #ownedContainer(name: string, transactionId: string): Promise<boolean> {
    const result = await this.#docker([
      "inspect", "--format",
      "{{ index .Config.Labels \"haios.m07.owner\" }}|{{ index .Config.Labels \"haios.m07.tx\" }}",
      name,
    ], 10_000);
    return result.exitCode === 0 && result.stdout.trim() === `${OWNER}|${transactionId}`;
  }

  async #removeOwnedContainer(name: string, transactionId: string): Promise<boolean> {
    if (!(await this.#ownedContainer(name, transactionId))) return false;
    const removed = await this.#docker(["rm", "--force", name], 15_000);
    return removed.exitCode === 0;
  }

  #securityArgs(transactionId: string, runId: string, worktreePath: string): string[] {
    return [
      "--label", `haios.m07.owner=${OWNER}`,
      "--label", `haios.m07.tx=${transactionId}`,
      "--label", `haios.m07.run=${runId}`,
      "--user", M07_NODE_TOOLCHAIN.user,
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", M07_NODE_TOOLCHAIN.memory,
      "--cpus", M07_NODE_TOOLCHAIN.cpus,
      "--pids-limit", String(M07_NODE_TOOLCHAIN.pidsLimit),
      "--mount", `type=bind,source=${worktreePath},target=/workspace`,
      "--mount", `type=bind,source=${join(worktreePath, ".git")},target=/workspace/.git,readonly`,
      "--tmpfs", `/scratch:rw,noexec,nosuid,nodev,size=${M07_NODE_TOOLCHAIN.scratchBytes}`,
      "--workdir", "/workspace",
    ];
  }

  #environmentArgs(request: SandboxExecutionRequest): string[] | null {
    const allowed = new Set(request.execution.envAllowlist);
    const keys = Object.keys(request.safeEnvironment).sort();
    if (keys.some((key) => !allowed.has(key))) return null;
    const result: string[] = [];
    for (const key of keys) {
      const value = request.safeEnvironment[key]!;
      if (value.includes("\0") || value.length > 1024) return null;
      result.push("-e", `${key}=${value}`);
    }
    return result;
  }
  async #startFixture(transactionId: string, runId: string, name: string): Promise<boolean> {
    const fixtureCode = [
      "const http=require('http');",
      "http.createServer((q,r)=>{r.end('M07_FIXTURE_OK')}).listen(8080,'127.0.0.1');",
      "setInterval(()=>{},1<<30);",
    ].join("");
    const args = [
      "run", "-d", "--pull", "never", "--name", name,
      "--label", `haios.m07.owner=${OWNER}`,
      "--label", `haios.m07.tx=${transactionId}`,
      "--label", `haios.m07.run=${runId}`,
      "--user", M07_NODE_TOOLCHAIN.user,
      "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16777216",
      "--network", "none",
      "--entrypoint", "node",
      M07_NODE_TOOLCHAIN.image,
      "-e", fixtureCode,
    ];
    const result = await this.#docker(args, 30_000);
    return result.exitCode === 0 && !result.timedOut;
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const denied = (reason: string, cleanupVerified = false, exitCode?: number): SandboxExecutionResult => ({
      decision: "DENY", reason, ...(exitCode === undefined ? {} : { exitCode }),
      stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      cleanupVerified, durationMs: Date.now() - startedAt,
    });
    if (!safeId(request.transactionId)) return denied("SANDBOX_TRANSACTION_ID_DENIED");
    if (request.execution.worktreePath !== request.worktreePath) return denied("SANDBOX_WORKTREE_MISMATCH");
    if (request.execution.toolchainProfile !== M07_NODE_TOOLCHAIN.profileId) return denied("SANDBOX_TOOLCHAIN_DENIED");
    const envArgs = this.#environmentArgs(request);
    if (envArgs === null) return denied("SANDBOX_ENV_DENIED");
    if (request.execution.sandboxProfile === "S0" && request.execution.networkAuthority !== "NONE") {
      return denied("SANDBOX_NETWORK_POLICY_DENIED");
    }
    if (request.execution.sandboxProfile === "S1" && (
      request.execution.networkAuthority !== "FIXTURE_ONLY" || request.fixtureProfileId !== FIXTURE_PROFILE
    )) return denied("SANDBOX_FIXTURE_PROFILE_DENIED");
    const runId = this.#idFactory();
    if (!/^[a-z0-9]{4,32}$/.test(runId)) return denied("SANDBOX_RUN_ID_DENIED");
    const taskName = `haios-m07-task-${runId}`;
    const fixtureName = `haios-m07-fixture-${runId}`;
    let fixtureCreated = false;

    if (request.execution.sandboxProfile === "S1") {
      fixtureCreated = await this.#startFixture(request.transactionId, runId, fixtureName);
      if (!fixtureCreated) return denied("SANDBOX_FIXTURE_START_FAILED");
    }

    const runArgs = [
      "run", "--pull", "never", "--name", taskName,
      ...this.#securityArgs(request.transactionId, runId, request.worktreePath),
      "--network", request.execution.sandboxProfile === "S0" ? "none" : `container:${fixtureName}`,
      ...envArgs,
      "--entrypoint", request.execution.executable,
      M07_NODE_TOOLCHAIN.image,
      ...request.execution.argv,
    ];
    const task = await this.#docker(runArgs, request.execution.timeoutMs);
    const secretOutput = containsSecretOutput(task.stdout) || containsSecretOutput(task.stderr);
    const stdout = secretOutput ? { text: "", truncated: false } : boundText(task.stdout, request.execution.stdoutMaxBytes);
    const stderr = secretOutput ? { text: "", truncated: false } : boundText(task.stderr, request.execution.stderrMaxBytes);

    const taskClean = await this.#removeOwnedContainer(taskName, request.transactionId);
    let fixtureClean = true;
    if (fixtureCreated) fixtureClean = await this.#removeOwnedContainer(fixtureName, request.transactionId);
    const cleanupVerified = taskClean && fixtureClean;
    const base = {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      cleanupVerified,
      durationMs: Date.now() - startedAt,
    };
    if (!cleanupVerified) return { decision: "DENY", reason: "SANDBOX_CLEANUP_UNVERIFIED", ...base };
    if (secretOutput) return { decision: "DENY", reason: "SANDBOX_SECRET_OUTPUT_DETECTED", ...base };
    if (task.timedOut) return { decision: "DENY", reason: "SANDBOX_TIMEOUT", ...base };
    if (task.exitCode !== 0) {
      return { decision: "DENY", reason: "SANDBOX_EXIT_NONZERO", exitCode: task.exitCode, ...base };
    }
    return { decision: "ALLOW", exitCode: 0, ...base };
  }
}
