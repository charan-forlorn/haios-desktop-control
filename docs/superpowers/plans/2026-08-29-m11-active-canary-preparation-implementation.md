# M11 Active Canary Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use test-driven development and verification-before-completion. Execute task-by-task with exact file scope.

**Goal:** Build and pre-live qualify a canary-only production ACTIVE runtime without changing the current M10 production read-only state.

**Architecture:** Add an M11-specific authority validator and runtime wrapper rather than widening M09 `M09_TEST_ONLY` or M10 read-only semantics. Prepare transactional activation/rollback scripts and prove the ACTIVE path only on disposable Git bytes before any Human live-activation decision.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, PowerShell 7, Git, Docker sandbox reused from M07.

**Spec:** `docs/superpowers/specs/2026-08-29-m11-active-canary-preparation-design.md`

## Global Constraints
- Parent is exact M10 candidate `f476f719be42ee40fe6ae5358930dc1662a95d3e` plus M11 docs commits.
- Live `127.0.0.1:8769` remains M10 `READ_ONLY_EMERGENCY` during pre-live work.
- Shared `:8768` and both existing tunnel routes are not mutated.
- Only production project admitted by M11 is `operator-canary -> C:\Workspace\haios-operator-canary`.
- `S2=false`, `DESTRUCTIVE=LOCKED`, generic shell/exec denied, remote Git/cloud denied.
- No real canary canonical mutation before exact Human activation authority.

---

### Task 1: Strict M11 ACTIVE-canary configuration
**Files:**
- Create: `src/operator/m11-active-canary-config.ts`
- Test: `tests/m11-active-canary-config.test.ts`

**Produces:** `validateM11ActiveCanaryConfig()` and branded validated config for `ACTIVE + M11_CANARY_ONLY` only.

- [ ] Write RED tests for exact project/root/scope, own-property-only input, unknown fields, wrong roots, wrong modes, wrong scope, inline secret attempts, and production-port rules.
- [ ] Run only `tests/m11-active-canary-config.test.ts`; confirm RED.
- [ ] Implement the minimal fail-closed validator without changing M09/M10 validators.
- [ ] Run focused test, typecheck, build; confirm GREEN.
- [ ] Commit `feat: add strict m11 active canary config`.
### Task 2: Dedicated M11 ACTIVE runtime and launcher
**Files:**
- Create: `src/operator/m11-active-canary-runtime.ts`
- Create: `scripts/run-m11-active-canary-runtime.mjs`
- Test: `tests/m11-active-canary-runtime.test.ts`

**Consumes:** strict validated M11 config, existing `createQualifiedOperatorControlRuntime()`, exact M08/M07 identities.

**Produces:** ACTIVE `operator13` runtime with canary-only `allowedProjects` and readiness metadata containing `activationScope=M11_CANARY_ONLY`.

- [ ] Write RED tests proving exact 13 tools, ACTIVE status, mutation active, S2/generic exec/generic shell false, DESTRUCTIVE locked, and canary-only project identity.
- [ ] Prove M09 `M09_TEST_ONLY` behavior and M10 `READ_ONLY_EMERGENCY` behavior remain unchanged.
- [ ] Implement runtime/launcher with file-backed API key and no-authority upstream.
- [ ] Run focused tests, typecheck, build; confirm GREEN.
- [ ] Commit `feat: add m11 active canary runtime`.

### Task 3: Sealed activation and rollback transaction
**Files:**
- Create: `scripts/preflight-m11-active-canary.ps1`
- Create: `scripts/execute-m11-active-canary.ps1`
- Create: `scripts/rollback-m11-active-canary.ps1`
- Create: `scripts/run-m11-active-canary-supervisor.mjs`
- Create: `scripts/probe-m11-active-canary-host.mjs`
- Test: `tests/m11-activation-transaction.test.ts`

**Produces:** static/pre-live package only; execution requires exact Human decision and current M10 final certification.

- [ ] RED-test exact decision string, M10-final-cert prerequisite, exact canary root, M10 task preservation, M11 task identity, deployment-currentness binding, rollback preimages, and dedicated-tunnel non-mutation.
- [ ] Implement preflight that performs zero production mutation.
- [ ] Implement executor that cannot pass the first mutation boundary without exact Human decision + current M10 final cert.
- [ ] Implement rollback restoring exact M10 deployment/task/config and read-only host proof.
- [ ] Parse all PowerShell files and run focused tests; confirm GREEN.
- [ ] Commit `feat: add sealed m11 activation rollback transaction`.
### Task 4: Disposable ACTIVE end-to-end qualification
**Files:**
- Modify: `src/operator/m11-active-canary-runtime.ts`
- Create: `scripts/live-m11-disposable-active.mjs`
- Create: `tests/m11-disposable-active.test.ts`
- Create: `scripts/qualify-m11-active-canary.ps1`

**Produces:** durable pre-live evidence proving ACTIVE transactions on disposable Git bytes only.

- [ ] Build a disposable canonical repo and disposable API-key/config under `runtime/m11-fixture`.
- [ ] Start M11 runtime on a disposable non-production port.
- [ ] Through the MCP surface prove begin/stage/validate/apply, canonical unchanged before promotion, S0 `project.test`, checkpoint, ff-only CAS promotion, stale-CAS denial, rollback, and cleanup.
- [ ] Assert real `C:\Workspace\haios-operator-canary` HEAD/status are unchanged before/after.
- [ ] Assert live M10 task, `:8769`, dedicated tunnel container/config, shared tunnel, and `:8768` are unchanged.
- [ ] Persist a bounded JSON result without secret bytes.
- [ ] Run focused tests and the qualification script; confirm GREEN.
- [ ] Commit `test: qualify m11 disposable active canary path`.

### Task 5: Freeze candidate and pre-live decision package
**Files:**
- Create under `evidence/m11/<RUN_ID>/` only after source stabilization.

- [ ] Run M11-focused tests.
- [ ] Run one final full regression after final source mutation.
- [ ] Run typecheck and build.
- [ ] Generate deterministic source manifest and compare deployment-relevant bytes.
- [ ] Run secret scan and currentness checks.
- [ ] Produce exact activation decision envelope for `APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_ACTIVATION` but do not execute it.
- [ ] Run fresh independent exact-byte review; zero blockers required for pre-live readiness.
- [ ] Emit only `HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_READY_FOR_EXACT_HUMAN_ACTIVATION_DECISION` on complete success.
