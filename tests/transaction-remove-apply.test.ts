import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { applyTransaction } from "../src/transactions/apply.js";
import { RollbackBundleStore } from "../src/transactions/preimage.js";
import { rollbackPlans } from "../src/transactions/rollback.js";
import { beginTransaction, stageIntent, validateTransaction } from "../src/transactions/stage.js";
import { TransactionStore } from "../src/transactions/store.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CURRENT: TransactionCurrentness = { head: "a".repeat(40), branch: "refs/heads/haios/m04-safe-remove", trackedStateDigest: "b".repeat(64) };
const currentness = async () => CURRENT;
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

function filesystemMutationUpstream() {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    async writeFile(args: { path: string; content: string; mode: "rewrite" }) {
      calls.push({ name: "write_file", args });
      await writeFile(args.path, args.content, "utf8");
    },
    async moveFile(args: { source: string; destination: string }) {
      calls.push({ name: "move_file", args });
      const { mkdir, rename } = await import("node:fs/promises");
      await mkdir(join(args.destination, ".."), { recursive: true });
      await rename(args.source, args.destination);
    },
  };
}

async function fixture() {
  const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m04-remove-");
  dirs.push(root);
  const store = new TransactionStore();
  const begun = await beginTransaction(store, currentness);
  if (begun.decision !== "ALLOW") throw new Error("begin failed");
  return { root, store, id: begun.transaction.id };
}

async function stageValidatedRemove(root: string, store: TransactionStore, id: string, expected: string) {
  const path = join(root, "remove-me.txt");
  await writeFile(path, "before", "utf8");
  await stageIntent(store, id, { kind: "remove", path, expectedSha256: expected } as never);
  await validateTransaction(store, id, currentness);
  return path;
}

describe("M04 quarantine apply and rollback", () => {
  it("moves an exact-hash-bound file only into transaction-owned quarantine", async () => {
    const { root, store, id } = await fixture();
    const source = await stageValidatedRemove(root, store, id, sha("before"));
    const upstream = filesystemMutationUpstream();
    const bundles = new RollbackBundleStore(root, id);
    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(upstream), bundles);
    expect(result.decision).toBe("ALLOW");
    if (result.decision !== "ALLOW") return;
    expect(result.rollbackPlans).toHaveLength(1);
    const plan = result.rollbackPlans[0];
    expect(plan).toMatchObject({ kind: "remove", path: source, preSha256: sha("before") });
    if (!plan || plan.kind !== "remove") throw new Error("remove plan missing");
    expect(plan.quarantinePath.toLowerCase()).toContain(join(root, id, "quarantine").toLowerCase());
    expect(await exists(source)).toBe(false);
    expect(await readFile(plan.quarantinePath, "utf8")).toBe("before");
    expect(await readFile(plan.bundlePath, "utf8")).toBe("before");
    expect(upstream.calls).toEqual([{ name: "move_file", args: { source, destination: plan.quarantinePath } }]);
  });

  it("fails before mutation when expected bytes do not match", async () => {
    const { root, store, id } = await fixture();
    const source = await stageValidatedRemove(root, store, id, "0".repeat(64));
    const upstream = filesystemMutationUpstream();
    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(upstream), new RollbackBundleStore(root, id));
    expect(result).toEqual({ decision: "DENY", reason: "APPLY_FAILED_ROLLED_BACK" });
    expect(await readFile(source, "utf8")).toBe("before");
    expect(upstream.calls).toHaveLength(0);
  });

  it("restores exact bytes from quarantine on rollback", async () => {
    const { root, store, id } = await fixture();
    const source = await stageValidatedRemove(root, store, id, sha("before"));
    const bundles = new RollbackBundleStore(root, id);
    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(filesystemMutationUpstream()), bundles);
    if (result.decision !== "ALLOW") throw new Error("apply failed");
    const plan = result.rollbackPlans[0];
    if (!plan || plan.kind !== "remove") throw new Error("remove plan missing");
    await expect(rollbackPlans(result.rollbackPlans, bundles)).resolves.toEqual({ decision: "ALLOW" });
    expect(await readFile(source, "utf8")).toBe("before");
    expect(await exists(plan.quarantinePath)).toBe(false);
  });

  it("fails closed when the source is recreated externally before rollback", async () => {
    const { root, store, id } = await fixture();
    const source = await stageValidatedRemove(root, store, id, sha("before"));
    const bundles = new RollbackBundleStore(root, id);
    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(filesystemMutationUpstream()), bundles);
    if (result.decision !== "ALLOW") throw new Error("apply failed");
    const plan = result.rollbackPlans[0];
    if (!plan || plan.kind !== "remove") throw new Error("remove plan missing");
    await writeFile(source, "external", "utf8");
    await expect(rollbackPlans(result.rollbackPlans, bundles)).resolves.toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await readFile(source, "utf8")).toBe("external");
    expect(await readFile(plan.quarantinePath, "utf8")).toBe("before");
  });

  it("fails closed when quarantined bytes drift before rollback", async () => {
    const { root, store, id } = await fixture();
    const source = await stageValidatedRemove(root, store, id, sha("before"));
    const bundles = new RollbackBundleStore(root, id);
    const result = await applyTransaction(store, id, currentness, new TransactionMutationAdapter(filesystemMutationUpstream()), bundles);
    if (result.decision !== "ALLOW") throw new Error("apply failed");
    const plan = result.rollbackPlans[0];
    if (!plan || plan.kind !== "remove") throw new Error("remove plan missing");
    await writeFile(plan.quarantinePath, "tampered", "utf8");
    await expect(rollbackPlans(result.rollbackPlans, bundles)).resolves.toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await exists(source)).toBe(false);
    expect(await readFile(plan.quarantinePath, "utf8")).toBe("tampered");
  });
});
