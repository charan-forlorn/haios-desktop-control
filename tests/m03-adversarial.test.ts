import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { dispatchTransactionTool, TransactionService } from "../src/transactions/service.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true });
});
const BASE: TransactionCurrentness = {
  head: "a".repeat(40), branch: "refs/heads/test", trackedStateDigest: "b".repeat(64),
};
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

function upstream() {
  return {
    async writeFile(args: { path: string; content: string; mode: "rewrite" }) {
      await mkdir(join(args.path, ".."), { recursive: true });
      await writeFile(args.path, args.content, "utf8");
    },
    async moveFile(args: { source: string; destination: string }) {
      await mkdir(join(args.destination, ".."), { recursive: true });
      await rename(args.source, args.destination);
    },
  };
}
async function fixture(
  verifier: () => Promise<boolean> = async () => true,
  currentness: () => Promise<TransactionCurrentness> = async () => BASE,
) {
  const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-adv-");
  dirs.push(root);
  const service = new TransactionService({
    currentness,
    adapter: new TransactionMutationAdapter(upstream()),
    rollbackRoot: root,
    verifier,
  });
  return { root, service };
}

async function begin(service: TransactionService) {
  const result = await service.begin();
  expect(result.decision).toBe("ALLOW");
  if (result.decision !== "ALLOW") throw new Error("begin failed");
  return result.transactionId;
}

async function stageAndValidate(service: TransactionService, path: string, content = "owned") {
  const id = await begin(service);
  await expect(service.stageCreate(id, path, content)).resolves.toMatchObject({ decision: "ALLOW" });
  await expect(service.validate(id)).resolves.toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
  return id;
}

describe("M03 adversarial transaction boundary", () => {
  it.each([
    "C:\\Windows\\system.ini",
    "C:\\Workspace\\haios-desktop-control\\runtime\\..\\..\\outside.txt",
    "C:\\Workspace\\haios-desktop-control\\.env",
  ])("denies outside/traversal/sensitive mutation path %s", async (path) => {
    const { service } = await fixture();
    const id = await begin(service);
    await expect(service.stageCreate(id, path, "x")).resolves.toMatchObject({ decision: "DENY" });
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "OPEN", intentCount: 0 });
  });

  it("rejects a project-local junction whose real target escapes the project root", async () => {
    const outside = await mkdtemp("C:\\Workspace\\m03-outside-");
    dirs.push(outside);
    const { root, service } = await fixture();
    const junction = join(root, "escape-junction");
    await symlink(outside, junction, "junction");
    const target = join(junction, "escaped.txt");
    const id = await begin(service);
    await expect(service.stageCreate(id, target, "must-not-write")).resolves.toMatchObject({ decision: "DENY" });
    expect(await exists(join(outside, "escaped.txt"))).toBe(false);
  });

  it("rejects unknown fields and raw mutation primitive names before execution", async () => {
    const { service } = await fixture();
    const id = await begin(service);
    await expect(dispatchTransactionTool(service, "transaction_status", { transactionId: id, extra: "x" }))
      .resolves.toEqual({ decision: "DENY", reason: "INVALID_MUTATION_ARGUMENTS" });
    await expect(dispatchTransactionTool(service, "write_file", { path: "C:\\Workspace\\haios-desktop-control\\x", content: "x" }))
      .resolves.toEqual({ decision: "DENY", reason: "TOOL_DENIED" });
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "OPEN", intentCount: 0 });
  });

  it("fails closed on stale currentness before apply with zero mutation", async () => {
    let current = BASE;
    const { root, service } = await fixture(async () => true, async () => current);
    const target = join(root, "stale.txt");
    const id = await stageAndValidate(service, target);
    current = { ...BASE, trackedStateDigest: "c".repeat(64) };
    await expect(service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "STALE_TRANSACTION" });
    expect(await exists(target)).toBe(false);
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
  });

  it("rejects transition replay after promotion without a second mutation", async () => {
    const { root, service } = await fixture();
    const target = join(root, "once.txt");
    const id = await stageAndValidate(service, target, "once");
    await expect(service.apply(id)).resolves.toMatchObject({ decision: "ALLOW", state: "PROMOTED" });
    const first = await readFile(target, "utf8");
    await expect(service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" });
    await expect(service.promote(id)).resolves.toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" });
    expect(await readFile(target, "utf8")).toBe(first);
  });

  it("preserves external drift and reports rollback conflict", async () => {
    let target = "";
    const { root, service } = await fixture(async () => {
      await writeFile(target, "external-owner", "utf8");
      return false;
    });
    target = join(root, "rollback-conflict.txt");
    const id = await stageAndValidate(service, target, "transaction-owned");
    await expect(service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await readFile(target, "utf8")).toBe("external-owner");
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLBACK_REQUIRED" });
  });

  it("verification failure without external drift rolls back to exact preimage", async () => {
    const { root, service } = await fixture(async () => false);
    const target = join(root, "verify-fail.txt");
    const id = await stageAndValidate(service, target, "temporary");
    await expect(service.apply(id)).resolves.toEqual({
      decision: "DENY", reason: "VERIFICATION_FAILED_ROLLED_BACK",
    });
    expect(await exists(target)).toBe(false);
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
  });
});

describe("M03 qualification script contract", () => {
  it("binds adversarial, live rollback, manifest, tunnel and independent-review handoff gates", async () => {
    const script = await readFile("scripts/qualify-m03.ps1", "utf8");
    expect(script).toContain("M03_ADVERSARIAL_TESTS");
    expect(script).toContain("FULL_TEST_PASSING_COUNT");
    expect(script).toContain("LIVE_TOOL_COUNT=26");
    expect(script).toContain("LIVE_CREATE_REPLACE_MOVE=PASS");
    expect(script).toContain("LIVE_VERIFICATION_FAILURE_ROLLBACK=PASS");
    expect(script).toContain("Get-TunnelIntegrityDigest");
    expect(script).toContain("SOURCE_MANIFEST_DIGEST");
    expect(script).toContain("UNAUTHORIZED_MUTATIONS=0");
    expect(script).toContain("SECRETS_PERSISTED=FALSE");
    expect(script).toContain("HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_READY_FOR_INDEPENDENT_VERIFICATION");
  });
});
