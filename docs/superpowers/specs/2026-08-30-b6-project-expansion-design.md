# B6 Project Expansion Design

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_PROJECT_EXPANSION`

B6 reuses final M12 B5 transaction/effect/remediation/recovery and exact 13-tool semantics without authority expansion. Admission is strictly ordered: `SKILL_FABRIC`, then `HERMES_OS`.

## Closed authority

Server-owned mappings are the only admissible roots:
- `operator-canary` → `C:\Workspace\haios-operator-canary`
- `skill-fabric` → `C:\Workspace\haios-skill-fabric`
- `hermes-os` → `C:\Workspace\hermes-ai-operating-system-b6-canonical`

`SKILL_FABRIC` admits only operator-canary + skill-fabric. `HERMES_OS` admits all three only after current Stage-1 certification. No caller-selected root, command, S2, generic exec/shell, destructive, remote Git, tunnel, or key authority is admitted.

## Stage-1 certification and currentness

Stage 1 is not certified from public JSON fields alone. Its durable certificate binds the frozen B6 HEAD/tracked count/physical manifest; skill-fabric canonical path, git-common-dir identity, HEAD/tracked count/physical manifest; exact live qualification evidence bytes/hash; PASS, exact 13 tools, target admission, hermes-os denial, clean pre/post HEAD/status, zero owned residue, effect-policy verification, network `NONE`, recovery classification `SAFE_TO_ROLLBACK`, creation timestamp, and digest over the complete unsigned certificate.

Stage-2 preflight independently recomputes current B6 and skill-fabric Git/filesystem facts and re-reads/re-hashes the fixed Stage-1 evidence artifact. Missing, malformed, stale, forged, dirty, mismatched, or extra fields fail closed. The physical-manifest algorithm is deterministic sorted tracked paths encoded as `<file_sha256>  <path>\n`.

## Qualification recipe

For each target the orchestrator verifies exact 13 tools, starts an isolated transaction, stages one temporary `node:test` fixture, applies it, runs only registry task `node.test.run` in S0 with no network, verifies effect policy, and rolls back. Canonical HEAD/status must be unchanged and owned residue must be zero. Stage 1 also proves `hermes-os` denied; Stage 2 independently proves `skill-fabric` and `hermes-os` while retaining operator-canary regression coverage.

## Activation and recovery

Live checkpointing, activation, rollback, dogfood, certification, and deterministic seals are orchestrator actions. Stage-1 rollback restores certified M12. Stage-2 rollback restores qualified B6 Stage 1. `VERIFIED_PRESERVED` state is never blindly deleted; uncertain/partial state requires exact ownership proof and fail-closed reconciliation.
