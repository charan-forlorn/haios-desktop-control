# M12 B5 Canary Stability Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Level-B B5 canary semantics by adding deterministic dual failure fingerprints, bounded autonomous remediation, durable episode state, ownership-aware lock/recovery, five-pattern live canary qualification, and recovery-first M11→M12 activation without expanding project or external authority.

**Architecture:** Keep the exact public `operator13` 13-tool surface unchanged. Add server-owned internal policy modules beside the existing M06/M07 transaction/task stack, then wrap the qualified runtime with an M12-only canary stability coordinator; production remains M11 until a separate exact Human activation decision.

**Tech Stack:** TypeScript, Node.js 24, Vitest, MCP SDK, Git, PowerShell 7, Windows Scheduled Tasks, Docker-based M07 S0/S1 sandbox.

**Spec:** `docs/superpowers/specs/2026-08-29-m12-b5-canary-stability-closure-design.md`

## Global Constraints

- Parent certified runtime is M11 HEAD `1c32ba789ce89872b36bfed5f7a527b917072d6b`, manifest `ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a`.
- M12 admits only `operator-canary -> C:\Workspace\haios-operator-canary`.
- Production activation scope is exactly `M12_B5_CANARY_STABILITY_ONLY`; alternate strings fail closed.
- Public surface remains exactly 13 Operator tools; no new public remediation or recovery tool.
- Maximum remediation-attempt budget is 5 with exactly one clean-state replan.
- S2 remains disabled; generic shell/exec remain false; DESTRUCTIVE remains `LOCKED`.
- No remote Git mutation, dependency download, cloud/deployment/credential/tunnel mutation, or arbitrary project admission.
- Live M11 remains authoritative until exact M12 Human activation authority is separately supplied.

---

### Task 1: Deterministic Dual Failure Fingerprints

**Files:**
- Create: `src/operator/remediation-fingerprint.ts`
- Create: `tests/m12-remediation-fingerprint.test.ts`

**Interfaces:**
- Consumes: `OperatorTaskRunResult` from `src/operator/task-runner.ts` plus sanitized transaction/currentness facts.
- Produces: `FailureFingerprintInput`, `FailureFingerprint`, and `computeFailureFingerprint(input)`.

- [ ] **Step 1: Write failing fingerprint tests**

```ts
expect(computeFailureFingerprint({ reason: "TASK_SANDBOX_FAILED", exitCode: 1, taskId: "project.test", effectClass: "NONE", currentness: "CURRENT" })).toEqual({
  coarse: expect.stringMatching(/^[a-f0-9]{64}$/),
  fine: expect.stringMatching(/^[a-f0-9]{64}$/),
});
expect(a.coarse).toBe(b.coarse);
expect(a.fine).not.toBe(b.fine);
```

Also prove raw stdout/stderr, absolute worktree paths, timestamps, tx IDs, PIDs, and regenerated resource IDs are rejected from the input type/normalizer.

- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-remediation-fingerprint.test.ts`
Expected: FAIL because `remediation-fingerprint.ts` does not exist.

- [ ] **Step 3: Implement canonical hashing**
Use stable sorted JSON and SHA-256. Coarse input is only `{reason, taskId, effectClass, currentness, sandboxClass}`; fine additionally includes bounded diagnostic fields `{exitCode, sandboxReason, timedOut, effectSummary}`.

- [ ] **Step 4: Run GREEN and commit**
Run the focused test, then `git add src/operator/remediation-fingerprint.ts tests/m12-remediation-fingerprint.test.ts && git commit -m "feat: add deterministic remediation fingerprints"`.
### Task 2: Durable Remediation Episode Store

**Files:**
- Create: `src/operator/remediation-store.ts`
- Create: `tests/m12-remediation-store.test.ts`

**Interfaces:**
- Consumes: state root path and normalized episode snapshots.
- Produces: `RemediationEpisodeRecord`, `RemediationStore.load(id)`, `save(record)`, `remove(id)`.

- [ ] **Step 1: Write failing persistence/currentness tests**

```ts
const saved = await store.save({ schema: "HAIOS_M12_REMEDIATION_EPISODE_R1", episodeId, projectId, repositoryIdentity, transactionId, baseHeadSha, attempt: 1, replanUsed: false, coarseFingerprint, fineFingerprint, progressFact, recovery: "SAFE_TO_CONTINUE" });
expect(await store.load(episodeId)).toEqual(saved);
await writeFile(recordPath, "{corrupt", "utf8");
await expect(store.load(episodeId)).rejects.toThrow("M12_REMEDIATION_STATE_RECONCILIATION_REQUIRED");
```

Test hash mismatch, unknown schema, partial file, path traversal in episode ID, raw stdout/stderr fields, and secret-like key names. Assert no corrupt state silently resets attempt to zero.

- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-remediation-store.test.ts`
Expected: FAIL for missing module.

