import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decideRemediation,
  RemediationController,
  type CleanStateReplanPreconditions,
  type RemediationObservation,
} from "../src/operator/remediation-controller.js";
import { RemediationStore, type RemediationEpisodeRecord } from "../src/operator/remediation-store.js";

const roots: string[] = [];
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const COARSE_A = "c".repeat(64);
const COARSE_B = "d".repeat(64);
const FINE_A = "e".repeat(64);
const FINE_B = "f".repeat(64);
const rollbackCases: readonly [string, Partial<RemediationObservation>][] = [
  ["unknown authority", { authority: "UNKNOWN" }],
  ["denied authority", { authority: "DENIED" }],
  ["stale currentness", { currentness: "STALE" }],
  ["unknown currentness", { currentness: "UNKNOWN" }],
  ["active emergency", { emergency: "ACTIVE" }],
  ["unknown emergency", { emergency: "UNKNOWN" }],
  ["rollback recovery", { recovery: "SAFE_TO_ROLLBACK" }],
];
const manualCases: readonly [string, Partial<RemediationObservation>][] = [
  ["ambiguous recovery", { recovery: "MANUAL_RECONCILIATION_REQUIRED" }],
  ["authority ambiguity without rollback proof", { authority: "UNKNOWN", recovery: "SAFE_TO_CONTINUE" }],
  ["stale currentness without rollback proof", { currentness: "STALE", recovery: "SAFE_TO_CONTINUE" }],
  ["emergency ambiguity without rollback proof", { emergency: "ACTIVE", recovery: "SAFE_TO_CONTINUE" }],
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function observation(overrides: Partial<RemediationObservation> = {}): RemediationObservation {
  return {
    episodeId: "episode-001",
    projectId: "operator-canary",
    repositoryIdentity: "C:\\Workspace\\haios-operator-canary\\.git",
    transactionId: "txn-001",
    baseHeadSha: HEAD_A,
    failure: "REMEDIATION_ELIGIBLE_FAILURE",
    fingerprint: { coarse: COARSE_A, fine: FINE_A },
    invariant: { name: "CANONICAL_HEAD", value: HEAD_A },
    authority: "AUTHORIZED",
    currentness: "CURRENT",
    emergency: "NONE",
    recovery: "SAFE_TO_CONTINUE",
    ...overrides,
  };
}

function episode(overrides: Partial<RemediationEpisodeRecord> = {}): RemediationEpisodeRecord {
  return {
    schema: "HAIOS_M12_REMEDIATION_EPISODE_R1",
    episodeId: "episode-001",
    projectId: "operator-canary",
    repositoryIdentity: "C:\\Workspace\\haios-operator-canary\\.git",
    transactionId: "txn-001",
    baseHeadSha: HEAD_A,
    attempt: 1,
    replanUsed: false,
    coarseFingerprint: COARSE_A,
    fineFingerprint: FINE_A,
    progressFact: `CANONICAL_HEAD:${HEAD_A}`,
    recovery: "SAFE_TO_CONTINUE",
    hash: "1".repeat(64),
    ...overrides,
  };
}

async function verifiedEpisode(overrides: Partial<RemediationEpisodeRecord> = {}): Promise<RemediationEpisodeRecord> {
  const stateRoot = await mkdtemp(join(tmpdir(), "m12-remediation-controller-prior-"));
  roots.push(stateRoot);
  const { hash: _unverifiedHash, ...snapshot } = episode(overrides);
  return new RemediationStore(stateRoot).save(snapshot);
}

function cleanStatePreconditions(overrides: Partial<CleanStateReplanPreconditions> = {}): CleanStateReplanPreconditions {
  return {
    activeMutableCodeProcess: false,
    unresolvedTaskEffects: false,
    ownership: "UNAMBIGUOUS",
    recovery: "SAFE_TO_CONTINUE",
    ...overrides,
  };
}

async function controllerFixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "m12-remediation-controller-"));
  roots.push(stateRoot);
  const store = new RemediationStore(stateRoot);
  return { stateRoot, store, controller: new RemediationController(store) };
}

