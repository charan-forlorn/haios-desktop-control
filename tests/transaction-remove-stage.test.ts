import { describe, expect, it } from "vitest";

import { TransactionStore } from "../src/transactions/store.js";
import { beginTransaction, stageIntent } from "../src/transactions/stage.js";
import { dispatchTransactionTool } from "../src/transactions/service.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const CURRENT: TransactionCurrentness = Object.freeze({
  head: "a".repeat(40),
  branch: "refs/heads/haios/m04-safe-remove",
  trackedStateDigest: "b".repeat(64),
});
const currentness = async () => CURRENT;
const PROJECT_FILE = "C:\\Workspace\\haios-desktop-control\\package.json";
const PROJECT_DIR = "C:\\Workspace\\haios-desktop-control\\runtime";

describe("M04 safe-remove staging", () => {
  it("stages an expected-hash-bound regular file", async () => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness);
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    await expect(stageIntent(store, begun.transaction.id, {
      kind: "remove", path: PROJECT_FILE, expectedSha256: "c".repeat(64),
    } as never)).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
  });

  it.each([
    { path: PROJECT_FILE, expectedSha256: "bad" },
    { path: PROJECT_DIR, expectedSha256: "c".repeat(64) },
    { path: "C:\\Windows\\system.ini", expectedSha256: "c".repeat(64) },
    { path: "C:\\Workspace\\haios-desktop-control\\.env", expectedSha256: "c".repeat(64) },
  ])("denies invalid remove target %#", async ({ path, expectedSha256 }) => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness);
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    await expect(stageIntent(store, begun.transaction.id, {
      kind: "remove", path, expectedSha256,
    } as never)).resolves.toMatchObject({ decision: "DENY" });
  });

  it("rejects remove when the canonical path is already referenced", async () => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness);
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    await stageIntent(store, begun.transaction.id, {
      kind: "replace", path: PROJECT_FILE, expectedSha256: "c".repeat(64), content: "x",
    });
    await expect(stageIntent(store, begun.transaction.id, {
      kind: "remove", path: PROJECT_FILE, expectedSha256: "d".repeat(64),
    } as never)).resolves.toEqual({ decision: "DENY", reason: "CONFLICTING_TRANSACTION_INTENT" });
  });

  it("routes exact transaction_stage_remove arguments and rejects extras", async () => {
    const calls: unknown[] = [];
    const service = {
      stageRemove: async (...args: unknown[]) => { calls.push(args); return { decision: "ALLOW", state: "STAGED", transactionId: String(args[0]) }; },
    } as never;
    const exact = { transactionId: "txn_" + "a".repeat(32), path: PROJECT_FILE, expectedSha256: "c".repeat(64) };
    await expect(dispatchTransactionTool(service, "transaction_stage_remove", exact))
      .resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
    expect(calls).toEqual([[exact.transactionId, exact.path, exact.expectedSha256]]);
    await expect(dispatchTransactionTool(service, "transaction_stage_remove", { ...exact, extra: "x" }))
      .resolves.toEqual({ decision: "DENY", reason: "INVALID_MUTATION_ARGUMENTS" });
  });
});
