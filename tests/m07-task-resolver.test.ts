import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateTaskRegistryV2 } from "../src/operator/task-contract-v2.js";
import { resolveTaskExecution } from "../src/operator/task-resolver.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

function registry() {
  return validateTaskRegistryV2({
    registryId: "m07-test-registry",
    version: "1.0.0",
    tasks: {
      "node.test.run": {
        argvTemplate: ["node", "--test", "{{testPath}}", "{{reporter}}"],
        paramSchemas: {
          testPath: { kind: "relpath", mustExist: true, fileType: "file" },
          reporter: { kind: "enum", values: ["spec", "tap"] },
        },
        requiredParams: ["testPath", "reporter"],
        toolchainProfile: "node22-sandbox-v1",
        sandboxProfile: "S0",
        networkAuthority: "NONE",        childProcessPolicy: "SANDBOX_OWNED_TREE",
        envAllowlist: ["CI"],
        effectPolicyRef: "default-artifacts-v1",
        timeoutMs: 300000,
        stdoutMaxBytes: 65536,
        stderrMaxBytes: 65536,
      },
    },
  });
}

async function fixture() {
  const root = await mkdtemp("C:\\Workspace\\m07-resolver-");
  roots.push(root);
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests", "sample.test.mjs"), "export {};", "utf8");
  return root;
}

function bound(root: string) {
  return Object.freeze({
    registry: registry(),
    sha256: "a".repeat(64),
    sourcePath: join(root, "registry.json"),
  });
}

describe("M07 typed task resolver", () => {
  it("resolves fixed executable and POSIX argv from typed parameters", async () => {    const root = await fixture();
    const result = await resolveTaskExecution(
      bound(root),
      "node.test.run",
      { testPath: "tests\\sample.test.mjs", reporter: "spec" },
      "a".repeat(64),
      root,
    );
    expect(result.executable).toBe("node");
    expect(result.argv).toEqual(["--test", "tests/sample.test.mjs", "spec"]);
    expect(result.worktreePath).toBe(root);
    expect(result.registrySha256).toBe("a".repeat(64));
    expect(result.sandboxProfile).toBe("S0");
    expect(Object.isFrozen(result.argv)).toBe(true);
  });

  it.each([
    ["registry drift", "b".repeat(64), { testPath: "tests/sample.test.mjs", reporter: "spec" }],
    ["unknown param", "a".repeat(64), { testPath: "tests/sample.test.mjs", reporter: "spec", cwd: "C:/" }],
    ["missing param", "a".repeat(64), { testPath: "tests/sample.test.mjs" }],
    ["enum mismatch", "a".repeat(64), { testPath: "tests/sample.test.mjs", reporter: "shell" }],
  ])("fails closed for %s", async (_name, digest, params) => {
    const root = await fixture();
    await expect(resolveTaskExecution(bound(root), "node.test.run", params, digest, root))
      .rejects.toThrow(/TASK_RESOLUTION_DENIED/);
  });
  it.each(["../escape.mjs", "C:/Windows/system.ini", ".git/config", ".env", "secrets/token.txt"])(
    "rejects unsafe relpath %s",
    async (value) => {
      const root = await fixture();
      await expect(resolveTaskExecution(
        bound(root),
        "node.test.run",
        { testPath: value, reporter: "spec" },
        "a".repeat(64),
        root,
      )).rejects.toThrow(/TASK_RESOLUTION_DENIED/);
    },
  );

  it("rejects a symlink escape for an existing relpath", async () => {
    const root = await fixture();
    const outside = await mkdtemp("C:\\Workspace\\m07-resolver-outside-");
    roots.push(outside);
    await writeFile(join(outside, "escape.mjs"), "export {};", "utf8");
    await symlink(outside, join(root, "link"), "junction");
    await expect(resolveTaskExecution(
      bound(root),
      "node.test.run",
      { testPath: "link/escape.mjs", reporter: "spec" },
      "a".repeat(64),
      root,
    )).rejects.toThrow(/TASK_RESOLUTION_DENIED/);
  });

  it.each(["toString", "constructor", "__proto__"])("denies inherited task name %s", async (taskId) => {
    const root = await fixture();
    await expect(resolveTaskExecution(bound(root), taskId, {}, "a".repeat(64), root))
      .rejects.toThrow(/TASK_RESOLUTION_DENIED/);
  });
});