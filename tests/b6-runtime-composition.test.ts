import { win32 } from "node:path";
import { describe, expect, it } from "vitest";

import * as core from "../src/operator/m12-active-canary-operator-core.js";

describe("B6 final-B5 composition boundary", () => {
  it("exposes only the B6 server-owned composition seam", () => {
    expect(Object.hasOwn(core, "createFinalB5OperatorRuntime")).toBe(false);
    expect(Object.hasOwn(core, "createB6FinalB5OperatorRuntime")).toBe(true);
  });

  it("denies caller-selected state paths and project maps before composition", async () => {
    const secure = (core as Record<string, unknown>).createB6FinalB5OperatorRuntime;
    expect(typeof secure).toBe("function");
    if (typeof secure !== "function") return;
    const invoke = secure as (value: unknown) => Promise<unknown>;
    await expect(invoke({ stateRoot: "C:\\other", worktreeRoot: "C:\\other\\worktrees", stage: "SKILL_FABRIC" }))
      .rejects.toThrow("M12_FINAL_B5_PROJECT_POLICY_DENIED");
    const localAppData = process.env.LOCALAPPDATA!;
    const stateRoot = win32.join(localAppData, "HAIOS", "B6");
    const worktreeRoot = win32.join(stateRoot, "worktrees");
    await expect(invoke({ stateRoot, worktreeRoot, stage: "SKILL_FABRIC", allowedProjects: { forged: "C:\\forged" } }))
      .rejects.toThrow("M12_FINAL_B5_PROJECT_POLICY_DENIED");
  });
});
