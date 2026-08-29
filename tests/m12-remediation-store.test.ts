import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RemediationStore,
  type RemediationEpisodeSnapshot,
} from "../src/operator/remediation-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "m12-remediation-store-"));
  roots.push(stateRoot);
  return {
    stateRoot,
    store: new RemediationStore(stateRoot),
    episodeId: "episode-001",
  };
}

function snapshot(episodeId = "episode-001", attempt = 1): RemediationEpisodeSnapshot {
  return {
    schema: "HAIOS_M12_REMEDIATION_EPISODE_R1",
    episodeId,
    projectId: "operator-canary",
    repositoryIdentity: "C:\\Workspace\\haios-operator-canary\\.git",
    transactionId: "txn-001",
    baseHeadSha: "a".repeat(40),
    attempt,
    replanUsed: false,
    coarseFingerprint: "b".repeat(64),
    fineFingerprint: "c".repeat(64),
    progressFact: "CANONICAL_HEAD_UNCHANGED",
    recovery: "SAFE_TO_CONTINUE",
  };
}

describe("M12 durable remediation episode store", () => {
  it("atomically persists a canonical, hash-verified episode record", async () => {
    const { stateRoot, store, episodeId } = await fixture();

    const saved = await store.save(snapshot(episodeId));
    const recordPath = join(stateRoot, "remediation", `${episodeId}.json`);

    expect(await store.load(episodeId)).toEqual(saved);
    expect(saved.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(saved);
    expect(await readdir(join(stateRoot, "remediation"))).toEqual([`${episodeId}.json`]);
  });

  it("computes the same hash for equivalent snapshots with different property insertion order", async () => {
    const { store, episodeId } = await fixture();
    const source = snapshot(episodeId);
    const reordered: RemediationEpisodeSnapshot = {
      recovery: source.recovery,
      progressFact: source.progressFact,
      fineFingerprint: source.fineFingerprint,
      coarseFingerprint: source.coarseFingerprint,
      replanUsed: source.replanUsed,
      attempt: source.attempt,
      baseHeadSha: source.baseHeadSha,
      transactionId: source.transactionId,
      repositoryIdentity: source.repositoryIdentity,
      projectId: source.projectId,
      episodeId: source.episodeId,
      schema: source.schema,
    };

    const first = await store.save(source);
    const second = await store.save(reordered);

    expect(second.hash).toBe(first.hash);
    expect(await store.load(episodeId)).toEqual(second);
  });

  it("does not silently reset a corrupt episode attempt", async () => {
    const { stateRoot, store, episodeId } = await fixture();
    await store.save(snapshot(episodeId, 3));
    const recordPath = join(stateRoot, "remediation", `${episodeId}.json`);
    await writeFile(recordPath, "{corrupt", "utf8");

    await expect(store.load(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(store.save(snapshot(episodeId, 1))).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(readFile(recordPath, "utf8")).resolves.toBe("{corrupt");
  });

  it("requires reconciliation when filename and hash-valid content episode IDs differ", async () => {
    const { stateRoot, store, episodeId } = await fixture();
    const sourceRoot = await mkdtemp(join(tmpdir(), "m12-remediation-store-source-"));
    roots.push(sourceRoot);
    const sourceStore = new RemediationStore(sourceRoot);
    const other = await sourceStore.save(snapshot("episode-002"));
    const recordPath = join(stateRoot, "remediation", `${episodeId}.json`);
    await mkdir(join(stateRoot, "remediation"), { recursive: true });
    await writeFile(recordPath, JSON.stringify(other), "utf8");

    await expect(store.load(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(store.save(snapshot(episodeId, 2))).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(readFile(recordPath, "utf8")).resolves.toBe(JSON.stringify(other));
  });

  it("preserves corrupt state when remove is requested", async () => {
    const { stateRoot, store, episodeId } = await fixture();
    await store.save(snapshot(episodeId, 3));
    const recordPath = join(stateRoot, "remediation", `${episodeId}.json`);
    await writeFile(recordPath, "{corrupt", "utf8");

    await expect(store.remove(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(readFile(recordPath, "utf8")).resolves.toBe("{corrupt");
  });

  it("rejects attempt/replan regressions, stable-identity changes, and stale supplied hashes", async () => {
    const { store, episodeId } = await fixture();
    const existing = await store.save({ ...snapshot(episodeId, 2), replanUsed: true });

    await expect(store.save(snapshot(episodeId, 1))).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    await expect(store.save({ ...snapshot(episodeId, 2), replanUsed: false })).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    await expect(store.save({ ...snapshot(episodeId, 3), transactionId: "txn-other" })).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    await expect(store.save({ ...existing, attempt: 3 })).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    await expect(store.load(episodeId)).resolves.toEqual(existing);
  });

  it("rejects Windows-unsafe and non-canonical episode IDs", async () => {
    const { store } = await fixture();

    for (const episodeId of ["Episode-001", "episode:001", "episode.", "con", "con.txt", "com1", "lpt9", "nul", "episode/001"]) {
      await expect(store.save(snapshot(episodeId))).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    }
  });

  it("fails closed on interrupted-operation residue and preserves a replacement record", async () => {
    const { stateRoot, store, episodeId } = await fixture();
    const sourceRoot = await mkdtemp(join(tmpdir(), "m12-remediation-store-replacement-"));
    roots.push(sourceRoot);
    const replacement = await new RemediationStore(sourceRoot).save(snapshot(episodeId, 2));
    const remediationDirectory = join(stateRoot, "remediation");
    await mkdir(remediationDirectory, { recursive: true });
    const recordPath = join(remediationDirectory, `${episodeId}.json`);
    await writeFile(recordPath, JSON.stringify(replacement), "utf8");
    await writeFile(join(remediationDirectory, ".m12-interrupted-operation"), "interrupted", "utf8");

    await expect(store.load(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(store.save(snapshot(episodeId, 3))).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(store.remove(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(readFile(recordPath, "utf8")).resolves.toBe(JSON.stringify(replacement));
  });

  it("serializes competing updates so a lower attempt cannot become the durable result", async () => {
    const { store, episodeId } = await fixture();
    await store.save(snapshot(episodeId, 1));

    await Promise.allSettled([
      store.save(snapshot(episodeId, 3)),
      store.save(snapshot(episodeId, 2)),
    ]);

    await expect(store.load(episodeId)).resolves.toMatchObject({ attempt: 3, replanUsed: false });
  });

  it.each([
    ["hash mismatch", (record: Record<string, unknown>) => ({ ...record, hash: "0".repeat(64) })],
    ["unknown schema", (record: Record<string, unknown>) => ({ ...record, schema: "HAIOS_M12_REMEDIATION_EPISODE_R2" })],
    ["partial file", () => ({ schema: "HAIOS_M12_REMEDIATION_EPISODE_R1", episodeId: "episode-001" })],
  ])("requires reconciliation for %s", async (_name, corrupt) => {
    const { stateRoot, store, episodeId } = await fixture();
    const saved = await store.save(snapshot(episodeId));
    const recordPath = join(stateRoot, "remediation", `${episodeId}.json`);
    await writeFile(recordPath, JSON.stringify(corrupt(saved as unknown as Record<string, unknown>)), "utf8");

    await expect(store.load(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
  });

  it("rejects traversal episode identifiers before filesystem access", async () => {
    const { store } = await fixture();

    await expect(store.load("../escape")).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    await expect(store.remove("..\\escape")).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    await expect(store.save(snapshot("..\\escape"))).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
  });

  it("rejects raw output and secret-like fields without accepting them into durable state", async () => {
    const { store } = await fixture();

    for (const forbiddenField of ["stdout", "stderr", "apiKey", "accessToken", "password", "secret"]) {
      await expect(store.save({ ...snapshot(), [forbiddenField]: "sensitive-value" }))
        .rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    }
  });

  it("rejects accessor-backed snapshots without invoking their getter", async () => {
    const { store } = await fixture();
    let getterCalls = 0;
    const unsafe = { ...snapshot() } as Record<string, unknown>;
    Object.defineProperty(unsafe, "progressFact", {
      enumerable: true,
      get: () => { getterCalls += 1; return "CANONICAL_HEAD_UNCHANGED"; },
    });

    await expect(store.save(unsafe as unknown as RemediationEpisodeSnapshot)).rejects.toThrow("M12_REMEDIATION_STATE_DENIED");
    expect(getterCalls).toBe(0);
  });

  it("rejects a remediation directory reparse point that escapes the state root", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "m12-remediation-store-link-"));
    const outside = await mkdtemp(join(tmpdir(), "m12-remediation-store-outside-"));
    roots.push(stateRoot, outside);
    await symlink(outside, join(stateRoot, "remediation"), "junction");
    const store = new RemediationStore(stateRoot);

    await expect(store.save(snapshot())).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("removes only a validated episode record and returns absent records as undefined", async () => {
    const { stateRoot, store, episodeId } = await fixture();
    await expect(store.load(episodeId)).resolves.toBeUndefined();
    await store.save(snapshot(episodeId));
    await store.remove(episodeId);

    await expect(store.load(episodeId)).resolves.toBeUndefined();
    await expect(readFile(join(stateRoot, "remediation", `${episodeId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
