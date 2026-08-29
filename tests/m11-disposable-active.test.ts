import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createM11DisposableFixtureRuntime } from "../src/operator/m11-active-canary-runtime.js";

const roots: string[] = [];
async function fixture() {
  const root = join(process.cwd(), "runtime", "m11-fixture", `vitest-${process.pid}-${Date.now()}`);
  roots.push(root);
  const canonicalRoot = join(root, "canonical");
  const worktreeRoot = join(root, "worktrees");
  const apiKeyFile = join(root, "m11-api-key.txt");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(apiKeyFile, "M11-FIXTURE-KEY-1234567890", "utf8");
  return { apiKeyFile, worktreeRoot, canonicalRoot, projectId: "m11-fixture", port: 18779, mode: "ACTIVE", activationScope: "M11_DISPOSABLE_FIXTURE_ONLY" } as const;
}
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});
describe("M11 disposable ACTIVE fixture boundary", () => {
  it("constructs only an explicit fixture-scoped ACTIVE runtime", async () => {
    const config = await fixture();
    const runtime = await createM11DisposableFixtureRuntime(config);
    await runtime.close();
  });

  it("rejects production ports, wrong scope/project, and paths outside runtime/m11-fixture", async () => {
    const config = await fixture();
    for (const bad of [
      { ...config, port: 8768 },
      { ...config, port: 8769 },
      { ...config, activationScope: "M11_CANARY_ONLY" },
      { ...config, projectId: "operator-canary" },
      { ...config, canonicalRoot: "C:\\Workspace\\haios-operator-canary" },
      { ...config, worktreeRoot: "C:\\Workspace\\outside" },
    ]) {
      await expect(createM11DisposableFixtureRuntime(bad)).rejects.toThrow("M11_DISPOSABLE_FIXTURE_CONFIG_DENIED");
    }
  });
});
describe("M11 disposable ACTIVE qualification helper", () => {
  it("proves the complete local transaction and stale-CAS path", async () => {
    const helper = await readFile(join(process.cwd(), "scripts", "live-m11-disposable-active.mjs"), "utf8");
    for (const marker of [
      "createM11DisposableFixtureRuntime", "operator_begin_transaction", "operator_stage_patch",
      "operator_validate_transaction", "operator_apply_transaction", "operator_run_task", "project.test",
      "operator_git_checkpoint", "operator_promote_transaction", "operator_rollback_transaction",
      "canonicalUnchangedBeforePromotion", "promotionPassed", "rollbackPassed", "staleCasDenied",
      "stalePromotionNoMutation", "worktreeResidueZero", "apiKeyFileRemoved",
    ]) expect(helper).toContain(marker);
  });

  it("captures and preserves real canary, M10 task, listeners, and tunnels", async () => {
    const helper = await readFile(join(process.cwd(), "scripts", "live-m11-disposable-active.mjs"), "utf8");
    for (const marker of [
      "haios-operator-canary", "HAIOS-M10-Operator-ReadOnly",
      "haios-operator-dedicated-tunnel-client", "haios-tunnel-client", "8768", "8769",
      "realCanaryUnchanged", "m10TaskUnchanged", "listenersUnchanged", "tunnelsUnchanged",
    ]) expect(helper).toContain(marker);
    expect(helper).not.toContain('projectId: "operator-canary"');
  });
  it("keeps the PowerShell qualifier bounded to the disposable helper and durable result", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "qualify-m11-active-canary.ps1"), "utf8");
    for (const marker of [
      "runtime\\m11-fixture", "live-m11-disposable-active.mjs", "m11-disposable-active-result.json",
      "M11_DISPOSABLE_ACTIVE_QUALIFICATION_PASS", "C:\\Workspace\\haios-operator-canary",
      "HAIOS-M10-Operator-ReadOnly", "haios-operator-dedicated-tunnel-client", "haios-tunnel-client",
    ]) expect(source).toContain(marker);
    for (const forbidden of [
      "Start-ScheduledTask", "Stop-ScheduledTask", "Register-ScheduledTask", "Unregister-ScheduledTask",
      "docker compose", "docker system prune", "git push", "git fetch", "git pull",
    ]) expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});

describe("M11 disposable fixture filesystem containment", () => {
  it("rejects junction or symlink escape outside runtime/m11-fixture", async () => {
    const config = await fixture();
    const target = join(process.cwd(), "runtime", `m11-fixture-escape-target-${process.pid}-${Date.now()}`);
    roots.push(target);
    await mkdir(target, { recursive: true });
    const escape = join((config.canonicalRoot as string), "..", "escape-link");
    await symlink(target, escape, "junction");
    await expect(createM11DisposableFixtureRuntime({ ...config, canonicalRoot: escape }))
      .rejects.toThrow("M11_DISPOSABLE_FIXTURE_CONFIG_DENIED");
  });

  it("requires unconditional runtime-root cleanup around the whole qualification", async () => {
    const helper = await readFile(join(process.cwd(), "scripts", "live-m11-disposable-active.mjs"), "utf8");
    expect(helper).toContain("async function runQualification()");
    expect(helper).toContain("await runQualification()");
    expect(helper).toMatch(/finally\s*\{[\s\S]*await rm\(runtimeRoot, \{ recursive: true, force: true \}\)/u);
  });
});

describe("M11 disposable helper destructive-path guard", () => {
  it("validates repo-owned fixture/evidence paths before recursive deletion or result write", async () => {
    const helper = await readFile(join(process.cwd(), "scripts", "live-m11-disposable-active.mjs"), "utf8");
    for (const marker of [
      "fileURLToPath(import.meta.url)", "runtime", "m11-fixture", "evidence", "m11",
      "realpath", "M11_DISPOSABLE_RUNTIME_ROOT_DENIED", "M11_DISPOSABLE_RESULT_PATH_DENIED",
      "await validateDisposablePaths",
    ]) expect(helper).toContain(marker);
    const guard = helper.indexOf("await validateDisposablePaths");
    const firstDelete = helper.indexOf("await rm(runtimeRoot");
    const resultWrite = helper.indexOf('open(resultPath, "wx")');
    expect(guard).toBeGreaterThan(0);
    expect(firstDelete).toBeGreaterThan(guard);
    expect(resultWrite).toBeGreaterThan(guard);
  });
});

describe("M11 disposable result final-component guard", () => {
  it("uses atomic exclusive result creation and rejects any preexisting final component", async () => {
    const helper = await readFile(join(process.cwd(), "scripts", "live-m11-disposable-active.mjs"), "utf8");
    for (const marker of [
      "lstat(resultPath)", "M11_DISPOSABLE_RESULT_PATH_PREEXISTS",
      'open(resultPath, "wx")', "M11_DISPOSABLE_RESULT_CREATE_DENIED",
      "resultHandle.writeFile", "resultHandle.close",
    ]) expect(helper).toContain(marker);
    expect(helper).not.toContain("await writeFile(resultPath");
  });
});
