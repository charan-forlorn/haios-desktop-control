# HAIOS Desktop Control Plane R1 — M12 B5 Canary Stability Closure Design

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_CLOSURE`
**Status:** DESIGN APPROVED — SPECIFICATION GATE
**Date:** 2026-08-29
**Parent milestone:** M11 `HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED`
**Parent HEAD:** `1c32ba789ce89872b36bfed5f7a527b917072d6b`
**Parent manifest:** `ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a`
**Parent final-cert SHA256:** `5ec20ecc9ae0bb72cdd84dfeaa6c53c659e994adb6f05d13473096b0b3da45b0`

## 1. Purpose
M12 closes the remaining B5 canary-stability semantics before any broader Level-B project admission.
M11 has already proven one real local canary promotion, stale-CAS denial, transaction rollback, production rollback to certified M10, and successful reactivation.
M12 does not replace those proofs; it extends the runtime with deterministic autonomous-failure handling and ownership-aware recovery, then re-runs the required B5 canary patterns on the final M12 semantics.

The production control plane remains the certified M11 runtime during M12 implementation and pre-live qualification.
No M12 source/test/spec work may silently mutate the live M11 task, live `:8769`, dedicated tunnel route, shared `:8768`, M10 API-key bytes, or canonical canary bytes.

## 2. Target Capability
M12 adds four bounded capabilities to the existing exact 13-tool Operator runtime:
1. deterministic dual failure fingerprints;
2. bounded autonomous remediation/replan state;
3. ownership-aware transaction lock/worktree recovery and garbage collection;
4. complete B5 live-canary stability qualification on the final candidate semantics.

M12 keeps the production project set exactly:
`operator-canary -> C:\Workspace\haios-operator-canary`

## 3. Authority Boundary
M12 MUST NOT add S2, generic shell, generic exec, DESTRUCTIVE authority, remote Git mutation, dependency-download authority, cloud mutation, deployment authority, credential authority, arbitrary project admission, or tunnel mutation.
The exact 13-tool public Operator surface remains unchanged.
All source mutation stays transaction-owned; task execution stays registry-owned; canonical promotion remains ff-only and expected-HEAD/CAS bound.

Pre-live implementation may change only M12 source, tests, docs, synthetic/disposable fixtures, qualification scripts, and M12-specific evidence.
Production activation is a self-modification event and requires a separate exact Human decision after committed-byte qualification and independent review.

## 4. Dual Failure Fingerprint Contract
Every remediation-eligible task failure produces two immutable fingerprints from sanitized deterministic metadata.

**Coarse fingerprint** MUST encode only stable failure class and bounded execution identity, including task ID, deterministic reason/failure class, sandbox profile, registry/effect-policy identities, and normalized exit/timeout/effect classification.
It MUST exclude timestamps, generated transaction IDs, worktree paths, PIDs, random resource names, raw stdout/stderr, secrets, and other volatile fields.

**Fine diagnostic fingerprint** MAY additionally encode bounded sanitized diagnostic structure needed to distinguish materially different failures, but MUST remain deterministic for byte-equivalent failure evidence.
It MUST not persist raw secret-like output or unrestricted host paths.

Two failures with the same semantic cause and only volatile runtime differences MUST yield the same coarse fingerprint.
A material failure-class or policy/currentness change MUST change the appropriate fingerprint.

## 5. Autonomous Remediation and Stagnation State Machine
M12 introduces a server-owned remediation state machine; callers cannot set attempt counts, fingerprints, progress state, or terminal classification.
The maximum remediation-attempt budget is **5** for one remediation episode.
Objective progress means a verifiable change in at least one server-owned invariant: failure fingerprint, validated transaction state, task/effect result, checkpoint identity, or canonical currentness result.
Narration, elapsed time, retry count, or regenerated IDs are not progress.

Required transitions:
- first remediation-eligible failure -> record episode + fingerprints + attempt 1;
- same coarse fingerprint on the next attempt with no objective progress -> `REPLAN_REQUIRED`;
- exactly one clean-state replan may be admitted for that episode;
- after replan, recurrence of the same coarse fingerprint with no objective progress -> `AUTONOMOUS_REMEDIATION_STAGNATED`;
- reaching attempt 5 without a verified pass -> `AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED`;
- policy/currentness/authority/emergency-class failures are never auto-remediated merely because budget remains.

A clean-state replan requires no active mutable-code process, no unresolved task effects, no ambiguous transaction ownership, and a transaction state explicitly classified safe for another bounded attempt.

## 6. Remediation Input/Output Boundary
The remediation subsystem consumes only sanitized task-result metadata, transaction state, currentness facts, effect-manifest classification, and server-owned attempt history.
It does not consume arbitrary shell commands or model-generated executable strings.

M12 may produce only these bounded remediation directives: `RETRY_SAME_PLAN`, `REPLAN_REQUIRED`, `ROLLBACK_REQUIRED`, `MANUAL_RECONCILIATION_REQUIRED`, `AUTONOMOUS_REMEDIATION_STAGNATED`, `AUTONOMOUS_REMEDIATION_BUDGET_EXHAUSTED`, or `PASS`.
The directive is policy state, not a new public tool and not permission to bypass the existing transaction/task APIs.

No remediation directive can widen project, sandbox, network, secret, Git-remote, deployment, cloud, or destructive authority.

### Durable Episode State
Remediation and recovery state MUST be persisted under the M12 state root, never inside the canonical project and never in arbitrary temp locations.
Each episode record binds schema/version, project/repository identity, transaction identity, base HEAD, attempt count, replan-used flag, last coarse/fine fingerprints, last verified progress fact, recovery classification, and content hash.
Writes MUST be atomic (new file + flush/close + replace/rename within the same state directory) and must never serialize raw stdout/stderr or secret-like values.
A corrupt, partial, schema-unknown, or hash-mismatched episode record is `MANUAL_RECONCILIATION_REQUIRED`, not a reset-to-zero opportunity.

## 7. Ownership-Aware Lock Contract
Any M12-created transaction lock/lease MUST bind at minimum:
- project ID and canonical root identity;
- canonical Git common-directory identity;
- transaction ID;
- owner process identity plus start-time or equivalent anti-PID-reuse evidence;
- creation/heartbeat timestamps for liveness classification only;
- M12 lock schema/version and runtime identity.
Unknown Git locks, locks without provable M12 ownership, or locks whose repository identity does not match the recorded transaction MUST NOT be removed.
A stale M12 lock may be removed only when all are true: transaction ownership is exact, owner process is proven dead with PID-reuse protection, no active lease exists, repository identity matches, and recovery classification permits cleanup.

## 8. Worktree Garbage Collection
M12 garbage collection is ownership-scoped, never directory-pattern deletion.
A worktree/resource is removable only if its recorded transaction identity, generated branch, canonical repository identity, and M12 ownership metadata all match.

GC MUST refuse cleanup when ownership is ambiguous, a live owner/lease exists, currentness has diverged beyond the recorded transaction contract, or Git reports a relationship inconsistent with M12 state.
Unrelated user worktrees, repositories, Docker resources, processes, files, and Git locks are never GC targets.

GC result metadata records considered resources, ownership decision, cleanup action, and residue status without persisting secrets.
Successful completion requires zero M12-owned disposable residue; uncertainty is a failure, not success.

## 9. Crash and Recovery Classification
On restart or explicit recovery, M12 reconstructs state from durable transaction metadata and live Git/filesystem facts rather than trusting prior in-memory state.
Every interrupted episode MUST resolve to exactly one classification:
- `SAFE_TO_CONTINUE` — transaction ownership/currentness are exact and no ambiguous mutable execution/effects remain;
- `SAFE_TO_ROLLBACK` — exact owned transaction can be deterministically discarded without canonical mutation;
- `MANUAL_RECONCILIATION_REQUIRED` — any ownership/currentness/effect ambiguity exists.

`MANUAL_RECONCILIATION_REQUIRED` fails closed and blocks autonomous mutation for the affected project/transaction until reconciled.
Recovery MUST never infer success solely from absence of a process or worktree.

## 10. Existing M07 Effect/Sandbox Reuse
M12 reuses the qualified M07 Task Effect Manifest, effect-policy binding, S0 sandbox, and S1 synthetic-fixture sandbox rather than creating parallel mechanisms.
The existing production M07 registry remains the task authority unless a proven M12 requirement necessitates a separately versioned registry; such a change must remain fixed-recipe and independently hash-bound.

S0 remains `networkAuthority=NONE`.
S1 remains `FIXTURE_ONLY` and may only use the already-qualified synthetic local fixture model.
S2 remains disabled.

## 11. Final B5 Canary Qualification Matrix
After M12 candidate bytes freeze, B5 must be re-proven on the final semantics with the real `operator-canary` and exact expected-HEAD/CAS boundaries.
The live qualification set is:
1. **Benign rollback:** begin/stage/rollback leaves canonical HEAD/status/bytes unchanged and zero transaction residue.
2. **Real correction:** stage a bounded canary correction, validate/apply, run qualified S0 task, checkpoint, and ff-only CAS promote successfully.
3. **Stale conflict:** create a concurrent canonical advance and prove stale promotion is denied with zero mutation from the stale transaction, then cleanly roll it back.
4. **Failed-test remediation:** intentionally introduce a bounded test failure, capture stable dual fingerprints, perform only policy-owned remediation/replan transitions, reach PASS within budget, and prove stagnation/budget rules on negative fixtures.
5. **Lock/effect/recovery:** exercise an M12-owned lock plus effect-manifest path, prove exact cleanup/rollback after interruption, prove unknown lock preservation, and prove ambiguous recovery becomes `MANUAL_RECONCILIATION_REQUIRED`.

Patterns 4 and 5 require negative/adversarial companion cases; a happy-path-only run does not qualify them.
All five patterns must end with canary clean and with no M12-owned worktree, lock, process, container, network, or runtime residue except the intentionally retained production runtime.

## 12. Stability Counter Boundary
M12 closes B5 but does not itself claim the later Level-B stable counter complete.
Any later `consecutive dogfood transactions` counter MUST start from the final certified core semantics that include M12 fingerprint/stagnation/recovery behavior.
Historical pre-M12 transactions may remain evidence but cannot be counted as consecutive transactions on the final semantics.

A transaction is countable only if it is a real bounded engineering transaction, all applicable task/effect/currentness/recovery gates pass, no manual override or authority waiver is used, and final state is independently auditable.

## 13. Implementation Isolation
M12 implementation occurs on a descendant branch/worktree of certified M11.
The live M11 deployment stays at certified HEAD `1c32ba789ce89872b36bfed5f7a527b917072d6b` until an M12 activation decision is explicitly made.

Candidate implementation MUST use TDD for new fingerprint, stagnation, lock, GC, and recovery semantics.
Focused tests precede broad regression; the final broad regression runs only after candidate tracked bytes freeze.
No implementation test may use the real canary for destructive or ambiguous fixtures before the live activation gate.

## 14. Pre-Live Qualification
Before requesting M12 production activation, the committed candidate must prove:
- exact M11 certified ancestry and current parent certification binding;
- deterministic tracked-source manifest reproduced from a fresh detached worktree;
- source worktree clean;
- focused M12 tests PASS;
- full regression, typecheck, build, PowerShell parser where applicable, and `git diff --check` PASS;
- fingerprint determinism and volatility-insensitivity matrix PASS;
- remediation attempt/replan/stagnation/budget negative matrix PASS;
- ownership-aware lock/GC negative matrix PASS;
- crash/restart recovery matrix PASS;
- M07 task/effect/S0/S1 regression PASS with S2 still denied;
- disposable end-to-end B5 simulation PASS;
- no live M11 mutation during pre-live qualification;
- persisted secret scan zero;
- independent exact-byte read-only review returns zero critical/important blockers.

Pre-live qualification may prepare activation/rollback envelopes but MUST NOT start M12 production.

## 15. Production Activation Gate
Replacing live M11 with M12 is a self-modification event and requires a new exact Human decision.
The activation envelope MUST bind the final M12 HEAD/manifest, M11 final certification, live M11 runtime/task/tunnel identity, canary HEAD/cleanliness, M10 API-key digest, activation/rollback script hashes, and forbidden-authority flags.

The exact approval string will be generated only after pre-live qualification freezes the final candidate; the spec does not pre-authorize an unknown future candidate.

Activation order is recovery-first and fail-closed:
1. prove live M11 currentness and canary preimage;
2. materialize exact M12 deployment/state;
3. stop M11 only after all pre-mutation gates pass;
4. start M12 on the same loopback `:8769` backend while preserving tunnel routes;
5. authenticate exact tool/status/capability currentness;
6. if any post-mutation step fails, restore the certified M11 runtime before non-critical M12 cleanup.

## 16. Production Authority After Activation
A live M12 runtime still reports `mode=ACTIVE` but only under the exact activation scope `M12_B5_CANARY_STABILITY_ONLY`; alternate scope strings are invalid.
It admits only `operator-canary` and keeps exact 13 tools.

Required live capability facts remain:
- mutation active only through transaction-owned primitives;
- S2 disabled;
- generic exec false;
- generic shell false;
- DESTRUCTIVE locked;
- remote Git/cloud/deployment/credential/tunnel mutation not authorized.

## 17. Live B5 Execution and Recovery Drill
After activation, execute all five Section 11 canary patterns on the live M12 runtime.
The recovery drill must include at least one controlled interruption in an M12-owned transaction and prove durable reconstruction plus an exact safe classification.
Unknown-lock preservation and ambiguous-recovery denial may use controlled fixtures when reproducing them against the real canonical repository would itself create unacceptable risk.
Fixtures must preserve the same ownership/currentness decision logic as production code.

No B5 pattern may use force update, fetch/pull/push, remote repository mutation, Internet dependency installation, cloud calls, S2, arbitrary process control, or unrestricted shell/exec.

## 18. Evidence and Independent Review
M12 evidence must bind at minimum:
- parent M11 cert/head/manifest;
- candidate head/manifest and fresh-worktree reproduction;
- focused/full verification results;
- fingerprint matrices and remediation episode histories;
- lock/lease ownership and GC decisions;
- crash/recovery classifications;
- disposable qualification;
- activation decision envelope and exact Human decision;
- five live B5 pattern results;
- canonical pre/post HEAD/status and zero-residue facts;
- tunnel/shared-8768 preservation;
- API-key no-rotation fact;
- secret-scan result;
- reviewer transcript/verdict.

Independent review is performed on exact frozen bytes/evidence and must be read-only.
A reviewer finding is not overridden by orchestration; defects require remediation and fresh currentness/review.

## 19. Rollback Contract
Rollback target is the exact certified M11 production state, not an inferred equivalent state.
Recovery priority is: restore certified M11 availability and read authority first, verify it, then remove only proven M12-owned residue.

Rollback MUST preserve the current clean canary HEAD unless an M12-owned in-flight transaction has not been promoted; unpromoted owned work may be discarded only through exact transaction rollback semantics.
Unknown or ambiguous effects cause `MANUAL_RECONCILIATION_REQUIRED` rather than destructive cleanup.

## 20. Qualification Terminals
Pre-live zero-blocker terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_READY_FOR_EXACT_HUMAN_ACTIVATION_DECISION`

