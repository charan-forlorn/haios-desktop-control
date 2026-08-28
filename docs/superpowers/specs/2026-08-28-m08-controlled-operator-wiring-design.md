# M08 Controlled Operator Wiring

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_CONTROLLED_OPERATOR_WIRING`
**Status:** implementation-authorized by the current Human instruction to proceed directly after certified M07
**Date:** 2026-08-28
**Parent milestone:** M07 `HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_BOUNDED_TASK_RUNNER_QUALIFIED`
**Parent HEAD:** `9a14ad42e31dbf43306d90b1f9ec98ce3c1c38e0`
**Parent source manifest:** `f7e6b1bdba4f4b9c78ea697d5761dd9680865cdc75248a0f87523e7820692e96`
**Parent final-cert SHA-256:** `a6b58a86a4d60b5ee71dbab4672ad89c16ab5b3f30392d04eec8c03253e12533`
**Authoritative lineage:** HAIOS Engineering Autonomy Level B R1.2 + certified M05/M06/M07 primitives

## 1. Objective
M08 wires only the previously qualified M05 exact 13-tool protocol, M06 isolated transaction/checkpoint/CAS service, and M07 bounded S0/S1 task runner into one controlled Operator runtime.

M08 qualifies the routing and activation boundary. It does **not** yet switch the long-lived dedicated Operator service on port 8769 into ACTIVE production behavior. Long-lived activation/dogfood remains a later gate after this wiring is independently certified.

## 2. Architectural Decision
Three approaches were considered:

1. **Dedicated typed Operator runtime dispatcher — selected.** Keep M05 foundation projection, M06 service, and M07 runner separate; add one narrow dispatcher that maps the 11 non-read Operator tools to those certified primitives. `src/server.ts` may select this dispatcher only through an explicit `operatorMode: "ACTIVE"` plus an injected qualified runtime.
2. Extend `dispatchOperatorFoundationTool()` with mutation logic. Rejected because it would mix the M05 fail-closed foundation and activation authority in one module and weaken regression separation.
3. Put all routing directly in `src/server.ts`. Rejected because it would make the HTTP/MCP transport own transaction/task semantics and create a broad, hard-to-review authority boundary.

The selected design keeps transport, protocol projection, runtime routing, transaction isolation, and task execution independently testable.

## 3. Public Surface and Mode Gate
The public `operator13` projection remains exactly the 13 Level B v1 tools and never unions with `legacy27`.

Default behavior remains byte-compatible with M05-M07:
- `protocolMode="operator13"` with no explicit active runtime => `READ_ONLY_EMERGENCY`;
- `operator_status` and `operator_capabilities` succeed;
- the other 11 tools return `TOOL_DENIED_INACTIVE_MODE`;
- no M06/M07 dispatcher is reached.

Controlled active wiring requires **both**:
- `operatorMode="ACTIVE"`;
- an injected M08 `OperatorControlRuntime` built from qualified primitives.

`ACTIVE` without a runtime fails server creation. Supplying an active runtime without explicit `ACTIVE` also fails closed. `legacy27` cannot accept Operator activation configuration.

No caller input can select or change Operator mode.

## 4. Runtime Dispatcher
Create `src/operator/control-runtime.ts` as the sole M08 active routing entrypoint.

It accepts exact-key argument objects and maps:
- `operator_begin_transaction` -> M06 `begin`;
- `operator_stage_patch` -> M06 `stagePatch`;
- `operator_stage_create` -> M06 `stageCreate`;
- `operator_stage_move` -> M06 `stageMove`;
- `operator_stage_remove` -> M06 `stageRemove`;
- `operator_validate_transaction` -> M06 `validate`;
- `operator_apply_transaction` -> M06 `apply`;
- `operator_run_task` -> M07 `OperatorTaskRunner.run`;
- `operator_rollback_transaction` -> M06 `rollback`;
- `operator_git_checkpoint` -> M06 `checkpoint`;
- `operator_promote_transaction` -> M06 `promote`.

Status/capabilities in ACTIVE mode report exact M08 runtime identities and never claim S2, remote Git, destructive authority, generic shell, arbitrary executable/cwd/env, secret retrieval, cloud, production, process termination, or privileged configuration.

Unknown fields or wrong types fail before a primitive is called.

## 5. Server-Bound Task Currentness
The public Level B `operator_run_task` schema remains `{txId, taskId, params}`. The caller does not control `expectedRegistrySha256`.

M08 injects the exact M07 registry SHA-256 held by the active runtime when calling the M07 runner. The runner independently rechecks that digest against its bound registry and separately checks the qualified effect-policy digest.

This preserves M07 currentness while reducing public authority: a caller cannot select an older/newer registry digest or bypass the server-qualified identity.

## 6. Transaction and Project Authority
M08 does not weaken M06 project/root policy. `operator_begin_transaction` may carry the existing Level B `projectId` and `canonicalRoot`, but M06 must independently resolve the configured project allowlist, realpath both values, and require an exact match before creating a transaction worktree.

All staging, validation, apply, task, checkpoint, rollback, and promotion calls use server-owned transaction state. Canonical source remains unchanged until a valid CAS promotion.

## 7. Capability Classification and Audit
Runtime dispatch returns a fixed capability class per tool:
- READ: `operator_status`, `operator_capabilities`;
- EXECUTE: `operator_run_task`;
- MUTATE: transaction begin/stage/validate/apply/rollback/checkpoint/promote.

`DESTRUCTIVE` remains `LOCKED`; no Operator tool is classified DESTRUCTIVE in M08.

The existing metadata-only MCP audit path records tool, capability class, decision, result class, and duration. It must not persist staged contents, stdout secrets, credentials, API keys, or raw environment values.

## 8. Activation Boundary
M08 live qualification may start a **disposable loopback server on port 8772** in `ACTIVE` mode using a synthetic local Git repository, generated worktree root, M06 local-only Git wrapper, M07 pinned Docker sandbox, exact M07 task registry/effect policy, and no production credentials.

The long-lived existing listeners/tunnels on 8768/8769 remain unchanged throughout M08.

After M08 certification, the default/dedicated Operator production runtime remains `READ_ONLY_EMERGENCY` until a separate activation/dogfood decision proves the long-lived launcher/config uses the certified M08 identities.

## 9. Live Qualification Flow
The disposable active runtime must prove through the MCP surface, not direct method calls only:
1. initialize and list exactly 13 tools;
2. status/capabilities report controlled ACTIVE with S2 disabled and DESTRUCTIVE locked;
3. begin a synthetic allowlisted transaction;
4. stage + validate + apply a bounded source change in the transaction worktree;
5. canonical HEAD/bytes remain unchanged;
6. execute a qualified S0 task through `operator_run_task`;
7. create a local-only checkpoint;
8. promote through exact expected-HEAD + checkpoint CAS;
9. verify canonical fast-forward to exactly the checkpoint and clean status;
10. exercise a separate rollback transaction and prove zero worktree/branch residue;
11. exercise stale-CAS denial with zero canonical mutation;
12. prove inactive-mode server still denies all 11 non-read tools with zero active dispatch;
13. prove all 13 input boundaries reject undeclared fields and no raw legacy tool appears.

No remote Git operation, package download, cloud mutation, credential use, or production path is permitted.

## 10. Source Boundary
Expected focused changes:
- create `src/operator/control-runtime.ts`;
- minimally extend `src/server.ts` with explicit `operatorMode` + injected active runtime selection;
- minimally extend M08 status/capability metadata without weakening M05 foundation behavior;
- add `tests/m08-operator-runtime.test.ts`;
- add `tests/m08-operator-server.test.ts`;
- add `tests/m08-adversarial.test.ts`;
- add a deterministic disposable live qualification helper/script;
- add M08 qualification/evidence packaging.

Do not modify M06/M07 security primitives unless a concrete wiring blocker is proven. Any such delta requires focused regression of the affected certified milestone.

## 11. Qualification Gates
M08 must prove:
1. exact M07 parent ancestry and current M07 final-cert binding;
2. exact 13-tool public projection, no union with legacy27;
3. default Operator remains `READ_ONLY_EMERGENCY`;
4. active mode requires an explicit qualified runtime and cannot be caller-selected;
5. exact-key dispatch for all 11 active non-read tools;
6. M06 service is the only transaction/checkpoint/promotion backend;
7. M07 runner is the only task backend;
8. public run-task currentness is server-bound to exact M07 registry identity;
9. S0/S1 only, S2 disabled;
10. no generic shell/exec/cwd/env, remote Git, secrets, cloud/production, termination, or privileged configuration authority;
11. canonical source changes only at valid M06 CAS promotion;
12. stale CAS and rollback remain fail-closed;
13. live MCP ACTIVE flow succeeds only in disposable synthetic scope;
14. existing 8768/8769 tunnel/runtime identities remain unchanged and 8772 ends free;
15. Docker/worktree/runtime residue is zero;
16. persisted secret-pattern hits are zero;
17. one final full regression/typecheck/build runs on frozen candidate bytes;
18. deterministic tracked-source manifest is stable pre/post live qualification;
19. fresh independent read-only review returns zero blockers.

## 12. Exit State
If all gates pass, M08 may certify only:
- exact 13-tool controlled routing = qualified;
- M06 transaction/checkpoint/CAS wiring = qualified;
- M07 bounded task-runner wiring = qualified;
- disposable ACTIVE-mode MCP flow = qualified;
- default/long-lived Operator runtime = still `READ_ONLY_EMERGENCY`;
- S2 = disabled;
- DESTRUCTIVE = locked;
- production/dogfood activation = not yet performed.

Pre-review terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_READY_FOR_INDEPENDENT_VERIFICATION`

Final zero-blocker terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_CONTROLLED_OPERATOR_WIRING_QUALIFIED`
