import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RollbackBundleStore } from "../src/transactions/preimage.js";
import { rollbackPlans } from "../src/transactions/rollback.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0).reverse()) await rm(dir, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("M03 rollback conflict guard", () => {
  it("refuses to delete a transaction-created path after external byte drift", async () => {
    const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-rollback-");
    dirs.push(root);
    const path = join(root, "created.txt");
    await writeFile(path, "external-change", "utf8");
    const bundles = new RollbackBundleStore(root, "txn_" + "a".repeat(32));
    const result = await rollbackPlans([{ kind: "create", path, postSha256: sha("transaction-value") }], bundles);
    expect(result).toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe("external-change");
  });
  it("refuses to restore replace preimage over an externally changed postimage", async () => {
    const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-rollback-");
    dirs.push(root);
    const path = join(root, "replace.txt");
    const bundles = new RollbackBundleStore(root, "txn_" + "b".repeat(32));
    const captured = await bundles.capture(path, Buffer.from("before", "utf8"));
    await writeFile(path, "external-change", "utf8");
    const result = await rollbackPlans([{
      kind: "replace",
      path,
      preSha256: sha("before"),
      postSha256: sha("after"),
      bundlePath: captured.bundlePath,
    }], bundles);
    expect(result).toEqual({ decision: "DENY", reason: "ROLLBACK_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe("external-change");
  });
});
