# M05 Level B Protocol Reconciliation + Task Registry Foundation

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_LEVEL_B_PROTOCOL_RECONCILIATION`
**Status:** approved implementation design
**Date:** 2026-08-28
**Baseline:** M04 terminal `HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_SAFE_REMOVE_QUALIFIED`
**Authoritative external contract:** HAIOS Engineering Autonomy Level B R1.2

## 1. Objective

Reconcile the M01-M04 27-tool Desktop Control Plane with the Human-approved Level B v1 protocol without claiming Level B mutation authority before its isolation invariants exist.

M05 introduces an exact 13-tool Operator protocol model and a validated typed task-registry foundation. It does **not** activate Operator mutation, execute transaction-modified code, create local Git checkpoints, or promote canonical source.

## 2. Architectural Decision

The existing 27-tool surface remains a separately qualified `legacy27` protocol used only for M01-M04 regression and direct Desktop Commander gateway qualification.

A new `operator13` protocol mode exposes exactly the Level B R1.2 names. In M05 its runtime mode is fixed to `READ_ONLY_EMERGENCY`: only `operator_status` and `operator_capabilities` may succeed; the remaining 11 tools fail closed before reaching mutation/execute adapters.
## 3. Exact Operator v1 Surface

The `operator13` surface is exactly:

1. `operator_status`
2. `operator_capabilities`
3. `operator_begin_transaction`
4. `operator_stage_patch`
5. `operator_stage_create`
6. `operator_stage_move`
7. `operator_stage_remove`
8. `operator_validate_transaction`
9. `operator_apply_transaction`
10. `operator_run_task`
11. `operator_rollback_transaction`
12. `operator_git_checkpoint`
13. `operator_promote_transaction`

No generic shell, generic command string, arbitrary executable, arbitrary cwd/env, secret retrieval, remote Git mutation, cloud mutation, production mutation, process termination, or privileged configuration is added.

## 4. Protocol Separation

`legacy27` and `operator13` are mutually exclusive public projections. A server instance must list one projection only; it must never publish the union of both surfaces.

`legacy27` behavior remains byte-compatible with M04 unless a concrete M05 regression fix is required. `operator13` is a compatibility/foundation projection and must not reuse M04's direct canonical mutation as if it were Level B isolation.
## 5. Task Registry Foundation

M05 adds a versioned immutable task registry with fixed recipe IDs, fixed executable/argv templates, typed parameter definitions, fixed timeout, sandbox-profile metadata, and effect-policy identity.

For M05, recipes are configuration only. No recipe can execute through `operator13` because the Operator is inactive and the isolated worktree/sandbox runner is not yet qualified.

Validation fails closed if a recipe contains command strings, `shell=true`, caller-controlled executable/cwd/environment, unknown sandbox profiles, missing effect-policy identity, duplicate IDs, or unbounded timeout.

## 6. Runtime Status Contract

`operator_status` returns protocol identity, mode `READ_ONLY_EMERGENCY`, M05 qualification state, and destructive capability `LOCKED`.

`operator_capabilities` reports exact tool count 13, task-registry identity, S2 disabled, mutation active false, checkpoint qualified false, promotion qualified false, and no generic shell/exec.

The other 11 Operator tools return a deterministic inactive-mode denial without dispatching legacy mutation/execute code.

## 7. Future M06 Boundary

M06 may activate implementation work only after adding transaction-owned isolated Git worktrees, transaction state binding, local-only Git checkpoint, and compare-and-swap promotion. Canonical mutation through `operator_promote_transaction` must be the only normal Operator promotion path before Operator mutation can be qualified.

M05 must therefore preserve `DESTRUCTIVE=LOCKED` and `OPERATOR_MUTATION_ACTIVE=false`.