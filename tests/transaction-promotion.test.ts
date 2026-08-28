import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { TransactionService } from "../src/transactions/service.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true });
});
const CURRENT: TransactionCurrentness = {
  head: "a".repeat(40), branch: "refs/heads/test", trackedStateDigest: "b".repeat(64),
};
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

function mutationUpstream() {
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
async function fixture(verifier: () => Promise<boolean>) {
  const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-service-");
  dirs.push(root);
  const service = new TransactionService({
    currentness: async () => CURRENT,
    adapter: new TransactionMutationAdapter(mutationUpstream()),
    rollbackRoot: root,
    verifier,
  });
  return { root, service };
}

async function stagedCreate(service: TransactionService, path: string, content = "candidate") {
  const begun = await service.begin();
  expect(begun.decision).toBe("ALLOW");
  if (begun.decision !== "ALLOW") throw new Error("begin failed");
  const id = begun.transactionId;
  await expect(service.stageCreate(id, path, content)).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
  await expect(service.validate(id)).resolves.toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
  return id;
}

describe("M03 transaction verification and promotion", () => {
  it("runs focused verification after apply and promotes only after VERIFIED", async () => {
    let service!: TransactionService;
    let id = "";
    const fx = await fixture(async () => {
      expect((await service.status(id))).toMatchObject({ decision: "ALLOW", state: "APPLIED" });
      return true;
    });    service = fx.service;
    const path = join(fx.root, "candidate.txt");
    id = await stagedCreate(service, path);

    await expect(service.promote(id)).resolves.toEqual({
      decision: "DENY", reason: "INVALID_TRANSACTION_TRANSITION",
    });
    const applied = await service.apply(id);
    expect(applied).toMatchObject({
      decision: "ALLOW", state: "PROMOTED", verificationProfile: "project_test",
    });
    expect(await readFile(path, "utf8")).toBe("candidate");
    expect(await service.status(id)).toMatchObject({
      decision: "ALLOW", state: "PROMOTED", intentCount: 1,
      verification: { profile: "project_test", result: "PASS" },
    });
  });

  it("automatically rolls back when focused verification fails", async () => {
    const { root, service } = await fixture(async () => false);
    const path = join(root, "verification-fail.txt");
    const id = await stagedCreate(service, path);

    await expect(service.apply(id)).resolves.toEqual({
      decision: "DENY", reason: "VERIFICATION_FAILED_ROLLED_BACK",
    });
    expect(await exists(path)).toBe(false);
    expect(await service.status(id)).toMatchObject({
      decision: "ALLOW", state: "ROLLED_BACK",
      verification: { profile: "project_test", result: "FAIL" },
    });
  });
  it("restores replaced bytes exactly when verification fails", async () => {
    const { root, service } = await fixture(async () => false);
    const path = join(root, "replace.txt");
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x00]);
    await writeFile(path, original);
    const begun = await service.begin();
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    const id = begun.transactionId;
    await expect(service.stageReplace(id, path, createHash("sha256").update(original).digest("hex"), "changed"))
      .resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
    await service.validate(id);

    await expect(service.apply(id)).resolves.toEqual({
      decision: "DENY", reason: "VERIFICATION_FAILED_ROLLED_BACK",
    });
    expect(await readFile(path)).toEqual(original);
    expect(await service.status(id)).toMatchObject({ decision: "ALLOW", state: "ROLLED_BACK" });
  });

  it("binds every operation to the exact server-issued transaction id", async () => {
    const { root, service } = await fixture(async () => true);
    const begun = await service.begin();
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    const path = join(root, "bound.txt");
    await expect(service.stageCreate("txn_" + "0".repeat(32), path, "x"))
      .resolves.toEqual({ decision: "DENY", reason: "TRANSACTION_NOT_FOUND" });
    expect(await exists(path)).toBe(false);
    expect(await service.status(begun.transactionId)).toMatchObject({ decision: "ALLOW", state: "OPEN", intentCount: 0 });
  });
});
