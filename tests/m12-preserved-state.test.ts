import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const verifierPath = join(process.cwd(), "scripts", "verify-m12-preserved-state.mjs");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "m12-preserved-state-")); roots.push(base);
  const root = join(base, "state"); const canaryRoot = join(base, "canary"); const apiKeyFile = join(base, "operator-api-key");
  await mkdir(root); await mkdir(canaryRoot); await writeFile(apiKeyFile, "fixture-key\n", "utf8");
  for (const dir of ["worktrees", "leases", "transaction-recovery", "remediation"]) await mkdir(join(root, dir));
  const hostConfig = { apiKeyFile, worktreeRoot: join(root, "worktrees"), stateRoot: root,
    allowedProjects: { "operator-canary": canaryRoot }, port: 8769, mode: "ACTIVE", activationScope: "M12_B5_CANARY_STABILITY_ONLY" };
  await writeFile(join(root, "host-config.json"), JSON.stringify(hostConfig, null, 2) + "\n", "utf8");
  return { root, canaryRoot, apiKeyFile };
}

async function writeEpisode(root: string, overrides: Record<string, unknown> = {}) {
  const snapshot = { schema: "HAIOS_M12_REMEDIATION_EPISODE_R1", episodeId: `episode-${"a".repeat(32)}`,
    projectId: "operator-canary", repositoryIdentity: "C:\\fixture\\.git", transactionId: `txn_${"b".repeat(32)}`,
    baseHeadSha: "c".repeat(40), attempt: 2, replanUsed: true, coarseFingerprint: "d".repeat(64),
    fineFingerprint: "e".repeat(64), progressFact: `transaction-state-digest:${"f".repeat(64)}`, recovery: "SAFE_TO_CONTINUE", ...overrides };
  const record = { ...snapshot, hash: hash(snapshot) };
  await writeFile(join(root, "remediation", `${record.episodeId}.json`), canonicalJson(record), "utf8");
  return record;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("M12 preserved-state verifier", () => {
  it("accepts an inert state root with a hash-valid durable remediation episode", async () => {
    const f = await fixture(); await writeEpisode(f.root);
    const mod = await import(pathToFileURL(verifierPath).href);
    await expect(mod.inspectM12PreservedState(f.root, { canaryRoot: f.canaryRoot, apiKeyFile: f.apiKeyFile }))
      .resolves.toMatchObject({ status: "VERIFIED_PRESERVED", remediationRecordCount: 1, resourceResidueCount: 0 });
  });

  it("fails closed on unknown top-level state", async () => {
    const f = await fixture(); await writeFile(join(f.root, "foreign.txt"), "foreign\n", "utf8");
    const mod = await import(pathToFileURL(verifierPath).href);
    await expect(mod.inspectM12PreservedState(f.root, { canaryRoot: f.canaryRoot, apiKeyFile: f.apiKeyFile }))
      .rejects.toThrow("M12_PRESERVED_STATE_RECONCILIATION_REQUIRED");
  });

  it("fails closed while worktree, lease, or recovery residue remains", async () => {
    const mod = await import(pathToFileURL(verifierPath).href);
    for (const dir of ["worktrees", "leases", "transaction-recovery"]) {
      const f = await fixture(); await writeFile(join(f.root, dir, "foreign"), "x", "utf8");
      await expect(mod.inspectM12PreservedState(f.root, { canaryRoot: f.canaryRoot, apiKeyFile: f.apiKeyFile }))
        .rejects.toThrow("M12_PRESERVED_STATE_RECONCILIATION_REQUIRED");
    }
  });

  it("fails closed on tampered or pending-replan remediation state", async () => {
    const mod = await import(pathToFileURL(verifierPath).href);
    const tampered = await fixture(); const record = await writeEpisode(tampered.root);
    await writeFile(join(tampered.root, "remediation", `${record.episodeId}.json`), canonicalJson({ ...record, attempt: 3 }), "utf8");
    await expect(mod.inspectM12PreservedState(tampered.root, { canaryRoot: tampered.canaryRoot, apiKeyFile: tampered.apiKeyFile }))
      .rejects.toThrow("M12_PRESERVED_STATE_RECONCILIATION_REQUIRED");
    const pending = await fixture(); await writeEpisode(pending.root, { replanUsed: false });
    await expect(mod.inspectM12PreservedState(pending.root, { canaryRoot: pending.canaryRoot, apiKeyFile: pending.apiKeyFile }))
      .rejects.toThrow("M12_PRESERVED_STATE_RECONCILIATION_REQUIRED");
  });
});
