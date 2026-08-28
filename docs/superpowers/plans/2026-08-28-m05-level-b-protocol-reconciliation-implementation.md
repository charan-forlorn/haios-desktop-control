# M05 Level B Protocol Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add an exact inactive Level B v1 13-tool protocol projection and validated typed task-registry foundation while preserving the M04 27-tool qualified legacy projection unchanged.

**Architecture:** Add separate protocol registry and task-registry modules, then make gateway public-tool projection selectable as `legacy27` or `operator13`. `operator13` is fixed to `READ_ONLY_EMERGENCY`; status/capabilities are readable and all 11 mutation/task/checkpoint/promotion tools fail closed before legacy dispatch.

**Tech Stack:** TypeScript, Vitest, MCP SDK, Node.js.

**Spec:** `docs/superpowers/specs/2026-08-28-m05-level-b-protocol-reconciliation-design.md`

## Global Constraints

- M04 exact behavior remains the baseline for `legacy27`.
- `operator13` lists exactly 13 Level B R1.2 tools.
- Operator mode is fixed `READ_ONLY_EMERGENCY` in M05.
- No Operator mutation/task/checkpoint/promotion dispatch in M05.
- No generic shell/exec, arbitrary executable/cwd/env, secrets, remote Git, cloud, production, process termination, or privileged config.
- `DESTRUCTIVE` remains locked.
- No changes to `C:\Workspace\haios-operator-mcp`.
- No Git push.
### Task 1: Exact Operator Protocol Registry

**Files:**
- Create: `src/operator/protocol.ts`
- Test: `tests/m05-operator-protocol.test.ts`

**Produces:** `OPERATOR_V1_TOOL_NAMES`, `OperatorMode`, `operatorFoundationStatus()`.

- [ ] Write failing tests for exact 13 names/order, uniqueness, absence of raw/generic tools, and fixed inactive mode.
- [ ] Run focused test and confirm RED because module is absent.
- [ ] Implement immutable protocol registry and status/capability metadata.
- [ ] Run focused test, typecheck, build; require PASS.
- [ ] Commit `feat: add m05 operator protocol foundation`.

### Task 2: Typed Task Registry Foundation

**Files:**
- Create: `task-registry.m05.json`
- Create: `src/operator/task-registry.ts`
- Test: `tests/m05-task-registry.test.ts`

**Produces:** `loadTaskRegistry()`, immutable registry identity/digest, validated recipes.

- [ ] Write failing tests for fixed recipe IDs, typed parameters, timeout bounds, S0/S1-only metadata, and rejection of shell/command/cwd/env/executable authority.
- [ ] Run focused test and confirm RED.
- [ ] Implement deterministic validation and SHA-256 binding of the registry bytes.
- [ ] Run focused test, typecheck, build; require PASS.
- [ ] Commit `feat: add m05 typed task registry foundation`.
### Task 3: Mutually Exclusive MCP Projection

**Files:**
- Modify: `src/server.ts`
- Test: `tests/m05-operator-server.test.ts`
- Regression: `tests/server-tools-list.test.ts`, M01-M04 suites

**Produces:** gateway config `protocolMode?: 'legacy27' | 'operator13'`, default `legacy27`.

- [ ] Write failing MCP tests: `operator13` lists exactly 13 tools; status/capabilities succeed; all other Operator tools deny `TOOL_DENIED_INACTIVE_MODE`; no legacy tool appears.
- [ ] Prove default server still lists the exact M04 27-tool surface.
- [ ] Implement projection selection and inactive Operator dispatcher without calling legacy transaction/execute services.
- [ ] Run focused server tests, typecheck, build; require PASS.
- [ ] Commit `feat: add inactive operator13 gateway projection`.

### Task 4: M05 Adversarial + Qualification

**Files:**
- Create: `tests/m05-adversarial.test.ts`
- Create: `scripts/qualify-m05.ps1`

- [ ] Prove unknown Operator tools fail closed, union surface cannot be published, mutation cannot reach upstream in inactive mode, registry tamper/invalid recipe fails closed, S2 remains disabled, and legacy M04 surface remains exact.
- [ ] Run focused adversarial tests.
- [ ] Run one final full regression, typecheck, and build on committed candidate bytes.
- [ ] Freeze deterministic source manifest and perform disposable live `operator13` initialize/tools-list/status/capabilities/inactive-mutation denial only; no live mutation.
- [ ] Verify ports 8768/8769 unchanged and 8772 cleaned.
- [ ] Produce independent-review handoff bound to exact HEAD + manifest.
- [ ] Stop at `HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_READY_FOR_INDEPENDENT_VERIFICATION`; final qualification requires independent zero-blocker review.