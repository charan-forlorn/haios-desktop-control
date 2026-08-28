# M10 Staged Read-Only Cutover

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER`
**Date:** 2026-08-28
**Status:** design approved in chat; written spec awaiting explicit Human review approval
**Selected approach:** Approach A — staged dual-route read-only cutover
**Parent:** M09 `HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY_QUALIFIED`
**Parent HEAD / GitHub main:** `8496242a443ca53e99c6357023a7321cb7394e44`
**Parent manifest:** `8b6732e9163503d4d72d22ddb4cec381236c16e336019fa8b437f672b97c26c2`
**Parent final-cert SHA-256:** `7ec685bdf157f37d8d0525f7da6ec60257b189bbde5bef77731ea344ef82d946`

## 1. Objective
M10 moves only the dedicated Operator route onto the M09-certified Windows host runtime in `READ_ONLY_EMERGENCY`, while preserving the existing Docker Operator as an internal rollback lane and preserving HAIOS Secure MCP `:8768` unchanged.

M10 is a production **read-only** cutover and dogfood milestone. It does not authorize ACTIVE production mutation, S2, DESTRUCTIVE capability, generic exec/shell, production write dogfood, or a broad tunnel migration.

## 2. Current Topology and Target
Pre-cutover topology:
- `haios-tunnel-client`: `main -> haios-local-mcp:8768`, `operator -> operator-mcp:8769`.
- `haios-operator-dedicated-tunnel-client`: `main -> operator-mcp:8769`.
- `haios-operator-mcp`: internal `8769`, host-published as `127.0.0.1:8769`, mode `READ_ONLY_EMERGENCY`.

Target topology:
- shared `haios-tunnel-client` stays byte/config/runtime unchanged and continues to reach the old Operator internally.
- old `haios-operator-mcp` stays on the Docker network in `READ_ONLY_EMERGENCY` but relinquishes only the host publish of `127.0.0.1:8769`.
- M10 Windows host runtime owns `127.0.0.1:8769`, in `READ_ONLY_EMERGENCY` only.
- dedicated Operator tunnel alone routes to `http://host.docker.internal:8769/mcp` with file-backed `X-API-Key`.

## 3. Authority Boundary
The current approval authorizes this written design and subsequent non-live implementation/preflight after written-spec approval. It does **not** itself authorize the production cutover mutation.

A separate exact Human live-cutover approval is required before any of these actions:
- removing the old Operator host publish on `127.0.0.1:8769`;
- creating/enabling the production scheduled task or starting the production host runtime on `:8769`;
- recreating/reconfiguring the dedicated Operator tunnel;
- changing any durable production secret/ACL used by the new route.

Even after read-only cutover certification, ACTIVE remains a separate later authority decision.

## 4. Production Runtime Deployment
Production must not run from a mutable development worktree. M10 prepares a sealed deployment worktree at `C:\Workspace\haios-desktop-control-runtime` only at the live-cutover gate.

The deployment worktree must:
1. point to the exact M10 candidate commit;
2. have a deterministic tracked-source manifest equal to the pre-live-qualified candidate manifest;
3. have a clean detached or dedicated deployment branch with no local tracked modifications;
4. build `dist` from those exact tracked bytes;
5. contain no secret in Git, config JSON, argv, logs, or evidence.

The development worktree remains `C:\Workspace\haios-desktop-control-m10` and is never itself treated as the long-lived production installation.

## 5. Production Host Configuration
The production M10 host config is stricter than the generic M09 host config:
- `mode` must be exactly `READ_ONLY_EMERGENCY`;
- `activationScope` must be absent;
- `allowedProjects` must be exactly `{}` during M10 read-only dogfood;
- host is fixed by M09 to `127.0.0.1`;
- port is exactly `8769` only after the live gate;
- registry/effect identities remain the exact M09/M08-certified values;
- no executable, shell, cwd, env, remote Git, tunnel id/channel, Docker socket, cloud endpoint, or runtime implementation override is accepted.

