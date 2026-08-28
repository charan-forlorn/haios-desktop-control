# M06 Isolated Transaction Worktree + Local Checkpoint + CAS Promotion

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_ISOLATED_CHECKPOINT_CAS`
**Status:** approved implementation design
**Date:** 2026-08-28
**Baseline:** M05 terminal `HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_LEVEL_B_PROTOCOL_RECONCILIATION_QUALIFIED`
**Parent HEAD:** `a21b574ca56a0d71dde9d6182d039baf206d9094`
**Authoritative contract:** HAIOS Engineering Autonomy Level B R1.2

## 1. Objective

Qualify the isolation and local Git promotion invariants required before Operator mutation can become active. M06 creates transaction-owned Git worktrees, applies staged file mutations only inside those worktrees, creates a local checkpoint commit, and promotes only by compare-and-swap plus Git fast-forward.

M06 does **not** activate public `operator13` mutation, does not enable `operator_run_task`, does not enable S2, and does not add network Git authority.

## 2. Architectural Decision

Keep M01-M05 public behavior unchanged. Add a new internal `src/operator/transaction-*` subsystem that is independent from M04's direct-canonical `TransactionService`.

The legacy M04 service remains the `legacy27` compatibility path. The new M06 service exists solely for Level B isolation qualification and future Operator wiring.

## 3. Transaction Lifecycle

A transaction owns one generated ID, one exact canonical base HEAD, one generated branch, and one generated worktree path. The lifecycle is `OPEN -> STAGED -> VALIDATED -> APPLIED -> CHECKPOINTED -> PROMOTED`, with rollback allowed before promotion.
At begin, canonical HEAD and cleanliness are captured before creating the worktree. The worktree must start from that exact HEAD. All staged relative paths are validated against traversal, absolute paths, `.git`, secret-sensitive segments, symlink/reparse escape, and non-regular source files.

`apply` may alter only the transaction worktree. Canonical HEAD, canonical tracked bytes, and canonical cleanliness must remain unchanged until promotion.

## 4. Local Git Boundary

M06 adds a typed local-only Git wrapper with specific methods for HEAD/status, worktree add/remove, add, commit, ancestor check, branch delete, and `merge --ff-only`.

No generic Git command entrypoint is public. No `push`, `pull`, `fetch`, `clone`, `remote`, remote URL mutation, force update, reset, rebase, or history rewrite is exposed.

Checkpoint commits use a fixed local HAIOS identity and never contact a remote.

## 5. Checkpoint Contract

`checkpoint(txId, message)` is allowed only after successful worktree apply. It stages the worktree delta and creates exactly one local commit. The resulting full 40-character commit SHA becomes the immutable checkpoint ID stored in transaction state.

A checkpoint is valid only when it descends from the transaction's captured base HEAD and the worktree is clean after commit.

## 6. CAS Promotion Contract

`promote(txId, expectedHeadSha, checkpointId)` succeeds only when all conditions are true:

- transaction is `CHECKPOINTED`;
- supplied checkpoint equals the transaction checkpoint;
- supplied expected HEAD equals the captured base HEAD;
- canonical HEAD still equals expected HEAD;
- canonical worktree is clean;
- checkpoint is a descendant of expected HEAD;
- promotion can complete with `git merge --ff-only <checkpoint>`.
Any mismatch returns a deterministic conflict and performs no canonical mutation. Promotion must verify the resulting canonical HEAD equals the checkpoint and canonical status is clean.

## 7. Rollback and Cleanup

Before promotion, rollback removes only the transaction-owned worktree and generated branch after repository identity checks. Failed apply/checkpoint/promotion attempts must not delete or rewrite canonical history.

Qualification runtime must end with zero disposable worktree residue and port 8772 free. Existing tunnel listeners on 8768 and 8769 must remain unchanged.

## 8. Public Operator State

M06 does not change `operator13` from `READ_ONLY_EMERGENCY`. Public `operator_status` and `operator_capabilities` remain M05-compatible; the 11 non-read Operator tools still fail closed before legacy dispatch.

M06 certification proves the internal isolation/checkpoint/promotion mechanism only. Public activation requires a later milestone that also qualifies task execution and complete Operator routing.

## 9. Qualification Gates

M06 must prove with focused and adversarial tests plus a disposable live Git repository:

1. canonical bytes never change before promotion;
2. worktree mutations are isolated;
3. path/symlink/secret-sensitive escapes fail closed;
4. checkpoint is a real local descendant commit;
5. stale canonical HEAD causes CAS conflict with zero promotion mutation;
6. clean matching canonical HEAD promotes by fast-forward only;
7. rollback/cleanup removes transaction-owned runtime residue;
8. no network Git operation is reachable from the M06 subsystem;
9. M01-M05 regression remains green;
10. independent review is required before final certification.

Final candidate terminal before independent review: `HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_READY_FOR_INDEPENDENT_VERIFICATION`.
