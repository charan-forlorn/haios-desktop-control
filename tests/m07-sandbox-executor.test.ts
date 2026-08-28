import { describe, expect, it } from "vitest";

import type { ResolvedTaskExecution } from "../src/operator/task-resolver.js";
import {
  M07_NODE_TOOLCHAIN,
} from "../src/operator/sandbox-toolchains.js";
import {
  SandboxExecutor,
  type DockerExecResult,
  type DockerExecutor,
} from "../src/operator/sandbox-executor.js";

function execution(profile: "S0" | "S1" = "S0"): ResolvedTaskExecution {
  return Object.freeze({
    taskId: "node.test.run",
    executable: "node",
    argv: Object.freeze(["--test", "tests/sample.test.mjs"]),
    toolchainProfile: "node22-sandbox-v1",
    sandboxProfile: profile,
    networkAuthority: profile === "S0" ? "NONE" : "FIXTURE_ONLY",
    envAllowlist: Object.freeze(["CI"]),
    effectPolicyRef: "default-artifacts-v1",
    timeoutMs: 300000,
    stdoutMaxBytes: 16,
    stderrMaxBytes: 16,
    registrySha256: "a".repeat(64),
    worktreePath: "C:\\Workspace\\tx-worktree",
  });
}
function fakeDocker(runResult: Partial<DockerExecResult> = {}) {
  const calls: string[][] = [];
  const executor: DockerExecutor = async (args) => {
    calls.push([...args]);
    if (args[0] === "inspect" || (args[0] === "network" && args[1] === "inspect")) {
      return { stdout: "m07|txn_test", stderr: "", exitCode: 0, timedOut: false };
    }
    return {
      stdout: "ok-output-abcdefghijklmnopqrstuvwxyz",
      stderr: "err-output-abcdefghijklmnopqrstuvwxyz",
      exitCode: 0,
      timedOut: false,
      ...runResult,
    };
  };
  return { executor, calls };
}