- [ ] **Step 3: Implement atomic file-backed state**
Persist under `<stateRoot>\remediation\<episodeId>.json`; write a same-directory temporary file, `open`/write/sync/close, then rename atomically. Store a SHA-256 over canonical payload excluding the hash field.

- [ ] **Step 4: Run GREEN and commit**
Run focused test; commit only the store and its tests with `feat: add durable remediation episode store`.

### Task 3: Bounded Remediation State Machine

**Files:**
- Create: `src/operator/remediation-controller.ts`
- Create: `tests/m12-remediation-controller.test.ts`

**Interfaces:**
- Consumes: `FailureFingerprint`, durable `RemediationEpisodeRecord`, and server-owned `RemediationObservation`.
- Produces: `RemediationDirective = "RETRY_SAME_PLAN" | "REPLAN_REQUIRED" | "ROLLBACK_REQUIRED" | "MANUAL_RECONCILIATION_REQUIRED" | "AUTONOMOUS_REMEDIATION_STAGNATED" | "AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED" | "PASS"`.
- Public implementation signatures: `decideRemediation(previous: RemediationEpisodeRecord | undefined, observation: RemediationObservation): RemediationDecision`, `RemediationController.record(observation): Promise<RemediationDecision>`, and `RemediationController.acceptCleanStateReplan(episodeId, preconditions): Promise<RemediationEpisodeRecord>`.

- [ ] **Step 1: Write failing transition matrix tests**

```ts
expect(decideRemediation(undefined, freshFailure)).toMatchObject({ directive: "RETRY_SAME_PLAN", attempt: 1, replanUsed: false });
expect(decideRemediation(previousAttempt, sameCoarseNoProgress)).toMatchObject({ directive: "REPLAN_REQUIRED", attempt: 2, replanUsed: false });
expect(decideRemediation(afterAcceptedReplan, sameCoarseAfterReplan)).toMatchObject({ directive: "AUTONOMOUS_REMEDIATION_STAGNATED", replanUsed: true });
expect(decideRemediation(attemptFour, attemptFiveFailure)).toMatchObject({ directive: "AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED", attempt: 5 });
```

Add cases proving objective progress requires a changed server-owned invariant, exactly one replan is allowed, authority/currentness/emergency failures map to rollback/manual reconciliation rather than retry, and caller-supplied counters/fingerprints are ignored or rejected.

- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-remediation-controller.test.ts`
Expected: FAIL for missing controller.

- [ ] **Step 3: Implement pure transition function plus store orchestration**
Export the exact signatures above. `record()` increments `attempt` only after a remediation-eligible failure is durably recorded. `acceptCleanStateReplan()` sets `replanUsed=true` only after preconditions prove no active mutable-code process, no unresolved task effects, no ambiguous ownership, and recovery state `SAFE_TO_CONTINUE`; a second call fails closed.

- [ ] **Step 4: Run GREEN and commit**
Run focused tests plus Tasks 1-2 tests; commit with `feat: add bounded remediation state machine`.

### Task 4: Ownership-Aware Lease and Crash-Recovery Classification

**Files:**
- Create: `src/operator/recovery-lease.ts`
- Create: `src/operator/recovery-classifier.ts`
- Create: `tests/m12-recovery-lease.test.ts`
- Create: `tests/m12-recovery-classifier.test.ts`

**Interfaces:**
- Produces `RecoveryLeaseRecord`, `RecoveryLeaseManager.acquire/heartbeat/release/inspect`, and `classifyRecovery(input): "SAFE_TO_CONTINUE" | "SAFE_TO_ROLLBACK" | "MANUAL_RECONCILIATION_REQUIRED"`.
- Repository identity is the canonical Git common-dir identity already used by `OperatorTransactionService`.

- [ ] **Step 1: Write RED tests for ownership proof**
Test exact project/repository/transaction identity, PID plus process-start anti-reuse evidence, lease expiry, dead owner, live owner, unknown schema, mismatched repo, and foreign `.git/*.lock` preservation.

```ts
expect(classifyRecovery(exactDeadOwnerCleanTx)).toBe("SAFE_TO_ROLLBACK");
expect(classifyRecovery(liveOwner)).toBe("SAFE_TO_CONTINUE");
expect(classifyRecovery(foreignLock)).toBe("MANUAL_RECONCILIATION_REQUIRED");
```
- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-recovery-lease.test.ts tests/m12-recovery-classifier.test.ts`
Expected: FAIL for missing modules.

- [ ] **Step 3: Implement lease + classifier**
Lease files live only under `<stateRoot>\leases`; creation is exclusive, heartbeat rewrites only the exact owned lease, and cleanup requires exact identity + dead owner + no active lease. Never delete arbitrary Git lock files; return reconciliation-required instead.

- [ ] **Step 4: Run GREEN and commit**
Run focused tests and commit with `feat: add ownership-aware recovery leases`.

### Task 5: Integrate Durable Recovery With Transaction Lifecycle

**Files:**
- Modify: `src/operator/transaction-isolation.ts`
- Modify: `src/operator/qualified-control-runtime.ts`
- Create: `tests/m12-transaction-recovery.test.ts`
- Modify: `tests/m06-transaction-isolation.test.ts`

**Interfaces:**
- Extend `OperatorTransactionServiceConfig` with `readonly recovery?: OperatorTransactionRecoveryCoordinator`; extend `QualifiedOperatorControlRuntimeConfig` with the same optional field and pass it through only to the transaction service. M06-M11 callers keep legacy behavior when absent.
- `OperatorTransactionRecoveryCoordinator` exposes `onBegin(record, repositoryIdentity)`, `onTerminal(record)`, `recoverOwnedTransaction(record)`, and `collectOwnedResidue()`; do not add public Operator tools.

- [ ] **Step 1: Write compatibility + recovery RED tests**
Prove existing M06 constructor still works unchanged. Under M12 coordinator, begin acquires a lease after repository identity is proven; rollback/promotion release only owned leases; interrupted owned transaction can classify and clean; unknown/foreign residue returns reconciliation-required and remains untouched.

- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m06-transaction-isolation.test.ts tests/m12-transaction-recovery.test.ts`
Expected: new M12 recovery assertions fail while all pre-existing M06 assertions remain green.

- [ ] **Step 3: Implement minimal integration**
Keep staging/apply/checkpoint/CAS code unchanged except for lifecycle hooks around begin, promotion, rollback, and cleanup. Recovery must re-check canonical HEAD/status/common-dir before any owned worktree removal.

- [ ] **Step 4: Run GREEN and commit**
Run M06/M12 focused suites; commit with `feat: bind transaction lifecycle to m12 recovery ownership`.
### Task 6: M12 Stability Coordinator Without Public-Surface Expansion

**Files:**
- Create: `src/operator/m12-stability-coordinator.ts`
- Create: `tests/m12-stability-coordinator.test.ts`

**Interfaces:**
- Consumes existing `OperatorTaskRunResult`, transaction status/currentness, `RemediationController`, and recovery classifier.
- Produces `M12StabilityCoordinator.observeTaskResult(...)`, `recoverStartup()`, and `createM12StabilityTaskApi(baseTasks, coordinator)`. The wrapper returns the original task result plus a sanitized `stability` object; no new MCP tool is added.

- [ ] **Step 1: Write RED orchestration tests**
Use synthetic DENY task results to prove eligible failures are fingerprinted and persisted, protected/currentness/cleanup-uncertain failures never enter retry, successful verified task results terminate the episode with `PASS`, and no model-generated command/string is accepted.

```ts
expect(await coordinator.observeTaskResult(eligibleFailure)).toMatchObject({ directive: "RETRY_SAME_PLAN" });
expect(await coordinator.observeTaskResult(protectedFailure)).toMatchObject({ directive: "ROLLBACK_REQUIRED" });
expect(await coordinator.observeTaskResult(cleanSuccess)).toMatchObject({ directive: "PASS" });
```

- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-stability-coordinator.test.ts`
Expected: FAIL for missing coordinator.

- [ ] **Step 3: Implement coordinator and M12-only task facade**
`createM12StabilityTaskApi()` calls `baseTasks.run(request)`, passes the sanitized result to the coordinator, and returns `Object.freeze({ ...result, stability })`, where `stability` contains only directive, attempt, replan-used, coarse/fine fingerprints, progress classification, and recovery classification. Do not modify `createQualifiedOperatorControlRuntime`, `OPERATOR_V1_TOOL_NAMES`, or MCP input schemas for this task.

- [ ] **Step 4: Run GREEN + public-surface regression and commit**
Run: `npm test -- --run tests/m12-stability-coordinator.test.ts tests/m08-operator-runtime.test.ts tests/m11-active-canary-runtime.test.ts tests/m05-operator-protocol.test.ts`
Commit with `feat: coordinate m12 remediation without surface expansion`.

### Task 7: Exact M12 Production/Disposable Runtime Contract

**Files:**
- Create: `src/operator/m12-active-canary-config.ts`
- Create: `src/operator/m12-active-canary-runtime.ts`
- Create: `scripts/run-m12-active-canary-runtime.mjs`
- Create: `scripts/run-m12-active-canary-supervisor.mjs`
- Create: `tests/m12-active-canary-config.test.ts`
- Create: `tests/m12-active-canary-runtime.test.ts`
**Interfaces:**
- Production config accepts only `apiKeyFile`, `worktreeRoot`, `stateRoot`, exact `allowedProjects`, port `8769`, mode `ACTIVE`, and activationScope `M12_B5_CANARY_STABILITY_ONLY`.
- Readiness metadata remains exact 13 tools and includes `remediationBudget=5`, `cleanStateReplanLimit=1`, and no secret/state paths.

- [ ] **Step 1: Write config/runtime RED tests**
Reject extra/missing/inherited/accessor fields, alternate project/root, inline key, alternate live port, alternate activation scope, stateRoot outside `%LOCALAPPDATA%\HAIOS\M12`, S2/generic-exec/shell authority, and multi-project admission.

```ts
expect(createM12ReadinessMetadata(valid)).toMatchObject({
  mode: "ACTIVE", activationScope: "M12_B5_CANARY_STABILITY_ONLY",
  projectIds: ["operator-canary"], s2Enabled: false, genericExec: false,
  genericShell: false, destructive: "LOCKED", remediationBudget: 5,
});
```

- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-active-canary-config.test.ts tests/m12-active-canary-runtime.test.ts`
Expected: FAIL for missing M12 runtime/config.

- [ ] **Step 3: Implement by composing qualified M08/M06/M07 runtime + M12 coordinator**
Construct the M12 recovery coordinator from `stateRoot`, pass it through the optional qualified-runtime recovery seam from Task 5, wrap the returned base task API with `createM12StabilityTaskApi()`, and build a new Operator runtime from the same transactions/registry/effects plus the wrapped task API. Reuse M11 no-authority upstream and file-backed API-key semantics without broadening them. Launcher accepts exactly one config path and binds only `127.0.0.1`.

- [ ] **Step 4: Run GREEN + M09/M10/M11 compatibility and commit**
Run M12 tests plus `tests/m09-host-runtime-config.test.ts`, `tests/m10-production-config.test.ts`, `tests/m11-active-canary-runtime.test.ts`; commit `feat: add exact m12 canary stability runtime`.

### Task 8: Disposable Five-Pattern B5 Qualification Harness

**Files:**
- Create: `scripts/qualify-m12-disposable-b5.mjs`
- Create: `tests/m12-disposable-b5.test.ts`

**Interfaces:**
- Uses a disposable Git canonical repo and high port only.
- Produces `m12-disposable-b5-result.json` with five named pattern results and zero-residue facts.

- [ ] **Step 1: Write RED static/contract tests for all five patterns**
Require result keys `benignRollback`, `correctionPromotion`, `staleCas`, `autonomousRemediation`, `lockEffectRecovery`, each with `passed=true`, plus exact tool surface, no authority expansion, and residue counters all zero.
- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-disposable-b5.test.ts`
Expected: FAIL because the harness does not exist.

- [ ] **Step 3: Implement five patterns with deterministic fixtures**
1. Benign rollback: begin/stage then rollback with canonical unchanged.
2. Correction promotion: apply deterministic patch, run `project.test`, checkpoint, expected-HEAD/CAS promote.
3. Stale CAS: create two transactions from one base; promote A, deny B with `STALE_CANONICAL_HEAD`, then rollback B and prove no B mutation.
4. Autonomous remediation: first deterministic test patch intentionally fails, result enters remediation episode, coordinator emits retry/replan semantics, second bounded predeclared correction patch passes; no command generation or authority widening.
5. Lock/effect/recovery: create an M12-owned lease, inject allowed artifact effect, simulate owner death, classify cleanup, preserve a foreign lock fixture, rollback and prove exact residue zero.

- [ ] **Step 4: Run GREEN twice for determinism and commit**
Run harness twice on separate run IDs/ports; compare normalized result schemas and required booleans. Run focused Vitest contract; commit `test: qualify disposable m12 b5 stability matrix`.

### Task 9: M12 Activation/Automatic Rollback Transaction Package

**Files:**
- Create: `scripts/preflight-m12-b5-activation.ps1`
- Create: `scripts/execute-m12-b5-activation.ps1`
- Create: `scripts/rollback-m12-b5-to-m11.ps1`
- Create: `scripts/probe-m12-b5-host.mjs`
- Create: `tests/m12-activation-transaction.test.ts`

**Interfaces:**
- Preflight is observational and emits a decision envelope bound to exact M12 candidate HEAD/manifest, M11 final certification hash, live M11 task/action, canary HEAD/cleanliness, API-key hash, stable tunnel identity, listener `8768/8769`, executor hash, and rollback hash.
- Execute requires exact Human decision `APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION`.
- Rollback restores exact certified M11 runtime before non-critical M12 cleanup.

- [ ] **Step 1: Write RED transaction tests**
Assert every authority/currentness check occurs before `M12_MUTATION_BEGIN`, tunnel digest excludes volatile health fields, bounded native readiness probes temporarily disable `$PSNativeCommandUseErrorActionPreference`, and any failure after mutation invokes rollback.
- [ ] **Step 2: Run RED**
Run: `npm test -- --run tests/m12-activation-transaction.test.ts`
Expected: FAIL for missing scripts/probe.

- [ ] **Step 3: Implement sealed recovery-first transaction scripts**
Reuse the M11 stable-container-digest pattern and bounded retry pattern already proven in `scripts/preflight-m11-active-canary.ps1`, `execute-m11-active-canary.ps1`, and `rollback-m11-active-canary.ps1`. Do not copy historical raw `docker inspect` hashing or terminating retry behavior.

- [ ] **Step 4: Run GREEN + PowerShell parser and commit**
Run focused test and parse all three PowerShell files under PowerShell 7. Commit `feat: prepare sealed m12 activation rollback transaction`.

### Task 10: Freeze Candidate, Full Regression, Pre-Live Qualification, and Review Handoff

**Files:**
- Create: `scripts/qualify-m12-prelive.ps1`
- Create: `tests/m12-qualification-contract.test.ts`
- Evidence only: `evidence/m12/<RUN_ID>/...`

**Interfaces:**
- Produces deterministic source manifest, disposable B5 result binding, activation static proof, M11-preservation proof, secret scan, and independent-review handoff.
- Pre-live terminal is exactly `HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_READY_FOR_EXACT_HUMAN_ACTIVATION_DECISION`.

- [ ] **Step 1: Add RED qualification-contract tests**
Assert qualification requires Tasks 1-9 focused suites, disposable five-pattern PASS, exact parent M11 cert/hash, S2/generic/destructive denials, zero real-canary mutation, and exact pre-live terminal.

- [ ] **Step 2: Run focused qualification RED then implement script**
Run: `npm test -- --run tests/m12-qualification-contract.test.ts`; implement only deterministic evidence generation and checks—no production mutation.

- [ ] **Step 3: Freeze source bytes and run final broad verification once**
Run in order:
`npm test -- --run --passWithNoTests --exclude dist/**`
`npm run typecheck`
`npm run build`
PowerShell parser for M12 transaction scripts, `git diff --check`, tracked/evidence boundary-aware secret scan, and disposable B5 harness.
Any source mutation after this point invalidates these broad results and requires one fresh final broad run after bytes freeze again.

- [ ] **Step 4: Commit final source candidate and reproduce physical manifest from fresh checkout**
Record exact HEAD, tracked count, manifest SHA-256, clean status, and fresh-checkout equality. Do not include evidence in tracked source unless repository policy explicitly tracks that evidence path.
- [ ] **Step 5: Run independent exact-byte pre-live review**
Use a fresh read-only reviewer against the committed HEAD/manifest and current evidence. Required verdict: `PASS`, critical `0`, important `0`; otherwise remediate, refreeze, and rerun the invalidated gates.

- [ ] **Step 6: Emit pre-live decision envelope and STOP**
Only after zero blockers create the sealed Human decision envelope. Do not execute production activation in the same step. Report the exact required decision:
`APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION`.

### Task 11: Human-Gated Production Activation and Live B5 Matrix

**Gate:** This task MUST NOT start until the exact activation decision from Task 10 is supplied and currentness is re-proven.

**Files:**
- No source mutation expected.
- Evidence only: `evidence/m12/<LIVE_RUN_ID>/...`

- [ ] **Step 1: Re-prove minimal currentness**
Verify candidate HEAD/manifest clean, M11 final certification current, live M11 ACTIVE task/current scope, canary clean/current HEAD, API-key hash unchanged, `8768/8769`, shared/dedicated tunnel identity, no M12 task/deployment/state collision, and decision-envelope hashes.

- [ ] **Step 2: Execute sealed activation**
Run `scripts/execute-m12-b5-activation.ps1` with the exact decision envelope and Human decision. Require authenticated host proof: exact 13 tools, `ACTIVE`, scope `M12_B5_CANARY_STABILITY_ONLY`, mutation active, S2 false, generic exec/shell false, DESTRUCTIVE locked.

- [ ] **Step 3: Execute five live canary patterns sequentially**
Use only `operator-canary`, current HEAD binding, transaction-owned worktrees, M07 tasks, checkpoint/CAS, M12 remediation/lease state, and local Git. Each pattern records pre/post HEAD/status plus effect/recovery facts.

- [ ] **Step 4: Exercise M12→M11 rollback/recovery then final M12 reactivation**
Build a current post-dogfood rollback envelope pinning the new canary HEAD. Roll back to certified M11, prove task/listener/runtime/residue recovery, then preflight and reactivate the same M12 committed candidate under the already-authorized exact decision if currentness remains valid.

### Task 12: Final M12 Certification and Source Integration

**Files:**
- Evidence only: `evidence/m12/final/*`
- No source changes after candidate freeze.

- [ ] **Step 1: Fresh live currentness snapshot**
Require source/deployment HEAD+manifest exact match, clean worktrees, M12 task Running, M11 fallback Ready, canary clean, exact scope/status/capabilities, stable routes, and no secret persistence.
- [ ] **Step 2: Fresh independent final review**
Reviewer must bind exact committed bytes plus all five live B5 patterns, rollback/recovery, final reactivation, authority denials, and secret scan. Required output: `VERDICT=PASS`, `CRITICAL_COUNT=0`, `IMPORTANT_COUNT=0`, `FINDINGS=NONE`.

- [ ] **Step 3: Build deterministic final certification package**
Create `m12-final-certification.json`, evidence bindings, boundary-aware secret-scan result, deterministic SHA256SUMS, and seal. Reproduce every member hash from current bytes before emitting terminal.

Final terminal is exactly:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_QUALIFIED`.

- [ ] **Step 4: Git safety gate and fast-forward source integration**
Fetch `origin/main`; require origin is ancestor of certified HEAD, behind count zero, source clean, `git diff --check` PASS, tracked secret leaks zero. Push only HAIOS source candidate by normal fast-forward—no force. Do not push/mutate `haios-operator-canary` remote.

- [ ] **Step 5: Pin successor milestone without expanding authority**
Record next milestone as B6 first-project expansion to `skill-fabric`, followed only after separate qualification by `hermes-os`. Do not admit either project during M12 certification.

## Execution Order and Stop Rules

1. Tasks 1-9 are source implementation; each uses RED→GREEN→focused regression→commit.
2. Task 10 freezes bytes and performs the only final broad regression after the final source mutation.
3. Any source mutation after Task 10 broad verification invalidates that broad evidence and requires a fresh freeze/regression/review cycle.
4. Task 10 ends at the exact Human activation gate. Task 11 cannot be inferred from design/spec approval.
5. Any authority/currentness ambiguity is fail-closed; no cleanup may erase unknown/foreign state to obtain a pass.
6. After Task 11 begins, failure after production mutation must restore certified M11 before non-critical M12 cleanup.
7. M12 certification never claims B6, Level-B Stable, Level C, Maximum Operator, or Full Capability.

## Expected Source File Set

New focused units: `remediation-fingerprint.ts`, `remediation-store.ts`, `remediation-controller.ts`, `recovery-lease.ts`, `recovery-classifier.ts`, `m12-stability-coordinator.ts`, `m12-active-canary-config.ts`, `m12-active-canary-runtime.ts`, four M12 runtime/qualification scripts plus activation/preflight/rollback/probe scripts, and focused M12 tests.
Existing units modified only where integration is unavoidable: `transaction-isolation.ts`, `qualified-control-runtime.ts`, and compatibility tests. `protocol.ts`, public 13-tool definitions, M07 registry/effect policy, shared tunnel configuration, and M11 final evidence are immutable inputs unless a proven blocker forces scope escalation and a new design review.
