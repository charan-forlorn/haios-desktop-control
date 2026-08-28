# M04 Safe Remove Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. TDD and frequent verification are mandatory.

**Goal:** Add reversible, project-scoped, expected-hash-bound file removal without exposing raw deletion or unlocking DESTRUCTIVE.

**Architecture:** Add one typed remove intent to the existing transaction engine. Removal is implemented as a server-generated move into transaction-owned quarantine, verified there, restored by rollback on failure, and cleaned only after promotion.

**Tech Stack:** TypeScript 7.0.2, Node 24, MCP SDK 1.30.0, Vitest 4.1.11, Desktop Commander 0.2.47.

**Spec:** `docs/superpowers/specs/2026-08-28-m04-safe-remove-design.md`

## Global Constraints

- Baseline exact M03 HEAD is `1a4041b85e124d289007d480ed52f1e01d051fac`.
- Project mutation root remains exactly `C:\Workspace\haios-desktop-control`.
- M01 READ, M02 CONTROLLED EXECUTE, and M03 create/replace/move contracts must remain compatible.
- Add exactly one public tool: `transaction_stage_remove`; total downstream count becomes 27.
- Never expose delete/unlink/rm/raw move/process termination/config mutation.
- Remove regular files only; directories and non-regular files fail closed.
- DESTRUCTIVE remains LOCKED.

### Task 1: Typed safe-remove surface and staging

**Files:** Modify `src/capabilities.ts`, `src/transactions/types.ts`, `src/transactions/stage.ts`, `src/transactions/service.ts`, `src/server.ts`; create `tests/transaction-remove-stage.test.ts`.

- [ ] Write RED tests for exact 27-tool surface, exact remove args, valid SHA-256, project/sensitive/reparse denial, regular-file-only behavior, and mixed-intent conflicts.
- [ ] Run only focused remove-stage/server surface tests and confirm RED.
- [ ] Add `remove` intent and `transaction_stage_remove` typed routing with no raw delete.
- [ ] Add regular-file preflight using lstat after project realpath authorization.
- [ ] Run focused tests, typecheck, and commit Task 1.

### Task 2: Quarantine apply and exact rollback

**Files:** Modify `src/transactions/types.ts`, `src/transactions/adapter.ts`, `src/transactions/apply.ts`, `src/transactions/rollback.ts`, `src/transactions/preimage.ts`; create `tests/transaction-remove-apply.test.ts`.

- [ ] RED-test expected-hash mismatch, quarantine destination ownership, source absence/postimage hash, exact rollback, external source recreation conflict, quarantine drift conflict, and no upstream delete calls.
- [ ] Generate quarantine path only from rollback store + transaction ID + normalized source digest.
- [ ] Apply remove by capture then internal move; verify canonical absence plus quarantine hash.
- [ ] Roll back by conflict-safe move from quarantine to source.
- [ ] Run focused tests, typecheck/build, and commit Task 2.

### Task 3: Verification/promotion integration

**Files:** Modify `src/transactions/service.ts`; create `tests/transaction-remove-promotion.test.ts`.

- [ ] RED-test verifier PASS -> PROMOTED/source absent/runtime cleaned and verifier FAIL -> ROLLED_BACK/exact source restored/runtime cleaned.
- [ ] Reuse existing verification profile and cleanup path; add no content to status/audit.
- [ ] Run focused transaction tests, then one full regression; commit Task 3.

### Task 4: M04 adversarial and live qualification

**Files:** Create `tests/m04-adversarial.test.ts`, `scripts/qualify-m04.ps1`; evidence only under `evidence/m04/<run-id>/`.

- [ ] Adversarial-test traversal/outside/sensitive/reparse/directory/hash drift/replay/raw delete/external recreation/quarantine drift.
- [ ] Run focused adversarial once, one full regression on final committed bytes, typecheck/build.
- [ ] Live MCP: create disposable file, stage remove, apply -> PROMOTED and absent; separately force verification failure -> exact rollback.
- [ ] Restore fixture namespace to exact preimage and prove zero transaction/runtime residue.
- [ ] Persist HEAD, manifest, test counts, lifecycle, tunnel pre/post digests, zero unauthorized mutations, and secrets persisted false.
- [ ] Independent read-only reviewer verifies exact HEAD/manifest/contracts without rerunning unchanged tests.
- [ ] Seal only at zero blockers with `HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_SAFE_REMOVE_QUALIFIED`.