describe("M07 pinned Docker sandbox executor", () => {
  it("pins the exact qualified image identity", () => {
    expect(M07_NODE_TOOLCHAIN.image).toBe(
      "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe",
    );
    expect(M07_NODE_TOOLCHAIN.nodeVersion).toBe("22.23.2");
  });

  it("constructs S0 with no network and hard security/resource bounds", async () => {
    const fx = fakeDocker();
    const sandbox = new SandboxExecutor({ docker: fx.executor, idFactory: () => "abc123" });
    const result = await sandbox.execute({
      transactionId: "txn_test",
      execution: execution("S0"),
      worktreePath: "C:\\Workspace\\tx-worktree",
      safeEnvironment: { CI: "1" },
    });    expect(result.decision).toBe("ALLOW");
    expect(result.stdout).toBe("ok-output-abcdef");
    expect(result.stderr).toBe("err-output-abcde");
    expect(result.stdoutBytes).toBe(Buffer.byteLength("ok-output-abcdefghijklmnopqrstuvwxyz"));
    expect(result.stderrBytes).toBe(Buffer.byteLength("err-output-abcdefghijklmnopqrstuvwxyz"));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    const run = fx.calls.find((args) => args[0] === "run")!;
    expect(run).toEqual(expect.arrayContaining([
      "--network", "none", "--user", "node", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "1536m", "--cpus", "2", "--pids-limit", "256",
      "--workdir", "/workspace", "--entrypoint", "node",
      M07_NODE_TOOLCHAIN.image,
    ]));
    expect(run.join(" ")).not.toContain("docker.sock");
    expect(run.join(" ")).not.toContain("--privileged");
    expect(run.join(" ")).not.toContain("--network host");
    expect(run).toContain("CI=1");
  });

  it("uses owned labels and verifies ownership before cleanup", async () => {
    const fx = fakeDocker();
    const sandbox = new SandboxExecutor({ docker: fx.executor, idFactory: () => "abc123" });
    const result = await sandbox.execute({
      transactionId: "txn_test",
      execution: execution("S0"),
      worktreePath: "C:\\Workspace\\tx-worktree",
      safeEnvironment: { CI: "1" },
    });
    expect(result.cleanupVerified).toBe(true);
    expect(fx.calls.some((args) => args[0] === "inspect")).toBe(true);
    expect(fx.calls.some((args) => args[0] === "rm" && args.includes("--force"))).toBe(true);
  });
  it("fails closed when cleanup ownership cannot be proven", async () => {
    const calls: string[][] = [];
    const docker: DockerExecutor = async (args) => {
      calls.push([...args]);
      if (args[0] === "inspect") return { stdout: "foreign|txn_other", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const sandbox = new SandboxExecutor({ docker, idFactory: () => "abc123" });
    const result = await sandbox.execute({
      transactionId: "txn_test",
      execution: execution("S0"),
      worktreePath: "C:\\Workspace\\tx-worktree",
      safeEnvironment: { CI: "1" },
    });
    expect(result).toMatchObject({ decision: "DENY", reason: "SANDBOX_CLEANUP_UNVERIFIED", cleanupVerified: false });
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("denies unsafe environment keys before Docker invocation", async () => {
    const fx = fakeDocker();
    const sandbox = new SandboxExecutor({ docker: fx.executor, idFactory: () => "abc123" });
    const result = await sandbox.execute({
      transactionId: "txn_test",
      execution: execution("S0"),
      worktreePath: "C:\\Workspace\\tx-worktree",
      safeEnvironment: { CI: "1", TOKEN: "secret" },
    });
    expect(result).toMatchObject({ decision: "DENY", reason: "SANDBOX_ENV_DENIED" });
    expect(fx.calls).toHaveLength(0);
  });
  it("isolates S1 in the fixed fixture container network namespace with no bridge or gateway", async () => {
    const fx = fakeDocker();
    const sandbox = new SandboxExecutor({ docker: fx.executor, idFactory: () => "abc123" });
    const result = await sandbox.execute({ transactionId: "txn_test", execution: execution("S1"),
      worktreePath: "C:\\Workspace\\tx-worktree", safeEnvironment: { CI: "1" }, fixtureProfileId: "m07-http-fixture-v1" });
    expect(result.decision).toBe("ALLOW");
    expect(fx.calls.some((args) => args[0] === "network" && args[1] === "create")).toBe(false);
    const fixture = fx.calls.find((args) => args[0] === "run" && args.includes("-d"))!;
    expect(fixture).toEqual(expect.arrayContaining(["--network", "none"]));
    const task = fx.calls.find((args) => args[0] === "run" && !args.includes("-d"))!;
    expect(task).toEqual(expect.arrayContaining(["--network", "container:haios-m07-fixture-abc123"]));
  });

  it("cleans an owned S1 fixture after failed or timed-out detached startup", async () => {
    const calls: string[][] = [];
    const docker: DockerExecutor = async (args) => { calls.push([...args]); if (args[0] === "run" && args.includes("-d")) return { stdout: "fixture-id", stderr: "timeout", exitCode: 1, timedOut: true }; if (args[0] === "inspect") return { stdout: "m07|txn_test", stderr: "", exitCode: 0, timedOut: false }; if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; };
    const sandbox = new SandboxExecutor({ docker, idFactory: () => "abc123" });
    const result = await sandbox.execute({ transactionId: "txn_test", execution: execution("S1"), worktreePath: "C:\\Workspace\\tx-worktree", safeEnvironment: { CI: "1" }, fixtureProfileId: "m07-http-fixture-v1" });
    expect(result).toMatchObject({ decision: "DENY", reason: "SANDBOX_FIXTURE_START_FAILED", cleanupVerified: true });
    expect(calls.some((args) => args[0] === "inspect" && args.includes("haios-m07-fixture-abc123"))).toBe(true);
    expect(calls.some((args) => args[0] === "rm" && args.includes("haios-m07-fixture-abc123"))).toBe(true);
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
  });

  it("never removes a foreign fixture after failed detached startup", async () => {
    const calls: string[][] = [];
    const docker: DockerExecutor = async (args) => {
      calls.push([...args]);
      if (args[0] === "inspect") return { stdout: "foreign|txn_other", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 1, timedOut: args[0] === "run" };
    };
    const sandbox = new SandboxExecutor({ docker, idFactory: () => "abc123" });
    const result = await sandbox.execute({ transactionId: "txn_test", execution: execution("S1"),
      worktreePath: "C:\\Workspace\\tx-worktree", safeEnvironment: { CI: "1" }, fixtureProfileId: "m07-http-fixture-v1" });
    expect(result).toMatchObject({ decision: "DENY", reason: "SANDBOX_CLEANUP_UNVERIFIED", cleanupVerified: false });
    expect(calls.some((args) => args[0] === "inspect")).toBe(true);
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("forces --pull never on task and fixture Docker runs", async () => {
    const fx = fakeDocker();
    const sandbox = new SandboxExecutor({ docker: fx.executor, idFactory: () => "abc123" });
    await sandbox.execute({ transactionId: "txn_test", execution: execution("S1"), worktreePath: "C:\\Workspace\\tx-worktree",
      safeEnvironment: { CI: "1" }, fixtureProfileId: "m07-http-fixture-v1" });
    for (const call of fx.calls.filter((args) => args[0] === "run")) {
      expect(call).toEqual(expect.arrayContaining(["--pull", "never"]));
    }
  });

  it("denies secret-like stdout before returning task output", async () => {
    const secretLike = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const fx = fakeDocker({ stdout: `OPENAI_API_KEY=${secretLike}` });
    const sandbox = new SandboxExecutor({ docker: fx.executor, idFactory: () => "abc123" });
    const result = await sandbox.execute({ transactionId: "txn_test", execution: execution("S0"),
      worktreePath: "C:\\Workspace\\tx-worktree", safeEnvironment: { CI: "1" } });
    expect(result).toMatchObject({ decision: "DENY", reason: "SANDBOX_SECRET_OUTPUT_DETECTED", stdout: "", stderr: "" });
  });

  it("exposes no generic Docker run/exec primitive on the class", () => {
    const methods = Object.getOwnPropertyNames(SandboxExecutor.prototype);
    expect(methods).toEqual(["constructor", "execute"]);
  });
});
