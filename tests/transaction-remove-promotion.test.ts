import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { TransactionService } from "../src/transactions/service.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true }); });
const CURRENT: TransactionCurrentness = { head: "a".repeat(40), branch: "refs/heads/haios/m04-safe-remove", trackedStateDigest: "b".repeat(64) };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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

async function fixture(verifier: () => Promise<boolean>) {
  const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m04-promotion-");
  dirs.push(root);
  const service = new TransactionService({
    currentness: async () => CURRENT,
    adapter: new TransactionMutationAdapter(upstream()),
    rollbackRoot: root,
    verifier,
  });
  return { root, service };
}

async function stagedRemove(service: TransactionService, path: string, bytes: Buffer) {
  await writeFile(path, bytes);
  const begun = await service.begin();
  if (begun.decision !== "ALLOW") throw new Error("begin failed");
  const id = begun.transactionId;
  await expect(service.stageRemove(id, path, sha(bytes))).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
  await expect(service.validate(id)).resolves.toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
  return id;
}

describe("M04 remove verification and promotion", () => {
  it("promotes only after verifier observes the canonical file absent, then cleans runtime", async () => {
    let service!: TransactionService;
    let target = "";
    const fx = await fixture(async () => {
      expect(await exists(target)).toBe(false);
      return true;
    });
    service = fx.service;
    target = join(fx.root, "promote-remove.txt");
    const id = await stagedRemove(service, target, Buffer.from("remove-me", "utf8"));

    await expect(service.apply(id)).resolves.toMatchObject({ decision: "ALLOW", state: "PROMOTED", verificationProfile: "project_test" });
    expect(await exists(target)).toBe(false);
    expect(await exists(join(fx.root, id))).toBe(false);
    const status = await service.status(id);
    expect(status).toMatchObject({ decision: "ALLOW", state: "PROMOTED", intentCount: 1, verification: { result: "PASS" } });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("remove-me");
    expect(serialized).not.toContain("quarantine");
    expect(serialized).not.toContain(".bin");
  });

  it("restores exact binary bytes and cleans runtime when verification fails", async () => {
    const fx = await fixture(async () => false);
    const target = join(fx.root, "rollback-remove.bin");
    const original = Buffer.from([0x00, 0xff, 0x41, 0x0d, 0x0a, 0xef, 0xbb, 0xbf]);
    const id = await stagedRemove(fx.service, target, original);

    await expect(fx.service.apply(id)).resolves.toEqual({ decision: "DENY", reason: "VERIFICATION_FAILED_ROLLED_BACK" });
    expect(await readFile(target)).toEqual(original);
    expect(await exists(join(fx.root, id))).toBe(false);
    expect(await fx.service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK", verification: { result: "FAIL" } });
  });
});