Live zero-blocker terminal after activation plus all B5 patterns:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_QUALIFIED`

Rollback terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_ROLLED_BACK_TO_CERTIFIED_M11_ACTIVE_CANARY`

## 21. Explicit Non-Goals
M12 does not:
- admit `skill-fabric`, `hermes-os`, or any additional project;
- complete the later ten-transaction Level-B stable counter;
- enable S2 or host-service production authority;
- add generic shell/exec;
- unlock DESTRUCTIVE;
- perform remote Git mutation or publish/push as an Operator task;
- install/download dependencies from the Internet;
- mutate cloud or external production resources;
- expose secrets or credential-store reads;
- modify Secure MCP tunnel identities/routes;
- remove the certified M10/M11 recovery lineage;
- claim Level C, Maximum Operator, or Full Capability.

## 22. Successor Sequence
After M12 is live-certified, the next authority expansion is B6 and must occur incrementally rather than as an all-project switch.
The intended sequence is:
1. admit and certify `skill-fabric` under the final B5 core semantics;
2. admit and certify `hermes-os` under the same bounded semantics;
3. execute the required consecutive real Level-B dogfood transactions on final core semantics;
4. close Level-B Stable only after all currentness, effect, isolation, recovery, stagnation, secret, and independent-review gates pass;
5. design Level-C capability lanes separately, each with explicit authority and rollback contracts.

M12 therefore closes canary stability; it is the safety foundation for broader authority, not the broader authority itself.