## 6. Secret and ACL Model
M10 creates a new dedicated Operator API key at cutover time; it must not retrieve or reuse an existing production secret.

The resolved runtime state root is `%LOCALAPPDATA%\HAIOS\M10`. It contains:
- `operator-api-key` — random secret bytes only;
- `host-config.json` — non-secret config pointing to the key file;
- non-secret launcher/supervisor state if required.

The state root must be non-roaming and ACL-hardened for the exact Windows operator identity plus required local system/administrative principals only. Inherited broad read/write access such as `Everyone` or generic writable `Users` authority is a hard failure.

The API key must satisfy the M09 canonical-path/currentness boundary and must be mounted read-only into the dedicated tunnel container. The tunnel receives it only through file-backed `MCP_EXTRA_HEADERS` / `X-API-Key`; secret bytes must never appear in Docker args, environment dumps, JSON evidence, Git, or console output.

## 7. Windows Supervisor
M10 uses built-in Windows Task Scheduler rather than a third-party service wrapper.

Task name: `HAIOS-M10-Operator-ReadOnly`.

The task is a **user-session supervisor**, triggered at logon of the exact operator identity, runs only when that user session is available, stores no password, and is configured for restart-on-failure. It invokes only the sealed deployment launcher with one non-secret config path. M10 does not claim pre-login/headless boot service semantics.

Before live authorization, implementation may generate and validate the intended task definition but must not create or enable the production task.

Qualification must prove restart after controlled process failure and clean stop/start behavior inside the authorized read-only cutover window. A future milestone may replace the user-session supervisor with a true system service if required.

## 8. Staged Cutover Sequence
### Phase A — Non-live preflight
- bind exact M09 final certification and GitHub main ancestry;
- build M10 guard/config/supervisor tooling with TDD;
- verify Task Scheduler feasibility read-only;
- qualify ACL creation logic on disposable files only;
- run host runtime in `READ_ONLY_EMERGENCY` on disposable port `8774`;
- prove direct and disposable dev-proxy parity without touching production tunnels;
- generate rollback plan from current production preimages and hashes.

