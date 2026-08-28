# M04 Safe Remove Design

**Status:** implementation candidate
**Date:** 2026-08-28
**Baseline:** M03 terminal `HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_TRANSACTIONAL_MUTATE_QUALIFIED`

## 1. Objective

Extend the qualified transactional MUTATE plane with one reversible file-removal intent while keeping DESTRUCTIVE locked. M04 satisfies the approved Level B requirement to safely remove eligible engineering files without exposing raw delete, arbitrary shell, process termination, privileged configuration, or canonical/user-data destruction.

## 2. Capability Boundary

M04 adds exactly one downstream tool: `transaction_stage_remove`.

The downstream surface becomes 12 READ + 6 EXECUTE + 9 MUTATE = 27 tools. `delete`, `unlink`, `rm`, raw `move_file`, `kill_process`, `force_terminate`, and config mutation remain absent.

Safe remove stays in MUTATE because the canonical path change is transaction-owned, reversible before promotion, project-scoped, preimage-bound, verified, and rollback-capable. DESTRUCTIVE remains locked.

## 3. Remove Contract

`transaction_stage_remove` accepts exactly `transactionId`, `path`, and `expectedSha256` as strings. Unknown fields, invalid hashes, outside-project paths, sensitive paths, traversal, UNC/path tricks, reparse escapes, directories, and non-regular files fail closed.

The expected hash binds staging to the exact current file bytes. Validation and apply retain existing HEAD/tracked-state currentness checks.

## 4. Quarantine Architecture

No upstream delete primitive is introduced. Apply captures the preimage in the existing rollback bundle and moves the source through the internal mutation adapter to a transaction-owned quarantine path under `runtime/<transaction-id>/quarantine/`.

The quarantine path is generated server-side from a SHA-256 of the normalized source path. Clients never provide or observe a writable quarantine path.

After move, verification requires the canonical source to be absent and the quarantine bytes to match the exact preimage hash. Promotion removes the entire transaction runtime directory only after the focused verification profile passes.

## 5. Rollback

Rollback for remove requires: canonical source absent, quarantine present, quarantine hash equal to the captured preimage, and no external recreation at the source path. If any condition conflicts, return `ROLLBACK_CONFLICT` and never overwrite external bytes.

A valid rollback moves quarantine back to the exact canonical source path. Verification failure therefore restores exact source bytes before entering `ROLLED_BACK`.

## 6. Intent Conflicts

A remove intent conflicts with any create/replace/move/remove intent that references the same canonical path in the same transaction. Existing transaction replay and state-machine rules remain unchanged.

## 7. Evidence and Secrecy

Status/audit remain metadata-only. File content and quarantine bytes are never emitted through MCP status or evidence. Transaction runtime material is removed after PROMOTED or successful ROLLED_BACK.

## 8. Qualification Gates

M04 requires: focused RED/GREEN tests, regular-file-only enforcement, expected-hash enforcement, reparse/sensitive/outside denial, mixed-intent conflict denial, quarantine exactness, promotion cleanup, verification-failure exact rollback, rollback-conflict preservation, raw-delete absence, M01-M03 regression, typecheck/build, disposable live remove through MCP, exact namespace restoration, tunnel integrity, secret persistence false, and independent read-only review bound to exact HEAD + manifest.

## 9. Terminal

Only after zero critical/blocking findings: `HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_SAFE_REMOVE_QUALIFIED`.

Final capability target: READ=QUALIFIED, CONTROLLED_EXECUTE=QUALIFIED, MUTATE=QUALIFIED_WITH_SAFE_REMOVE, DESTRUCTIVE=LOCKED.
