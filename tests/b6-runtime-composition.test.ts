import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import * as core from "../src/operator/m12-active-canary-operator-core.js";
import { createB6ActiveRuntime } from "../src/operator/b6-active-runtime.js";

describe("B6 final-B5 composition boundary", () => {
  it("exposes only the B6 server-owned composition seam", () => {
    expect(Object.hasOwn(core, "createFinalB5OperatorRuntime")).toBe(false);
    expect(Object.hasOwn(core, "createB6FinalB5OperatorRuntime")).toBe(true);
  });

  it("denies direct Hermes runtime construction without authenticated Stage-1 proof", async () => {
    const previous = process.env.LOCALAPPDATA;
    const root = await mkdtemp(join(tmpdir(), "b6-stage1-auth-"));
    try {
      process.env.LOCALAPPDATA = root;
      const keyDir = join(root, "HAIOS", "M10");
      await mkdir(keyDir, { recursive: true });
      await writeFile(join(keyDir, "operator-api-key"), "0123456789abcdef0123456789abcdef\n", "utf8");
      const stateRoot = win32.join(root, "HAIOS", "B6");
      await expect(createB6ActiveRuntime({
        apiKeyFile: win32.join(root, "HAIOS", "M10", "operator-api-key"), stateRoot, worktreeRoot: win32.join(stateRoot, "worktrees"),
        port: 8769, mode: "ACTIVE", activationScope: "B6_HERMES_OS_ADMISSION", stage: "HERMES_OS",
        allowedProjects: { "operator-canary": "C:\\Workspace\\haios-operator-canary", "skill-fabric": "C:\\Workspace\\haios-skill-fabric",
          "hermes-os": "C:\\Workspace\\hermes-ai-operating-system-b6-canonical" },
      })).rejects.toThrow("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
      const direct = (core as Record<string, unknown>).createB6FinalB5OperatorRuntime as ((value: unknown) => Promise<unknown>);
      await expect(direct({ stateRoot, worktreeRoot: win32.join(stateRoot, "worktrees"), stage: "HERMES_OS" }))
        .rejects.toThrow("B6_STAGE_ONE_AUTHENTICATED_PROOF_REQUIRED");
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
      await rm(root, { recursive: true, force: true });
    }
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