describe("M12 bounded remediation controller transition matrix", () => {
  it("starts a new remediation-eligible failure at server-owned attempt one", () => {
    expect(decideRemediation(undefined, observation())).toEqual({
      directive: "RETRY_SAME_PLAN",
      attempt: 1,
      replanUsed: false,
    });
  });

  it("requires the one clean-state replan after the same coarse failure makes no objective progress", async () => {
    expect(decideRemediation(await verifiedEpisode(), observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } }))).toEqual({
      directive: "REPLAN_REQUIRED",
      attempt: 2,
      replanUsed: false,
    });
  });

  it("permits retry when a server-owned invariant changed, not merely when a fine fingerprint or prose changes", async () => {
    const previous = await verifiedEpisode({ progressFact: `CANONICAL_HEAD:${HEAD_A}` });

    expect(decideRemediation(previous, observation({
      fingerprint: { coarse: COARSE_A, fine: FINE_B },
      invariant: { name: "CANONICAL_HEAD", value: HEAD_B },
    }))).toEqual({ directive: "RETRY_SAME_PLAN", attempt: 2, replanUsed: false });

    expect(() => decideRemediation(previous, observation({
      fingerprint: { coarse: COARSE_A, fine: FINE_B },
      progressMessage: "we made progress",
    } as unknown as RemediationObservation))).toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
  });

  it("stagnates rather than using a second replan after an accepted replan", async () => {
    const previous = await verifiedEpisode({ attempt: 2, replanUsed: true });

    expect(decideRemediation(previous, observation())).toEqual({
      directive: "AUTONOMOUS_REMEDIATION_STAGNATED",
      attempt: 3,
      replanUsed: true,
    });
  });

  it("exhausts the autonomous budget on the fifth remediation-eligible failure", async () => {
    expect(decideRemediation(await verifiedEpisode({ attempt: 4 }), observation({ fingerprint: { coarse: COARSE_B, fine: FINE_B } }))).toEqual({
      directive: "AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED",
      attempt: 5,
      replanUsed: false,
    });
  });

  it.each(rollbackCases)("maps %s to rollback rather than autonomous retry when rollback is proven safe", (_name, overrides) => {
    expect(decideRemediation(undefined, observation({ recovery: "SAFE_TO_ROLLBACK", ...overrides }))).toEqual({
      directive: "ROLLBACK_REQUIRED",
      attempt: 1,
      replanUsed: false,
    });
  });

  it.each(manualCases)("maps %s to manual reconciliation rather than autonomous retry", (_name, overrides) => {
    expect(decideRemediation(undefined, observation(overrides))).toEqual({
      directive: "MANUAL_RECONCILIATION_REQUIRED",
      attempt: 1,
      replanUsed: false,
    });
  });

  it("derives attempts and stored fingerprints from authoritative state rather than caller counters", () => {
    const unsafe = {
      ...observation(),
      attempt: 5,
      replanUsed: true,
      coarseFingerprint: "0".repeat(64),
      fineFingerprint: "0".repeat(64),
    };

    expect(() => decideRemediation(undefined, unsafe as unknown as RemediationObservation))
      .toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
  });

  it("rejects a fabricated hash-shaped prior record while accepting a store-verified record", async () => {
    const verified = await verifiedEpisode();
    const fabricated = { ...verified };

    expect(() => decideRemediation(fabricated, observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } })))
      .toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
    expect(decideRemediation(verified, observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } })))
      .toMatchObject({ directive: "REPLAN_REQUIRED", attempt: 2 });
  });

  it("records only a durably saved remediation-eligible failure and retains the server decision", async () => {
    const { controller, store } = await controllerFixture();

    await expect(controller.record(observation())).resolves.toEqual({
      directive: "RETRY_SAME_PLAN",
      attempt: 1,
      replanUsed: false,
    });
    await expect(store.load("episode-001")).resolves.toMatchObject({
      attempt: 1,
      replanUsed: false,
      coarseFingerprint: COARSE_A,
      fineFingerprint: FINE_A,
    });

    await expect(controller.record(observation({ failure: "NOT_A_FAILURE" }))).resolves.toEqual({
      directive: "PASS",
      attempt: 1,
      replanUsed: false,
    });
    await expect(store.load("episode-001")).resolves.toMatchObject({ attempt: 1 });
  });

  it("does not spend remediation budget or persist non-remediable failures", async () => {
    const { controller, store } = await controllerFixture();
    await expect(controller.record(observation({ failure: "NON_REMEDIABLE_FAILURE" }))).resolves.toEqual({
      directive: "MANUAL_RECONCILIATION_REQUIRED", attempt: 1, replanUsed: false,
    });
    await expect(store.load("episode-001")).resolves.toBeUndefined();
    await expect(controller.record(observation({ failure: "NON_REMEDIABLE_FAILURE" }))).resolves.toEqual({
      directive: "MANUAL_RECONCILIATION_REQUIRED", attempt: 1, replanUsed: false,
    });
    await expect(store.load("episode-001")).resolves.toBeUndefined();
  });

  it("does not persist safety-denied eligible failures but still persists safe budget terminals", async () => {
    const { controller, store } = await controllerFixture();
    await controller.record(observation());

    await expect(controller.record(observation({
      fingerprint: { coarse: COARSE_A, fine: FINE_B },
      authority: "UNKNOWN",
    }))).resolves.toEqual({ directive: "MANUAL_RECONCILIATION_REQUIRED", attempt: 1, replanUsed: false });
    await expect(store.load("episode-001")).resolves.toMatchObject({
      attempt: 1,
      fineFingerprint: FINE_A,
      recovery: "SAFE_TO_CONTINUE",
    });

    const { hash: _unverifiedHash, ...attemptFive } = episode({ attempt: 5 });
    await store.save({ ...attemptFive, fineFingerprint: FINE_A });
    await expect(controller.record(observation({ fingerprint: { coarse: COARSE_B, fine: FINE_B } })))
      .resolves.toEqual({ directive: "AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED", attempt: 5, replanUsed: false });
    await expect(store.load("episode-001")).resolves.toMatchObject({ attempt: 5, fineFingerprint: FINE_B });
  });

  it("accepts one replan only after the durable second same-coarse transition proof survives reload", async () => {
    const { stateRoot, controller, store } = await controllerFixture();
    await controller.record(observation());

    for (const preconditions of [
      cleanStatePreconditions({ activeMutableCodeProcess: true }),
      cleanStatePreconditions({ unresolvedTaskEffects: true }),
      cleanStatePreconditions({ ownership: "AMBIGUOUS" }),
      cleanStatePreconditions({ recovery: "SAFE_TO_ROLLBACK" }),
      cleanStatePreconditions({ recovery: "MANUAL_RECONCILIATION_REQUIRED" }),
    ]) {
      await expect(controller.acceptCleanStateReplan("episode-001", preconditions))
        .rejects.toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
    }

    await expect(controller.acceptCleanStateReplan("episode-001", cleanStatePreconditions()))
      .rejects.toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
    await expect(controller.record(observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } })))
      .resolves.toEqual({ directive: "REPLAN_REQUIRED", attempt: 2, replanUsed: false });

    const reloaded = new RemediationController(new RemediationStore(stateRoot));
    await expect(reloaded.acceptCleanStateReplan("episode-001", cleanStatePreconditions()))
      .resolves.toMatchObject({ attempt: 2, replanUsed: true, recovery: "SAFE_TO_CONTINUE" });
    await expect(store.load("episode-001")).resolves.toMatchObject({ replanUsed: true });
    await expect(reloaded.acceptCleanStateReplan("episode-001", cleanStatePreconditions()))
      .rejects.toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
  });

  it("fails closed when the required REPLAN_REQUIRED attempt-two lineage is externally deleted", async () => {
    const { stateRoot, controller } = await controllerFixture();
    await controller.record(observation());
    await expect(controller.record(observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } })))
      .resolves.toEqual({ directive: "REPLAN_REQUIRED", attempt: 2, replanUsed: false });

    await unlink(join(stateRoot, "remediation", "episode-001.transition-lineage.json"));

    await expect(new RemediationStore(stateRoot).load("episode-001"))
      .rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
    await expect(new RemediationController(new RemediationStore(stateRoot)).record(observation({
      fingerprint: { coarse: COARSE_B, fine: FINE_B },
    }))).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
  });

  it("persists RETRY_SAME_PLAN lineage for a normal different-coarse attempt-two transition and fails closed if deleted", async () => {
    const { stateRoot, controller } = await controllerFixture();
    await controller.record(observation());
    await expect(controller.record(observation({ fingerprint: { coarse: COARSE_B, fine: FINE_B } })))
      .resolves.toEqual({ directive: "RETRY_SAME_PLAN", attempt: 2, replanUsed: false });

    const lineagePath = join(stateRoot, "remediation", "episode-001.transition-lineage.json");
    await expect(readFile(lineagePath, "utf8")).resolves.toContain('"directive":"RETRY_SAME_PLAN"');
    await expect(new RemediationStore(stateRoot).load("episode-001")).resolves.toMatchObject({ attempt: 2, replanUsed: false });

    await unlink(lineagePath);
    await expect(new RemediationStore(stateRoot).load("episode-001"))
      .rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
  });
  it("does not mutate a pending durable replan on safety denial and revokes same-process acceptance", async () => {
    const { controller, store } = await controllerFixture();
    await controller.record(observation());
    await expect(controller.record(observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } })))
      .resolves.toEqual({ directive: "REPLAN_REQUIRED", attempt: 2, replanUsed: false });

    await expect(controller.record(observation({
      authority: "UNKNOWN",
      fingerprint: { coarse: COARSE_A, fine: FINE_A },
    }))).resolves.toEqual({ directive: "MANUAL_RECONCILIATION_REQUIRED", attempt: 2, replanUsed: false });
    await expect(store.load("episode-001")).resolves.toMatchObject({ attempt: 2, fineFingerprint: FINE_B });
    await expect(controller.acceptCleanStateReplan("episode-001", cleanStatePreconditions()))
      .rejects.toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
  });

});
