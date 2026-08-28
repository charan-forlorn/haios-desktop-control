# M06 Isolated Transaction Worktree + Local Checkpoint + CAS Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and qualify the internal Level B transaction isolation, local checkpoint, and CAS fast-forward promotion mechanism without activating public Operator mutation.

**Architecture:** Add an Operator-specific local Git boundary and transaction service independent from M04's direct-canonical service. Each transaction owns a generated Git worktree created from an exact canonical HEAD; staged mutations occur only there, checkpoint creates a local descendant commit, and promotion advances canonical only when CAS and `--ff-only` gates pass.

**Tech Stack:** TypeScript, Node.js filesystem/child_process/crypto, Vitest, Git, PowerShell 7 qualification harness.

**Spec:** `docs/superpowers/specs/2026-08-28-m06-isolated-checkpoint-cas-design.md`

## Global Constraints

- M01-M05 public behavior must remain unchanged.
- `operator13` stays `READ_ONLY_EMERGENCY`; no public mutation routing in M06.
- M04 `legacy27` transaction behavior remains untouched.
- No generic shell or generic Git command API.
- No Git push/pull/fetch/clone/remote mutation in the M06 subsystem.
- No S2, secrets authority, process termination, privileged config, cloud, or production mutation.
- Qualification may mutate only a disposable local Git repository.
- Existing ports 8768/8769 remain intact; disposable 8772 must end free.
- No changes to `C:\Workspace\haios-operator-mcp`.

---

### Task 1: Typed Local-Only Git Boundary

**Files:**
- Create: `src/operator/local-git.ts`
- Test: `tests/m06-local-git.test.ts`

**Produces:** `LocalOperatorGit`, `OperatorGitExecutor`, typed methods for status/HEAD/worktree/checkpoint/ancestor/ff-only/cleanup only.
- [ ] Write failing tests proving exact argv for `rev-parse`, `status --porcelain`, `worktree add -b`, `add -A`, local commit identity, `merge-base --is-ancestor`, `merge --ff-only`, worktree removal, and branch deletion.
- [ ] Prove the class exposes no generic run/exec method and tests never observe network Git verbs.
- [ ] Run focused test and require RED because module is absent.
- [ ] Implement the minimum typed wrapper with injected executor for tests and `execFile('git', ...)` default execution.
- [ ] Run focused test, typecheck, build; require PASS.
- [ ] Commit `feat: add m06 local git boundary`.

### Task 2: Transaction-Owned Worktree + Safe Staging

**Files:**
- Create: `src/operator/transaction-isolation.ts`
- Create: `src/operator/transaction-types.ts`
- Test: `tests/m06-transaction-isolation.test.ts`

**Produces:** `OperatorTransactionService` with `begin`, stage create/patch/move/remove, `validate`, `status`.

- [ ] Write failing tests that begin requires an allowlisted project/root pair, clean canonical status, and exact base HEAD.
- [ ] Prove each transaction receives a generated ID, generated branch, and generated worktree rooted under configured `worktreeRoot` at the captured HEAD.
- [ ] Prove absolute/traversal/`.git`/secret-sensitive paths, symlink escape, wrong preimage, duplicate create target, and invalid state transitions fail closed.
- [ ] Implement immutable staged intent records and relative-path resolution constrained to the transaction worktree.
- [ ] Run focused tests, typecheck, build; require PASS.
- [ ] Commit `feat: add m06 isolated transaction staging`.

### Task 3: Worktree Apply + Local Git Checkpoint

**Files:**
- Modify: `src/operator/transaction-isolation.ts`
- Test: `tests/m06-checkpoint.test.ts`

**Produces:** `apply(txId)`, `checkpoint(txId, message)`.

- [ ] Write failing tests proving apply changes only worktree bytes while canonical HEAD/status/content remain byte-identical.
- [ ] Cover create, patch, move, and remove; failed apply destroys only transaction-owned workspace and never repairs by mutating canonical.
- [ ] Write failing checkpoint tests proving empty/invalid state rejects, local commit is a real 40-char SHA, checkpoint descends from base HEAD, and worktree is clean after commit.
- [ ] Implement worktree-only apply then `git add -A` + fixed-local-identity commit + descendant verification.
- [ ] Run focused tests, typecheck, build; require PASS.
- [ ] Commit `feat: add m06 worktree apply checkpoint`.
### Task 4: CAS Fast-Forward Promotion + Rollback Cleanup

**Files:**
- Modify: `src/operator/transaction-isolation.ts`
- Test: `tests/m06-promotion.test.ts`

**Produces:** `promote(txId, expectedHeadSha, checkpointId)` and `rollback(txId)`.

- [ ] Write failing tests proving stale canonical HEAD, dirty canonical status, wrong expected HEAD, wrong checkpoint, and non-descendant checkpoint all deny before canonical mutation.
- [ ] Prove successful promotion advances canonical exactly to checkpoint with `merge --ff-only`, leaves canonical clean, never rewrites history, and records `PROMOTED`.
- [ ] Prove rollback before promotion removes the transaction worktree and generated branch only; canonical HEAD and bytes remain unchanged.
- [ ] Implement deterministic conflict reasons, success verification, and cleanup with explicit `cleanupPending` reporting if post-promotion cleanup cannot complete.
- [ ] Run focused tests, typecheck, build; require PASS.
- [ ] Commit `feat: add m06 cas promotion rollback`.

### Task 5: Adversarial + Disposable Live Qualification

**Files:**
- Create: `tests/m06-adversarial.test.ts`
- Create: `scripts/qualify-m06.ps1`

- [ ] Prove the M06 subsystem cannot issue network Git verbs, cannot touch public Operator routing, and cannot publish a legacy/operator union.
- [ ] Prove path escape, symlink/reparse escape, stale-head CAS, checkpoint mismatch, dirty canonical, invalid state, and cleanup ownership failures fail closed.
- [ ] Run focused M06 adversarial tests.
- [ ] Run exactly one final full regression, typecheck, and build on committed candidate bytes.
- [ ] Freeze deterministic tracked-source manifest using ordinal path order and lowercase SHA-256 entries.
- [ ] Create a disposable local Git repository; execute isolation -> apply -> checkpoint -> stale-head conflict -> rollback, then a fresh transaction -> checkpoint -> successful ff-only promotion.
- [ ] Verify canonical bytes remain unchanged before promotion, successful promotion HEAD equals checkpoint, runtime worktree residue is zero, 8768/8769 remain listening, and 8772 is free.
- [ ] Produce independent-review handoff bound to exact HEAD + manifest.
- [ ] Stop at `HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_READY_FOR_INDEPENDENT_VERIFICATION`.

### Final Certification Gate

Final certification requires independent zero-blocker review of exact committed bytes. No GitHub push occurs until final certification, clean worktree verification, secret/residue checks, and remote destination verification all pass.
