import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadTaskRegistryV2 } from "../src/operator/task-contract-v2.js";
import { loadTaskEffectPolicy } from "../src/operator/task-effects.js";
import { OperatorTaskRunner } from "../src/operator/task-runner.js";
import type { SandboxExecutionResult } from "../src/operator/sandbox-executor.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const canonical = await mkdtemp("C:\\Workspace\\m07-runner-canonical-");
  const worktree = await mkdtemp("C:\\Workspace\\m07-runner-worktree-");
  roots.push(canonical, worktree);
  await mkdir(join(worktree, "tests"), { recursive: true });
  await writeFile(join(worktree, "tests", "sample.test.mjs"), "export {};", "utf8");
  const registry = await loadTaskRegistryV2(join(process.cwd(), "task-registry.m07.json"));
  const effects = await loadTaskEffectPolicy(join(process.cwd(), "task-effects.m07.json"));
  return { canonical, worktree, registry, effects };
}

const SHA = "a".repeat(40);
function allowSandbox(): SandboxExecutionResult {
  return { decision: "ALLOW", exitCode: 0, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupVerified: true, durationMs: 3 };
}
async function setup(state = "APPLIED") {
  const fx = await fixture();
  let sandboxCalls = 0;
  const transaction = Object.freeze({
    txId: "txn_test", projectId: "demo", canonicalRoot: fx.canonical,
    worktreePath: fx.worktree, branchName: "haios-tx-test", baseHeadSha: SHA,
    createdAt: new Date(0).toISOString(), state, intents: Object.freeze([]),
  });
  const transactions = {
    status: async () => ({ decision: "ALLOW" as const, transaction, state, intentCount: 1 }),
  };
  const git = {
    canonicalHead: SHA,
    worktreeHead: SHA,
    canonicalStatus: "",
    identity: "C:\\shared\\.git",
    async head(cwd: string) { return cwd === fx.canonical ? this.canonicalHead : this.worktreeHead; },
    async status(cwd: string) { return cwd === fx.canonical ? this.canonicalStatus : " M src/main.ts"; },
    async commonDir() { return this.identity; },
  };
  const sandbox = {
    execute: async () => { sandboxCalls += 1; return allowSandbox(); },
  };
  const runner = new OperatorTaskRunner({
    transactions, git, registry: fx.registry, effects: fx.effects,
    qualifiedEffectPolicySha256: fx.effects.sha256, sandbox, safeEnvironment: { CI: "1" },
  });
  return { ...fx, runner, git, sandbox, getSandboxCalls: () => sandboxCalls };
}

describe("M07 internal bounded task runner", () => {
  it("runs an APPLIED transaction with fixed server-side worktree binding", async () => {
    const fx = await setup();
    const result = await fx.runner.run({
      txId: "txn_test", taskId: "node.test.run",
      params: { testPath: "tests/sample.test.mjs" },
      expectedRegistrySha256: fx.registry.sha256,
    });    expect(result).toMatchObject({ decision: "ALLOW", taskId: "node.test.run", exitCode: 0 });
    expect(fx.getSandboxCalls()).toBe(1);
  });

  it.each(["OPEN", "STAGED", "VALIDATED", "CHECKPOINTED", "PROMOTED", "ROLLED_BACK"])(
    "denies transaction state %s before sandbox execution",
    async (state) => {
      const fx = await setup(state);
      const result = await fx.runner.run({
        txId: "txn_test", taskId: "node.test.run",
        params: { testPath: "tests/sample.test.mjs" }, expectedRegistrySha256: fx.registry.sha256,
      });
      expect(result).toMatchObject({ decision: "DENY", reason: "TASK_TRANSACTION_STATE_DENIED" });
      expect(fx.getSandboxCalls()).toBe(0);
    },
  );

  it("denies registry currentness drift before sandbox execution", async () => {
    const fx = await setup();
    const result = await fx.runner.run({
      txId: "txn_test", taskId: "node.test.run", params: { testPath: "tests/sample.test.mjs" },
      expectedRegistrySha256: "f".repeat(64),
    });
    expect(result).toMatchObject({ decision: "DENY", reason: "TASK_REGISTRY_CURRENTNESS_MISMATCH" });
    expect(fx.getSandboxCalls()).toBe(0);
  });

  it("denies canonical currentness drift before sandbox execution", async () => {
    const fx = await setup();
    fx.git.canonicalHead = "b".repeat(40);
    const result = await fx.runner.run({
      txId: "txn_test", taskId: "node.test.run", params: { testPath: "tests/sample.test.mjs" },
      expectedRegistrySha256: fx.registry.sha256,
    });
    expect(result).toMatchObject({ decision: "DENY", reason: "TASK_CANONICAL_CURRENTNESS_DENIED" });
    expect(fx.getSandboxCalls()).toBe(0);
  });
  it("tolerates a declared dist artifact created by the sandbox", async () => {
    const fx = await setup();
    fx.sandbox.execute = async () => {
      await mkdir(join(fx.worktree, "dist"), { recursive: true });
      await writeFile(join(fx.worktree, "dist", "out.js"), "artifact", "utf8");
      return allowSandbox();
    };
    const result = await fx.runner.run({
      txId: "txn_test", taskId: "node.test.run", params: { testPath: "tests/sample.test.mjs" },
      expectedRegistrySha256: fx.registry.sha256,
    });
    expect(result).toMatchObject({ decision: "ALLOW" });
    expect(result.effects).toContainEqual(expect.objectContaining({ path: "dist/out.js", classification: "ALLOWED_ARTIFACT" }));
  });

  it("denies protected source effects even when sandbox exits zero", async () => {
    const fx = await setup();
    fx.sandbox.execute = async () => {
      await mkdir(join(fx.worktree, "src"), { recursive: true });
      await writeFile(join(fx.worktree, "src", "evil.ts"), "mutated", "utf8");
      return allowSandbox();
    };
    const result = await fx.runner.run({
      txId: "txn_test", taskId: "node.test.run", params: { testPath: "tests/sample.test.mjs" },
      expectedRegistrySha256: fx.registry.sha256,
    });
    expect(result).toMatchObject({ decision: "DENY", reason: "TASK_PROTECTED_EFFECT" });
  });

  it("denies non-zero sandbox execution after post-state verification", async () => {
    const fx = await setup();
    fx.sandbox.execute = async () => ({ ...allowSandbox(), decision: "DENY", reason: "SANDBOX_EXIT_NONZERO", exitCode: 2 });
    const result = await fx.runner.run({
      txId: "txn_test", taskId: "node.test.run", params: { testPath: "tests/sample.test.mjs" },
      expectedRegistrySha256: fx.registry.sha256,
    });
    expect(result).toMatchObject({ decision: "DENY", reason: "TASK_SANDBOX_FAILED", exitCode: 2 });
  });
});