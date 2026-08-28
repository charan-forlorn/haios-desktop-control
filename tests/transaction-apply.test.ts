import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { applyTransaction } from "../src/transactions/apply.js";
import { RollbackBundleStore } from "../src/transactions/preimage.js";
import { beginTransaction, stageIntent, validateTransaction } from "../src/transactions/stage.js";
import { TransactionStore } from "../src/transactions/store.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CURRENT: TransactionCurrentness = { head: "a".repeat(40), branch: "refs/heads/test", trackedStateDigest: "b".repeat(64) };
const currentness = async () => CURRENT;

async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

function filesystemMutationUpstream() {
  return {
    async writeFile(args: { path: string; content: string; mode: "rewrite" }) { await mkdir(join(args.path, ".."), { recursive: true }); await writeFile(args.path, args.content, "utf8"); },
    async moveFile(args: { source: string; destination: string }) { await mkdir(join(args.destination, ".."), { recursive: true }); await rename(args.source, args.destination); },
  };
}
async function transactionFixture() {
  const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-apply-");
  dirs.push(root);
  const store = new TransactionStore();
  const begun = await beginTransaction(store, currentness);
  if (begun.decision !== "ALLOW") throw new Error("begin failed");
  const id = begun.transaction.id;
  return { root, store, id };
}

describe("M03 apply and automatic rollback", () => {
  it("applies validated create/replace/move intents and verifies postimages", async () => {
    const { root, store, id } = await transactionFixture();
    const replacePath = join(root, "replace.txt");
    const moveSource = join(root, "move-source.txt");
    const moveDestination = join(root, "move-destination.txt");
    const createPath = join(root, "created.txt");
    await writeFile(replacePath, "before", "utf8");
    await writeFile(moveSource, "move-me", "utf8");
    await stageIntent(store, id, { kind: "create", path: createPath, content: "created" });
    await stageIntent(store, id, { kind: "replace", path: replacePath, expectedSha256: sha("before"), content: "after" });
    await stageIntent(store, id, { kind: "move", sourcePath: moveSource, destinationPath: moveDestination });
    await validateTransaction(store, id, currentness);

    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(filesystemMutationUpstream()), new RollbackBundleStore(root, id));
    expect(result).toMatchObject({ decision: "ALLOW", state: "APPLIED" });
    expect(await readFile(createPath, "utf8")).toBe("created");
    expect(await readFile(replacePath, "utf8")).toBe("after");
    expect(await exists(moveSource)).toBe(false);
    expect(await readFile(moveDestination, "utf8")).toBe("move-me");
  });
  it("auto-rolls back byte-exact when a later apply step fails", async () => {
    const { root, store, id } = await transactionFixture();
    const replacePath = join(root, "replace.txt");
    const createPath = join(root, "created.txt");
    await writeFile(replacePath, "before", "utf8");
    await stageIntent(store, id, { kind: "replace", path: replacePath, expectedSha256: sha("before"), content: "after" });
    await stageIntent(store, id, { kind: "create", path: createPath, content: "created" });
    await validateTransaction(store, id, currentness);

    let writes = 0;
    const upstream = filesystemMutationUpstream();
    const failing = {
      ...upstream,
      async writeFile(args: { path: string; content: string; mode: "rewrite" }) {
        writes += 1;
        if (writes === 2) throw new Error("INJECTED_FAILURE");
        return upstream.writeFile(args);
      },
    };
    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(failing), new RollbackBundleStore(root, id));
    expect(result).toEqual({ decision: "DENY", reason: "APPLY_FAILED_ROLLED_BACK" });
    expect(await readFile(replacePath, "utf8")).toBe("before");
    expect(await exists(createPath)).toBe(false);
    expect(store.require(id).state).toBe("ROLLED_BACK");
  });

  it("fails before first mutation when currentness becomes stale", async () => {
    const { root, store, id } = await transactionFixture();
    const createPath = join(root, "created.txt");
    await stageIntent(store, id, { kind: "create", path: createPath, content: "created" });
    await validateTransaction(store, id, currentness);
    const drift = async () => ({ ...CURRENT, trackedStateDigest: "c".repeat(64) });
    const result = await applyTransaction(store, id, drift, new TransactionMutationAdapter(filesystemMutationUpstream()), new RollbackBundleStore(root, id));
    expect(result).toEqual({ decision: "DENY", reason: "STALE_TRANSACTION" });
    expect(await exists(createPath)).toBe(false);
  });
});
