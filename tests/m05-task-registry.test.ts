import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadTaskRegistry,
  validateTaskRegistry,
} from "../src/operator/task-registry.js";

const REGISTRY_PATH = join(process.cwd(), "task-registry.m05.json");

function validRegistry() {
  return {
    registryId: "test-registry",
    version: "1.0.0",
    tasks: {
      "node.test.run": {
        argvTemplate: ["node", "--test", "{{testPath}}"],
        paramSchemas: { testPath: { kind: "relpath", mustExist: true } },
        requiredParams: ["testPath"],
        sandboxProfile: "S0",
        effectPolicyRef: "default-artifacts-v1",
        timeoutMs: 300000,
      },
    },
  };
}

describe("M05 typed task registry foundation", () => {
  it("loads and SHA-256 binds the immutable registry", async () => {
    const bound = await loadTaskRegistry(REGISTRY_PATH);
    expect(bound.registry.registryId).toBe("haios-desktop-control-m05-task-registry");
    expect(bound.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(bound.registry)).toBe(true);
    expect(Object.keys(bound.registry.tasks)).toEqual([
      "node.test.run", "project.build", "project.test", "project.typecheck",
    ]);
  });
  it("accepts typed bounded recipes with fixed first argv token", () => {
    expect(() => validateTaskRegistry(validRegistry())).not.toThrow();
  });

  it.each([
    ["shell", true],
    ["command", "npm test"],
    ["cwd", "C:\\Workspace"],
    ["env", { TOKEN: "x" }],
    ["executable", "powershell.exe"],
  ] as const)("rejects forbidden recipe authority key %s", (key, value) => {
    const raw = validRegistry();
    Object.assign(raw.tasks["node.test.run"], { [key]: value });
    expect(() => validateTaskRegistry(raw)).toThrow(/TASK_REGISTRY_INVALID/);
  });

  it("rejects caller-controlled executable position", () => {
    const raw = validRegistry();
    raw.tasks["node.test.run"].argvTemplate = ["{{testPath}}"];
    expect(() => validateTaskRegistry(raw)).toThrow(/TASK_REGISTRY_INVALID/);
  });

  it("rejects S2 and unbounded timeouts", () => {
    const s2 = validRegistry();
    s2.tasks["node.test.run"].sandboxProfile = "S2" as never;
    expect(() => validateTaskRegistry(s2)).toThrow(/TASK_REGISTRY_INVALID/);
    const timeout = validRegistry();
    timeout.tasks["node.test.run"].timeoutMs = 900001;
    expect(() => validateTaskRegistry(timeout)).toThrow(/TASK_REGISTRY_INVALID/);
  });

  it("rejects undeclared placeholders", () => {
    const raw = validRegistry();
    raw.tasks["node.test.run"].argvTemplate.push("{{unknown}}");
    expect(() => validateTaskRegistry(raw)).toThrow(/TASK_REGISTRY_INVALID/);
  });
});