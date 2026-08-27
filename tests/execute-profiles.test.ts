import { describe, expect, it } from "vitest";

import {
  EXECUTION_PROFILES,
  resolveExecutionProfile,
} from "../src/execute-profiles.js";

const ROOT = "C:\\Workspace\\haios-desktop-control";

function expectFixed(name: string, args: unknown, fragment: string) {
  const result = resolveExecutionProfile(name, args);
  expect(result.decision).toBe("ALLOW");
  if (result.decision !== "ALLOW") throw new Error("expected allow");
  expect(result.profile.command).toContain(`Set-Location -LiteralPath '${ROOT}'`);
  expect(result.profile.command).toContain(fragment);
  expect(result.profile.command).not.toContain("$args");
  expect(result.profile.timeoutMs).toBeLessThanOrEqual(180_000);
  expect(result.profile.shell).toBe("powershell");
}

describe("M02 fixed execution profiles", () => {
  it("defines exactly six immutable profiles", () => {
    expect(Object.keys(EXECUTION_PROFILES)).toEqual([
      "project_test",
      "project_typecheck",
      "project_build",
      "git_status",
      "git_diff",
      "git_log",
    ]);
    expect(Object.isFrozen(EXECUTION_PROFILES)).toBe(true);
  });
  it("resolves the fixed project profiles", () => {
    expectFixed("project_test", {}, "npm.cmd test");
    expectFixed("project_typecheck", {}, "npm.cmd run typecheck");
    expectFixed("project_build", {}, "npm.cmd run build");
    expectFixed("git_status", {}, "git status --short --branch");
  });

  it("selects only the two predefined git diff variants", () => {
    expectFixed("git_diff", { mode: "working" }, "git diff --");
    expectFixed("git_diff", { mode: "staged" }, "git diff --cached --");
    expect(resolveExecutionProfile("git_diff", { mode: "other" })).toEqual({
      decision: "DENY",
      reason: "INVALID_ARGUMENTS",
    });
  });

  it("accepts only bounded integer git log counts", () => {
    expectFixed("git_log", { maxCount: 1 }, "git log -1 --oneline --decorate");
    expectFixed("git_log", { maxCount: 20 }, "git log -20 --oneline --decorate");
    expectFixed("git_log", {}, "git log -10 --oneline --decorate");
    for (const maxCount of [0, 21, 1.5, "2", "1; whoami"]) {
      expect(resolveExecutionProfile("git_log", { maxCount })).toEqual({
        decision: "DENY",
        reason: "INVALID_ARGUMENTS",
      });
    }
  });
  it.each(["project_test", "project_typecheck", "project_build", "git_status"])(
    "rejects extra client-controlled properties for %s",
    (name) => {
      expect(resolveExecutionProfile(name, { command: "whoami" })).toEqual({
        decision: "DENY",
        reason: "INVALID_ARGUMENTS",
      });
    },
  );

  it("rejects unknown and raw process profiles", () => {
    for (const name of ["start_process", "powershell", "cmd", "unknown"]) {
      expect(resolveExecutionProfile(name, {})).toEqual({
        decision: "DENY",
        reason: "PROFILE_DENIED",
      });
    }
  });
});
