import { describe, expect, it } from "vitest";

import { TransactionStore } from "../src/transactions/store.js";
import { beginTransaction, stageIntent, validateTransaction } from "../src/transactions/stage.js";
import type { TransactionCurrentness } from "../src/transactions/types.js";

const CURRENT: TransactionCurrentness = Object.freeze({
  head: "a".repeat(40),
  branch: "refs/heads/haios/m03-transactional-mutate",
  trackedStateDigest: "b".repeat(64),
});

function currentness(value: TransactionCurrentness = CURRENT) {
  return async () => value;
}

describe("M03 transaction begin/stage", () => {
  it("issues a server-owned bounded transaction id and captures currentness", async () => {
    const store = new TransactionStore();
    const result = await beginTransaction(store, currentness());
    expect(result.decision).toBe("ALLOW");
    if (result.decision !== "ALLOW") return;
    expect(result.transaction.id).toMatch(/^txn_[a-f0-9]{32}$/);
    expect(result.transaction.state).toBe("OPEN");
    expect(result.transaction.currentness).toEqual(CURRENT);
  });
  it("stages create/replace/move intents only under the project root", async () => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness());
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    const id = begun.transaction.id;

    await expect(stageIntent(store, id, {
      kind: "create", path: "C:\\Workspace\\haios-desktop-control\\tmp\\new.txt", content: "new",
    })).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
    await expect(stageIntent(store, id, {
      kind: "replace", path: "C:\\Workspace\\haios-desktop-control\\src\\baseline.ts", expectedSha256: "c".repeat(64), content: "export {};",
    })).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
    await expect(stageIntent(store, id, {
      kind: "move", sourcePath: "C:\\Workspace\\haios-desktop-control\\tmp\\a.txt", destinationPath: "C:\\Workspace\\haios-desktop-control\\tmp\\b.txt",
    })).resolves.toMatchObject({ decision: "ALLOW", state: "STAGED" });
    expect(store.require(id).intents).toHaveLength(3);
  });

  it.each([
    "C:\\Windows\\system.ini",
    "C:\\Workspace\\haios-desktop-control\\..\\..\\Windows\\system.ini",
    "C:\\Workspace\\haios-desktop-control\\.env",
  ])("denies unauthorized stage path %s", async (path) => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness());
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    await expect(stageIntent(store, begun.transaction.id, { kind: "create", path, content: "x" }))
      .resolves.toMatchObject({ decision: "DENY" });
    expect(store.require(begun.transaction.id).intents).toHaveLength(0);
  });
  it("rejects duplicate/conflicting target intents", async () => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness());
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    const id = begun.transaction.id;
    const path = "C:\\Workspace\\haios-desktop-control\\tmp\\same.txt";
    await stageIntent(store, id, { kind: "create", path, content: "a" });
    await expect(stageIntent(store, id, { kind: "replace", path, expectedSha256: "d".repeat(64), content: "b" }))
      .resolves.toEqual({ decision: "DENY", reason: "CONFLICTING_TRANSACTION_INTENT" });
  });

  it("fails validation closed when HEAD/tracked state changed", async () => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness());
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    await stageIntent(store, begun.transaction.id, {
      kind: "create", path: "C:\\Workspace\\haios-desktop-control\\tmp\\stale.txt", content: "x",
    });
    const drifted = { ...CURRENT, trackedStateDigest: "e".repeat(64) };
    await expect(validateTransaction(store, begun.transaction.id, currentness(drifted)))
      .resolves.toEqual({ decision: "DENY", reason: "STALE_TRANSACTION" });
    expect(store.require(begun.transaction.id).state).toBe("STAGED");
  });

  it("validates a current staged transaction without filesystem mutation", async () => {
    const store = new TransactionStore();
    const begun = await beginTransaction(store, currentness());
    if (begun.decision !== "ALLOW") throw new Error("begin failed");
    await stageIntent(store, begun.transaction.id, {
      kind: "create", path: "C:\\Workspace\\haios-desktop-control\\tmp\\valid.txt", content: "x",
    });
    await expect(validateTransaction(store, begun.transaction.id, currentness()))
      .resolves.toMatchObject({ decision: "ALLOW", state: "VALIDATED" });
  });
});
