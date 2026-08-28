import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { classifyGatewayTool } from "../src/capabilities.js";
import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { dispatchTransactionTool, TransactionService } from "../src/transactions/service.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true }); });
const BASE: TransactionCurrentness = { head: "a".repeat(40), branch: "refs/heads/haios/m04-safe-remove", trackedStateDigest: "b".repeat(64) };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

function upstream() {
  return {
    async writeFile(args: { path: string; content: string; mode: "rewrite" }) { await writeFile(args.path, args.content, "utf8"); },
    async moveFile(args: { source: string; destination: string }) {
      await mkdir(join(args.destination, ".."), { recursive: true });
      await rename(args.source, args.destination);
    },
  };
}

async function fixture(verifier: () => Promise<boolean> = async () => true) {
  const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m04-adv-");
  dirs.push(root);
  const service = new TransactionService({ currentness: async () => BASE, adapter: new TransactionMutationAdapter(upstream()), rollbackRoot: root, verifier });
  return { root, service };
}

async function begin(service: TransactionService) {
  const result = await service.begin();
  if (result.decision !== "ALLOW") throw new Error("begin failed");
  return result.transactionId;
}

async function stageRemoveAndValidate(service: TransactionService, path: string, bytes: Buffer | string) {
  await writeFile(path, bytes);
  const id = await begin(service);
  const hash = digest(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
  await expect(service.stageRemove(id, path, hash)).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
  await expect(service.validate(id)).resolves.toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
  return id;
}

describe("M04 adversarial safe-remove boundary", () => {
  it.each([
    "C:\\Windows\\win.ini",
    "C:\\Workspace\\haios-desktop-control\\runtime\\..\\..\\outside.txt",
    "C:\\Workspace\\haios-desktop-control\\.env",
  ])("denies outside/traversal/sensitive remove path %s", async (path) => {
    const { service } = await fixture();
    const id = await begin(service);
    await expect(service.stageRemove(id, path, "a".repeat(64))).resolves.toMatchObject({ decision: "DENY" });
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "OPEN", intentCount: 0 });
  });

  it("denies directory removal", async () => {
    const { root, service } = await fixture();
    const id = await begin(service);
    await expect(service.stageRemove(id, root, "a".repeat(64))).resolves.toEqual({ decision: "DENY", reason: "REMOVE_TARGET_NOT_REGULAR_FILE" });
  });

  it("rejects a project-local junction whose real target escapes the project root", async () => {
    const outside = await mkdtemp("C:\\Workspace\\m04-outside-");
    dirs.push(outside);
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "outside", "utf8");
    const { root, service } = await fixture();
    const junction = join(root, "escape-junction");
    await symlink(outside, junction, "junction");
    const id = await begin(service);
    await expect(service.stageRemove(id, join(junction, "secret.txt"), digest("outside"))).resolves.toMatchObject({ decision: "DENY" });
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });

  it("re-authorizes the project realpath after validation before remove mutation", async () => {
    const outside = await mkdtemp("C:\\Workspace\\m04-toctou-outside-");
    dirs.push(outside);
    const { root, service } = await fixture();
    const parent = join(root, "swap-parent");
    await mkdir(parent, { recursive: true });
    const target = join(parent, "victim.txt");
    const id = await stageRemoveAndValidate(service, target, "same-bytes");

    await rm(parent, { recursive: true, force: true });
    const outsideTarget = join(outside, "victim.txt");
    await writeFile(outsideTarget, "same-bytes", "utf8");
    await symlink(outside, parent, "junction");

    await expect(service.apply(id)).resolves.toMatchObject({ decision: "DENY" });
    expect(await readFile(outsideTarget, "utf8")).toBe("same-bytes");
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
  });

  it("rejects a non-regular remove source again at the mutation adapter boundary", async () => {
    const { root } = await fixture();
    const directoryTarget = join(root, "became-directory");
    await mkdir(directoryTarget, { recursive: true });
    const adapter = new TransactionMutationAdapter(upstream());
    await expect(adapter.removeToQuarantine(
      directoryTarget,
      join(root, "txn_" + "a".repeat(32), "quarantine", "target.bin"),
      "a".repeat(64),
    )).resolves.toEqual({ decision: "DENY", reason: "REMOVE_TARGET_NOT_REGULAR_FILE" });
  });
  it.each(["delete", "unlink", "rm", "move_file"])("keeps raw destructive primitive %s unavailable", async (name) => {
    const { service } = await fixture();
    expect(classifyGatewayTool(name)).toBe("UNKNOWN");
    await expect(dispatchTransactionTool(service, name, {})).resolves.toEqual({ decision: "DENY", reason: "TOOL_DENIED" });
  });

  it("rejects unknown remove fields", async () => {
    const { root, service } = await fixture();
    const path = join(root, "owned.txt");
    await writeFile(path, "owned", "utf8");
    const id = await begin(service);
    await expect(dispatchTransactionTool(service, "transaction_stage_remove", { transactionId: id, path, expectedSha256: digest("owned"), recursive: true }))
      .resolves.toEqual({ decision: "DENY", reason: "INVALID_MUTATION_ARGUMENTS" });
    expect(await readFile(path, "utf8")).toBe("owned");
  });

  it("preserves drifted bytes when target changes after validation", async () => {
    const { root, service } = await fixture();
    const path = join(root, "drift.txt");
    const id = await stageRemoveAndValidate(service, path, "before");
    await writeFile(path, "external-drift", "utf8");
    await expect(service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "APPLY_FAILED_ROLLED_BACK" });
    expect(await readFile(path, "utf8")).toBe("external-drift");
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
  });

  it("rejects apply replay after promoted removal", async () => {
    const { root, service } = await fixture();
    const path = join(root, "once.txt");
    const id = await stageRemoveAndValidate(service, path, "once");
    await expect(service.apply(id)).resolves.toMatchObject({ decision: "ALLOW", state: "PROMOTED" });
    expect(await exists(path)).toBe(false);
    await expect(service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION" });
    expect(await exists(path)).toBe(false);
  });

  it("preserves externally recreated source and leaves recovery state fail-closed", async () => {
    let target = "";
    const fx = await fixture(async () => {
      await writeFile(target, "external-owner", "utf8");
      return false;
    });
    target = join(fx.root, "recreated.txt");
    const id = await stageRemoveAndValidate(fx.service, target, "transaction-preimage");
    await expect(fx.service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await readFile(target, "utf8")).toBe("external-owner");
    expect(await fx.service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLBACK_REQUIRED" });
  });

  it("detects quarantine tamper and does not recreate canonical bytes", async () => {
    let root = "";
    let id = "";
    const fx = await fixture(async () => {
      const quarantine = join(root, id, "quarantine");
      const names = await readdir(quarantine);
      expect(names).toHaveLength(1);
      await writeFile(join(quarantine, names[0]!), "tampered", "utf8");
      return false;
    });
    root = fx.root;
    const target = join(root, "tamper.txt");
    id = await stageRemoveAndValidate(fx.service, target, "before");
    await expect(fx.service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await exists(target)).toBe(false);
    expect(await fx.service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLBACK_REQUIRED" });
  });
});

describe("M04 qualification script contract", () => {
  it("binds safe-remove live/rollback, manifest, tunnel, cleanup and independent review gates", async () => {
    const script = await readFile("scripts/qualify-m04.ps1", "utf8");
    expect(script).toContain("M04_ADVERSARIAL_TESTS");
    expect(script).toContain("LIVE_TOOL_COUNT=27");
    expect(script).toContain("LIVE_SAFE_REMOVE_PROMOTION=PASS");
    expect(script).toContain("LIVE_SAFE_REMOVE_VERIFICATION_FAILURE_ROLLBACK=PASS");
    expect(script).toContain('const verifier = mode === "failure" ? async () => false');
    expect(script).toContain("Get-TunnelIntegrityDigest");
    expect(script).toContain("SOURCE_MANIFEST_DIGEST");
    expect(script).toContain("[StringComparer]::Ordinal");
    expect(script).toContain("[Text.UTF8Encoding]::new($false)");
    expect(script).toContain('($ManifestLines -join "`n") + "`n"');
    expect(script).not.toContain("git ls-files | Sort-Object");
    expect(script).toContain("RUNTIME_RESIDUE=0");
    expect(script).toContain("UNAUTHORIZED_MUTATIONS=0");
    expect(script).toContain("SECRETS_PERSISTED=FALSE");
    expect(script).toContain("HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_READY_FOR_INDEPENDENT_VERIFICATION");
  });
});
