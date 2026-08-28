# M03 Transactional Mutate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans task-by-task. TDD and frequent verification are mandatory.

**Goal:** Add fail-closed, project-scoped transactional create/replace/move mutation with deterministic rollback while preserving certified READ and CONTROLLED EXECUTE behavior.

**Architecture:** Add a transaction state engine and typed mutation dispatcher above Desktop Commander internal filesystem primitives. Transactions capture HEAD/tracked-state/preimages, validate again immediately before apply, verify postimages, auto-rollback failures, and never expose raw mutation tools.

**Tech Stack:** TypeScript 7.0.2, Node 24, MCP SDK 1.30.0, Vitest 4.1.11, Desktop Commander 0.2.47.

**Spec:** `docs/superpowers/specs/2026-08-28-m03-transactional-mutate-design.md`

## Global Constraints

- Project root is exactly `C:\Workspace\haios-desktop-control`.
- M01 READ and M02 CONTROLLED EXECUTE contracts must remain compatible.
- Raw write/edit/move/start/kill/config tools remain absent downstream.
- Delete is excluded from M03.
- All mutation paths use existing path authority and sensitive/reparse protections.
- Any currentness ambiguity, unexpected drift, or rollback conflict fails closed.
- DESCTRUCTIVE capability remains LOCKED.
### Task 1: Transaction capability registry and state machine

**Files:** Modify `src/capabilities.ts`, `src/policy.ts`, `src/server.ts`; create `src/transactions/types.ts`, `src/transactions/state.ts`; create `tests/transaction-state.test.ts`.

**Produces:** immutable eight-tool MUTATE registry, explicit transition function, server tool schemas. No filesystem mutation in this task.

- [ ] Write RED tests for exact eight-tool surface, class-specific authorization, valid transitions, replay/invalid transition denial, and raw mutation absence.
- [ ] Run only `tests/transaction-state.test.ts` plus server surface test and confirm RED.
- [ ] Implement minimal immutable registry/state transition logic and schemas.
- [ ] Run focused tests, typecheck, then full regression.
- [ ] Commit only Task 1 files.

### Task 2: Transaction store, begin, stage, and currentness

**Files:** Create `src/transactions/store.ts`, `src/transactions/currentness.ts`, `src/transactions/stage.ts`; create `tests/transaction-stage.test.ts`.

**Produces:** server-issued transaction IDs, exact project root, HEAD/tracked-state capture, typed create/replace/move intents, expected preimage hashes.

- [ ] RED-test transaction identity, path authority, duplicate/conflicting intents, sensitive/reparse denial, stale HEAD/state, and zero upstream mutation during staging.
- [ ] Implement bounded in-memory transaction store plus durable non-secret metadata hook.
- [ ] Reuse existing path authority; reject every unknown field and client-supplied command.
- [ ] Verify focused tests, typecheck, full regression, then commit.
### Task 3: Internal mutation adapter and durable rollback bundle

**Files:** Modify `src/upstream.ts`; create `src/transactions/adapter.ts`, `src/transactions/preimage.ts`; create `tests/transaction-adapter.test.ts`.

**Produces:** internal-only create/replace/move primitives and transaction-owned rollback material. No raw mutation method is exported through MCP.

- [ ] RED-test adapter exact arguments, preimage capture-before-write, create requires absent target, replace requires expected hash, and move destination absence.
- [ ] Implement the smallest internal Desktop Commander mapping needed for create/replace/move.
- [ ] Persist rollback bytes only under the transaction runtime directory with restrictive project-local placement.
- [ ] Verify zero secret/audit leakage, focused tests, typecheck and full regression.
- [ ] Commit Task 3 files only.

### Task 4: Validate, apply, postimage verification, auto-rollback

**Files:** Create `src/transactions/apply.ts`, `src/transactions/rollback.ts`; create `tests/transaction-apply.test.ts`, `tests/transaction-rollback.test.ts`.

**Produces:** pre-apply CAS, deterministic operation order, postimage verification, automatic rollback and rollback-conflict detection.

- [ ] RED-test stale-before-apply, mid-apply injected failure, byte-exact rollback, rollback conflict, unexpected tracked drift, and postimage mismatch.
- [ ] Implement validate-again immediately before first mutation.
- [ ] Apply only staged immutable intents and verify exact postimage hashes.
- [ ] Auto-rollback every failed gate after first mutation; never overwrite externally changed bytes during rollback.
- [ ] Verify focused tests, full regression, typecheck/build, then commit.
### Task 5: MCP routing, audit, verification profile, and promotion

**Files:** Modify `src/server.ts`, `src/audit.ts`; create `src/transactions/service.ts`; create `tests/server-mutate-routing.test.ts`, `tests/transaction-promotion.test.ts`.

**Produces:** eight typed downstream mutation tools, metadata-only lifecycle audit, focused verification hook, transaction status and promotion evidence.

- [ ] RED-test authenticated routing, exact transactionId binding, raw mutation tool absence, audit secrecy, verification failure rollback, and promotion-only-after-VERIFIED.
- [ ] Wire typed wrappers to transaction service; do not expose internal adapter primitives.
- [ ] Reuse controlled execution only through fixed verification profiles.
- [ ] Run focused tests, full regression, typecheck/build, then commit.

### Task 6: M03 adversarial/live qualification and independent certification

**Files:** Create `tests/m03-adversarial.test.ts`, `scripts/qualify-m03.ps1`; evidence under `evidence/m03/<run-id>/` only.

**Produces:** disposable live create/replace/move proof, injected-failure rollback proof, byte-exact reconciliation, currentness/tunnel integrity proof and independent read-only verdict.

- [ ] Add adversarial cases for outside path, traversal, sensitive/reparse, unknown fields, stale transaction, transition replay, external drift, rollback conflict, and raw mutation calls.
- [ ] Run focused adversarial tests once, then one full regression on final candidate bytes.
- [ ] Live-qualify only disposable fixtures under the project and prove cleanup returns their namespace to the exact preimage.
- [ ] Persist source manifest, hashes, test counts, transaction lifecycle evidence, zero unauthorized mutations, zero persisted secrets, and tunnel pre/post digests.
- [ ] Independent read-only reviewer verifies exact HEAD/manifest/contracts without rerunning unchanged tests; remediate findings delta-only.
- [ ] Seal only after 0 critical/blocking findings with terminal `HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_TRANSACTIONAL_MUTATE_QUALIFIED`.
