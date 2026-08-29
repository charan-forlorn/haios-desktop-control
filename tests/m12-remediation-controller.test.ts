import { mkdtemp, rm } from "node:fs/promises";
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
  return { store, controller: new RemediationController(store) };
}

describe("M12 bounded remediation controller transition matrix", () => {
  it("starts a new remediation-eligible failure at server-owned attempt one", () => {
    expect(decideRemediation(undefined, observation())).toEqual({
      directive: "RETRY_SAME_PLAN",
      attempt: 1,
      replanUsed: false,
    });
  });

  it("requires the one clean-state replan after the same coarse failure makes no objective progress", () => {
    expect(decideRemediation(episode(), observation({ fingerprint: { coarse: COARSE_A, fine: FINE_B } }))).toEqual({
      directive: "REPLAN_REQUIRED",
      attempt: 2,
      replanUsed: false,
    });
  });

  it("permits retry when a server-owned invariant changed, not merely when a fine fingerprint or prose changes", () => {
    const previous = episode({ progressFact: `CANONICAL_HEAD:${HEAD_A}` });

    expect(decideRemediation(previous, observation({
      fingerprint: { coarse: COARSE_A, fine: FINE_B },
      invariant: { name: "CANONICAL_HEAD", value: HEAD_B },
    }))).toEqual({ directive: "RETRY_SAME_PLAN", attempt: 2, replanUsed: false });

    expect(() => decideRemediation(previous, observation({
      fingerprint: { coarse: COARSE_A, fine: FINE_B },
      progressMessage: "we made progress",
    } as unknown as RemediationObservation))).toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
  });

  it("stagnates rather than using a second replan after an accepted replan", () => {
    const previous = episode({ attempt: 2, replanUsed: true });

    expect(decideRemediation(previous, observation())).toEqual({
      directive: "AUTONOMOUS_REMEDIATION_STAGNATED",
      attempt: 3,
      replanUsed: true,
    });
  });

  it("exhausts the autonomous budget on the fifth remediation-eligible failure", () => {
    expect(decideRemediation(episode({ attempt: 4 }), observation({ fingerprint: { coarse: COARSE_B, fine: FINE_B } }))).toEqual({
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

  it("accepts exactly one replan only after all clean-state preconditions are proven", async () => {
    const { controller, store } = await controllerFixture();
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
      .resolves.toMatchObject({ attempt: 1, replanUsed: true, recovery: "SAFE_TO_CONTINUE" });
    await expect(store.load("episode-001")).resolves.toMatchObject({ replanUsed: true });
    await expect(controller.acceptCleanStateReplan("episode-001", cleanStatePreconditions()))
      .rejects.toThrow("M12_REMEDIATION_CONTROLLER_DENIED");
  });
});
