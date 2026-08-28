# M03 Transactional Mutate Design

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_TRANSACTIONAL_MUTATE`

## Goal

Extend the certified M02 gateway with project-scoped transactional mutation while preserving M01 READ and M02 CONTROLLED EXECUTE exactly.

M03 permits source changes only through a closed transaction lifecycle. Raw Desktop Commander write/edit/move/delete tools remain absent from the downstream MCP surface.

## Authority boundary

M03 authority is limited to:

- project root `C:\Workspace\haios-desktop-control`
- tracked source/test/docs files plus explicitly staged creates inside the project
- create, replace/edit, and move operations represented as typed transaction intents
- validation and rollback performed by the gateway

M03 does not authorize production, OS, service, Docker, credential, ACL, registry, billing, public exposure, or arbitrary destructive operations.
## Downstream mutation surface

M03 adds typed wrappers only:

- `transaction_begin`
- `transaction_stage_create`
- `transaction_stage_replace`
- `transaction_stage_move`
- `transaction_validate`
- `transaction_apply`
- `transaction_rollback`
- `transaction_status`

There is no downstream `write_file`, `edit_block`, `move_file`, `kill_process`, `start_process`, `set_config_value`, or free-form command field.

Each mutation wrapper requires a server-issued `transactionId`. Apply and rollback operate only on the exact staged transaction and cannot accept arbitrary paths or bytes outside it.

## State machine

`OPEN -> STAGED -> VALIDATED -> APPLYING -> APPLIED -> VERIFIED -> PROMOTED`

Failure after the first mutation in `APPLYING`, or after `APPLIED`, transitions through `ROLLBACK_REQUIRED -> ROLLED_BACK`. Invalid transitions fail closed and perform zero upstream mutation.
## Currentness and preimage contract

`transaction_begin` captures:

- exact Git HEAD
- symbolic branch
- tracked-state digest
- transaction creation time and bounded identifier

Every staged existing path captures SHA-256 and original bytes before apply. `transaction_validate` rechecks HEAD, tracked-state digest, path authority, duplicate/conflicting intents, and preimages. Any drift returns `STALE_TRANSACTION` and performs zero mutation.

Immediately before apply the same CAS checks run again. No approval inferred from an earlier state survives currentness drift.

## Mutation rules

Create requires the destination to be absent. Replace requires an exact expected preimage hash. Move requires an existing authorized source and absent authorized destination.

All paths pass the existing workspace, sensitive-path, traversal, normalization, and reparse protections. `.git`, `.env*`, credential/secret paths, key material, and any path outside the project are denied.

M03 intentionally excludes delete. Removal is deferred to the later privileged/destructive capability class.
## Apply and rollback

Apply uses only internal Desktop Commander filesystem primitives mapped from the validated staged intents. Before the first mutation the complete rollback bundle is durable in the transaction runtime directory.

After apply, the gateway verifies intended byte hashes and runs a bounded verification profile. Any apply error, hash mismatch, timeout, non-zero verification result, or unexpected tracked-state delta triggers rollback automatically.

Rollback restores replaced files byte-exact, reverses moves, and removes only files created by the same transaction. It must never delete or overwrite a path whose current bytes no longer match the transaction-owned applied bytes; that condition fails closed as `ROLLBACK_CONFLICT`.

## Verification and promotion

A transaction is `VERIFIED` only when:

- all intended postimage hashes match
- no unauthorized tracked path changed
- focused verification passes
- M01 READ and M02 EXECUTE security invariants remain intact

Promotion records durable evidence and closes the transaction. Promotion does not perform Git push, production deployment, or external publication.
## Durable evidence

Each transaction records metadata-only lifecycle evidence plus hashes. Raw secrets are never written to audit/evidence. Preimage bytes used for rollback stay under a transaction-private runtime area and are removed after a successfully sealed promotion; failed transactions retain only the minimum bounded recovery evidence required by the rollback state.

M03 qualification evidence must prove zero unauthorized mutations and byte-exact rollback on injected failure.

## M03 qualification gates

- exact typed mutation surface and raw mutation tools absent
- state-machine transition and replay rejection tests PASS
- path/sensitive/reparse adversarial tests PASS
- HEAD + tracked-state CAS and stale-transaction tests PASS
- create/replace/move positive tests PASS in disposable fixtures
- apply failure triggers rollback PASS
- rollback byte-exact PASS
- rollback conflict fails closed PASS
- unexpected tracked-file mutation detection PASS
- focused verification failure rollback PASS
- M01 and M02 full regression PASS
- tunnel configuration integrity unchanged
- ephemeral credentials not persisted
- independent read-only verification PASS

`MUTATE` remains `QUALIFIED_CANDIDATE` until every gate passes. `DESTRUCTIVE` stays `LOCKED` throughout M03.

## Terminal

`HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_TRANSACTIONAL_MUTATE_QUALIFIED`