Pre-live terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_READY_FOR_EXACT_HUMAN_READ_ONLY_CUTOVER_DECISION`

### Phase B — Authorized port handoff
Only after exact Human live approval:
1. snapshot old Operator compose/container/tunnel/listener identities and hashes;
2. stop only the production host process if unexpectedly present;
3. remove only the old Operator host publish `127.0.0.1:8769`, preserving its Docker-network service and health;
4. create the sealed deployment worktree from the exact pre-live-qualified candidate commit and verify manifest equality;
5. provision ACL-hardened M10 state/config/key;
6. create/enable the exact scheduled task and start the host runtime;
7. require `127.0.0.1:8769` to answer `READ_ONLY_EMERGENCY` before touching the dedicated tunnel.

Any failure before step 7 triggers rollback and forbids tunnel mutation.

### Phase C — Dedicated tunnel switch
Reconfigure only `haios-operator-dedicated-tunnel-client`:
- preserve the same real dedicated tunnel/control-plane identity;
- change only MCP target from `operator-mcp:8769` to `host.docker.internal:8769/mcp`;
- add only the required read-only key bind mount and file-backed `X-API-Key` header;
- do not restart or modify `haios-tunnel-client`;
- do not change the Secure MCP `main` route or its `operator` channel.

The dedicated route must prove initialize, exact 13 tools, `operator_status`, and `operator_capabilities` before dogfood is considered available.

### Phase D — Read-only dogfood and fault drills
Required production observations:
- exact 13-tool surface;
- `mode=READ_ONLY_EMERGENCY`, `mutationActive=false`;
- `s2Enabled=false`, `genericExec=false`, `genericShell=false`, `destructive=LOCKED`;
- shared tunnel and `:8768` remain unchanged;
- old Operator remains healthy on the Docker network as rollback lane;
- dedicated tunnel restart reconnects to the host runtime;
- controlled host-process failure is recovered by the scheduled-task supervisor;
- bad/missing key, wrong header, port collision, stale config, and route divergence fail closed;
- no mutation/dogfood tool call is executed.

## 9. Rollback Contract
Rollback is a first-class certified path, not an operator playbook afterthought.

Rollback order:
1. stop/disable only `HAIOS-M10-Operator-ReadOnly` and confirm host `:8769` is free;
2. restore the old Operator host publish from the exact preimage and recreate only `haios-operator-mcp` if required;
3. require old `127.0.0.1:8769` health to report `READ_ONLY_EMERGENCY`;
4. restore the dedicated tunnel target/mount/header configuration to its exact pre-cutover preimage;
5. recreate only the dedicated tunnel container if required;
6. verify shared tunnel and `:8768` identities remain unchanged;
7. remove only M10-owned runtime/task/deployment residue authorized for cleanup;
8. persist post-rollback currentness evidence.

Rollback must remain executable after every live phase. If rollback currentness cannot be proven before a forward step, the forward step is prohibited.

## 10. Mutation and Preservation Rules
M10 live mutation scope is intentionally narrow:
- old Operator: host-port publishing only;
- Windows host: M10 runtime state, sealed deployment worktree, and one scheduled task;
- dedicated Operator tunnel: MCP target plus required read-only secret mount/header only.

Preserved byte/config/runtime identities include:
- `haios-tunnel-client` and its main/operator routes;
- HAIOS Secure MCP `:8768` service and listener;
- old Operator image and application bytes;
- M09/M08 task registry and effect-policy identities;
- S2 disabled and DESTRUCTIVE locked;
- no remote Git mutation, no cloud resource mutation, no Docker socket delegation to Operator.

## 11. Evidence and Qualification
Preflight and live stages produce separate evidence packages. Every package binds exact HEAD, tracked-source manifest, parent cert SHA, pre/post runtime identities, and explicit mutation scope.

The live qualification must additionally record:
- old/new `:8769` ownership transition;
- shared and dedicated tunnel pre/post deterministic digests;
- scheduled-task definition identity and principal;
- secret-file ACL facts without secret bytes;
- dedicated route tool/status/capability proof;
- fault/restart/rollback drill results;
- zero M10 container/process/worktree/runtime residue beyond the intentionally retained production deployment;
- persisted secret scan zero.

## 12. Independent Verification
After read-only dogfood and fault drills, a fresh independent read-only reviewer must verify exact candidate/runtime/evidence bytes without rerunning unchanged expensive tests unless evidence is invalid.

Required reviewer conclusions:
- parent M09 certification/currentness is exact;
- only authorized M10 surfaces changed;
- dual-route rollback lane remained available;
- dedicated route reaches the sealed Windows runtime, not the old Operator;
- shared tunnel and `:8768` were preserved;
- production runtime stayed `READ_ONLY_EMERGENCY` throughout;
- secret and ACL boundaries are fail closed;
- restart and rollback are executable and current;
- no ACTIVE/S2/DESTRUCTIVE/dogfood mutation authority was introduced;
- blocker count is zero.

Final terminal on zero blockers plus fresh post-review currentness:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER_QUALIFIED`

Rollback terminal if forward qualification fails but exact recovery succeeds:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_ROLLED_BACK_TO_CERTIFIED_M09_READ_ONLY_STATE`

## 13. Explicit Non-Goals
M10 does not:
- activate production `ACTIVE` mode;
- add `M10_TEST_ONLY` or any production activation scope;
- enable S2 or unlock DESTRUCTIVE;
- perform production write/mutate dogfood;
- replace or modify the shared Secure MCP tunnel;
- migrate `:8768`;
- introduce a third-party Windows service wrapper;
- claim pre-login/headless boot service semantics;
- remove the old Operator rollback lane during the read-only certification window.

A later activation milestone must separately authorize and qualify production ACTIVE behavior after M10 read-only production currentness is certified.
