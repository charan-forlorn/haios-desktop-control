# M02 Controlled Execute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task with TDD.

**Goal:** Add six fixed, bounded execute profiles while preserving M01 READ and keeping MUTATE/DESTRUCTIVE locked.

**Architecture:** HAIOS owns all downstream schemas and command templates. Desktop Commander raw `start_process` is an internal transport primitive only; clients cannot supply command strings or arbitrary paths. Every execution validates profile input, captures tracked-state currentness, bounds time/output, and audits the result.

**Tech Stack:** Existing Node 24 / TypeScript 7 / MCP SDK 1.30.0 / Vitest 4.1.11 / Desktop Commander 0.2.47.

**Spec:** `docs/superpowers/specs/2026-08-28-m02-controlled-execute-design.md`

## Global Constraints
- M01 READ remains qualified and unchanged.
- Execute pilot root is exactly `C:\Workspace\haios-desktop-control`.
- No downstream raw shell or command-string input.
- MUTATE and DESTRUCTIVE remain locked.
- Tracked-state mutation count must remain zero.
- No Tunnel mutation in M02.
## Task 1 — Execute capability registry

**Files:** modify `src/capabilities.ts`, `src/policy.ts`, `src/server.ts`; create `tests/execute-capability.test.ts`.

**Produces:** immutable `EXECUTE_TOOL_DEFINITIONS`; classification `READ | EXECUTE | UNKNOWN`; exact six-tool execute schemas.

- [ ] Write RED tests asserting exactly `project_test`, `project_typecheck`, `project_build`, `git_status`, `git_diff`, `git_log` classify EXECUTE.
- [ ] Assert raw `start_process`, arbitrary shell names, MUTATE/DESTRUCTIVE names remain UNKNOWN/DENY.
- [ ] Assert `git_diff.mode` only accepts `working|staged` and `git_log.maxCount` only integer 1..20.
- [ ] Run only `tests/execute-capability.test.ts` and confirm RED because EXECUTE registry is absent.
- [ ] Implement minimal registry/schema changes; keep the existing 12 READ names byte-semantic equivalent.
- [ ] Run focused test, full tests, typecheck, build; commit.

## Task 2 — Internal Desktop Commander execution transport

**Files:** modify `src/upstream.ts`; create `src/execute-profiles.ts`, `tests/execute-profiles.test.ts`.

**Produces:** `startProcess(command, timeoutMs)` internal adapter and fixed `EXECUTION_PROFILES` mapping with no client-controlled command text.
- [ ] Write RED tests proving profile commands are fixed to the spec and expose no free-form command/path field.
- [ ] Add raw upstream `start_process` adapter using `timeout_ms <= 180000`; do not expose it in downstream registry.
- [ ] Implement fixed commands from the exact project root; only validated `mode` and numeric `maxCount` may select predefined variants.
- [ ] Add output normalization without persisting command output in audit.
- [ ] Verify raw `start_process` cannot be requested downstream; run focused/full/typecheck/build; commit.

## Task 3 — Guarded execute dispatcher and currentness

**Files:** create `src/execute.ts`, `tests/execute-guard.test.ts`; modify `src/server.ts`, `src/audit.ts`.

**Produces:** `dispatchExecuteTool(name,args,context)` and pre/post tracked-state digest checks.

- [ ] Write RED tests for valid profiles, invalid properties, metacharacter payloads, invalid counts/modes, timeout/output bounds, and zero upstream calls on denial.
- [ ] Capture deterministic tracked Git state before execution and after completion; identical state is mandatory for success.
- [ ] Treat ignored/regenerable runtime output as non-source state, while Git index/ref/tracked diff changes cause `UNAUTHORIZED_MUTATION_DETECTED`.
- [ ] Poll only the PID returned by the gateway-owned start call using internal `read_process_output`; never accept a client PID.
- [ ] On hard timeout only, use internal `kill_process` against that exact gateway-owned PID and verify cleanup; never expose termination downstream.
- [ ] Bound captured execution output to 64 KiB with explicit truncation metadata and record exit/result class.
- [ ] Route EXECUTE tools through auth/classification before internal upstream dispatch; metadata-only audit remains enforced.
- [ ] Run focused/full/typecheck/build and M01 regression; commit.
## Task 4 — M02 adversarial/live qualification

**Files:** create `tests/m02-adversarial.test.ts`, `scripts/qualify-m02.ps1`; generate append-only `evidence/m02/<run-id>/`.

**Produces:** machine-readable qualification result and independent-review boundary.

- [ ] Prove injection strings, extra properties, arbitrary paths/commands, raw start_process, interactive/termination/mutation tools all fail before upstream.
- [ ] Run full M01+M02 tests, typecheck, build; require clean committed HEAD before live qualification.
- [ ] Start M02 gateway transiently and execute all six profiles through real Desktop Commander 0.2.47.
- [ ] Record pre/post tracked-state digests and require zero unauthorized tracked mutations.
- [ ] Verify output/time bounds, cleanup, M01 READ 12/12 regression, ports 8768/8769 PASS and qualification ports clean.
- [ ] Persist hashes/results without command output secrets; perform a fresh read-only independent review without redundant test reruns.
- [ ] Emit `HAIOS_DESKTOP_CONTROL_PLANE_R1_M02_CONTROLLED_EXECUTE_QUALIFIED` only with 0 blocking findings; otherwise fail closed.

## Promotion Boundary

Successful M02 qualifies CONTROLLED EXECUTE only. It may unlock design work for transactional MUTATE, but does not grant arbitrary shell, file mutation, process termination, configuration changes, production mutation, or privileged OS actions.
