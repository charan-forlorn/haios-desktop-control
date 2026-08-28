import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateTaskEffectPolicy } from "../src/operator/task-effects.js";
import {
  captureTaskEffectManifest,
  classifyTaskEffectDelta,
} from "../src/operator/task-effect-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

function boundPolicy() {
  return Object.freeze({
    policySet: validateTaskEffectPolicy({
      policySetId: "m07-effects",
      version: "1.0.0",
      policies: {
        "default-artifacts-v1": {
          allowedArtifactPatterns: ["dist/**", "coverage/**", "*.tsbuildinfo", "**/.cache/**"],
          protectedPatterns: [
            "src/**", "**/.git/**", ".env*", "**/.env*", "**/*secret*", "**/*secret*/**",
            "**/*credential*", "**/*credential*/**",
          ],
        },
      },
    }),    sha256: "b".repeat(64),
    sourcePath: "C:\\policy.json",
  });
}

async function fixture() {
  const root = await mkdtemp("C:\\Workspace\\m07-effects-");
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export const x = 1;", "utf8");
  return root;
}

describe("M07 bounded task effect manifest", () => {
  it("captures deterministic regular-file inventory and ignores .git metadata", async () => {
    const root = await fixture();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "private", "utf8");
    const manifest = await captureTaskEffectManifest(root);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["src/main.ts"]);
    expect(manifest.entries[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.totalBytes).toBeGreaterThan(0);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
  });

  it("classifies declared artifacts while protected and tracked-source effects deny", async () => {
    const root = await fixture();
    const before = await captureTaskEffectManifest(root);
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "build", "utf8");
    await writeFile(join(root, "src", "main.ts"), "mutated", "utf8");
    const after = await captureTaskEffectManifest(root);    const delta = classifyTaskEffectDelta(before, after, boundPolicy(), "default-artifacts-v1");
    expect(delta).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "dist/bundle.js", classification: "ALLOWED_ARTIFACT" }),
      expect.objectContaining({ path: "src/main.ts", classification: "PROTECTED" }),
    ]));
  });

  it("classifies unlisted workspace effects as UNCLASSIFIED", async () => {
    const root = await fixture();
    const before = await captureTaskEffectManifest(root);
    await writeFile(join(root, "unexpected.txt"), "x", "utf8");
    const after = await captureTaskEffectManifest(root);
    expect(classifyTaskEffectDelta(before, after, boundPolicy(), "default-artifacts-v1"))
      .toContainEqual(expect.objectContaining({ path: "unexpected.txt", classification: "UNCLASSIFIED" }));
  });

  it("records symlink/reparse effects as protected without following them", async () => {
    const root = await fixture();
    const outside = await mkdtemp("C:\\Workspace\\m07-effects-outside-");
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    const before = await captureTaskEffectManifest(root);
    await symlink(outside, join(root, "dist", "link"), "junction").catch(async () => {
      await mkdir(join(root, "dist"), { recursive: true });
      await symlink(outside, join(root, "dist", "link"), "junction");
    });
    const after = await captureTaskEffectManifest(root);
    const effect = classifyTaskEffectDelta(before, after, boundPolicy(), "default-artifacts-v1")
      .find((entry) => entry.path === "dist/link");
    expect(effect?.classification).toBe("PROTECTED");
  });
  it("fails closed when inventory limits are exceeded", async () => {
    const root = await fixture();
    await writeFile(join(root, "huge.bin"), Buffer.alloc(32), { flag: "w" });
    await expect(captureTaskEffectManifest(root, { maxFileBytes: 16 }))
      .rejects.toThrow(/TASK_EFFECT_MANIFEST_DENIED/);
  });

  it("fails closed for an unknown policy id", async () => {
    const root = await fixture();
    const before = await captureTaskEffectManifest(root);
    expect(() => classifyTaskEffectDelta(before, before, boundPolicy(), "missing-policy"))
      .toThrow(/TASK_EFFECT_CLASSIFICATION_DENIED/);
  });
});

describe("M07 effect inventory blind-spot remediation", () => {
  it("captures a created empty directory", async () => {
    const root = await fixture();
    const before = await captureTaskEffectManifest(root);
    await mkdir(join(root, "unexpected-empty"));
    const after = await captureTaskEffectManifest(root);
    expect(classifyTaskEffectDelta(before, after, boundPolicy(), "default-artifacts-v1"))
      .toContainEqual(expect.objectContaining({ path: "unexpected-empty", operation: "CREATED", classification: "UNCLASSIFIED" }));
  });
  it("captures nested .git effects as protected instead of hiding them", async () => {
    const root = await fixture();
    const before = await captureTaskEffectManifest(root);
    await mkdir(join(root, "dist", ".git"), { recursive: true });
    await writeFile(join(root, "dist", ".git", "config"), "malicious", "utf8");
    const after = await captureTaskEffectManifest(root);
    expect(classifyTaskEffectDelta(before, after, boundPolicy(), "default-artifacts-v1"))
      .toContainEqual(expect.objectContaining({ path: "dist/.git/config", classification: "PROTECTED" }));
  });
});

describe("M07 empty-directory inventory bounds", () => {
  it("counts empty directories against the entry ceiling", async () => {
    const root = await mkdtemp("C:\\Workspace\\m07-effects-empty-");
    roots.push(root);
    await mkdir(join(root, "empty-a"));
    await mkdir(join(root, "empty-b"));
    await expect(captureTaskEffectManifest(root, { maxEntries: 1 }))
      .rejects.toThrow(/TASK_EFFECT_MANIFEST_DENIED:ENTRY_COUNT/);
  });
});
