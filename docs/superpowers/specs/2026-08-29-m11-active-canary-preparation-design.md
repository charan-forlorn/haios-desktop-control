# HAIOS Desktop Control Plane R1 — M11 Active Canary Preparation Design

## 1. Purpose
M11 prepares the certified control plane for the first production `ACTIVE` canary without activating production during implementation or pre-live qualification.

Parent candidate: `f476f719be42ee40fe6ae5358930dc1662a95d3e` (M10 supervisor-remediated candidate).

M10 production remains authoritative and live as `READ_ONLY_EMERGENCY` on `127.0.0.1:8769` throughout M11 pre-live work. The dedicated tunnel remains pointed at `host.docker.internal:8769`; the shared Secure MCP route on `:8768` is immutable.

M11 may proceed in parallel with the unresolved M10 remote ChatGPT-app dispatch proof, but live M11 activation is hard-blocked until M10 reaches its zero-blocker final terminal.

## 2. Target Capability
M11 introduces a production-only ACTIVE-canary authority envelope with exactly one project:

`operator-canary -> C:\Workspace\haios-operator-canary`

The runtime exposes the existing exact 13 Operator tools. `mutationActive=true` only under the M11 canary authority. The existing M07 task registry is reused unchanged and contains S0/no-network tasks only.

M11 does not create generic shell/exec, S2, DESTRUCTIVE authority, remote Git mutation, cloud mutation, deployment authority, credential authority, or arbitrary project admission.
## 3. Authority Boundary
Pre-live implementation may create source, tests, documentation, synthetic fixtures, disposable runtimes, and an exact activation/rollback package. It must not change the live M10 task, live `:8769`, dedicated tunnel configuration, M10 API key ACL/content, shared tunnel, or canonical `haios-operator-canary` bytes.

Live activation requires the exact Human decision:

`APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_ACTIVATION`

The live executor must additionally prove the M10 final certification terminal is current before the first production mutation. Historical approval, an M10 pre-live seal, or the current forward-cutover state is insufficient.

## 4. M11 Production Config
Create a dedicated validator that accepts only:
- `apiKeyFile`: exact existing M10 API-key file path, file-backed only;
- `worktreeRoot`: exact M11 transaction-worktree root;
- `allowedProjects`: exactly one own-property entry named `operator-canary` with canonical root `C:\Workspace\haios-operator-canary`;
- `port`: exactly `8769` for live config, disposable high port for test-only config through an explicit fixture constructor;
- `mode`: exactly `ACTIVE`;
- `activationScope`: exactly `M11_CANARY_ONLY`.

Unknown fields, prototype/inherited properties, alternate project IDs, alternate roots, inline API keys, arbitrary ports in production, or any other activation scope fail closed.
## 5. Runtime Construction
M11 uses a dedicated ACTIVE-canary launcher/runtime wrapper. It must not weaken or repurpose the M09 `M09_TEST_ONLY` validator and must not broaden the strict M10 read-only wrapper.

The M11 runtime loads the existing qualified M08/M06/M07 runtime identities, binds only `127.0.0.1`, admits only `operator-canary`, and reports readiness metadata containing `mode=ACTIVE`, `activationScope=M11_CANARY_ONLY`, exact registry/effect-policy identities, `s2Enabled=false`, `genericExec=false`, `genericShell=false`, and `destructive=LOCKED`.

No upstream Desktop Commander read/write surface is exposed through the Operator protocol. All mutation remains transaction-owned and all task execution remains registry-owned.

## 6. Disposable ACTIVE Qualification
Before any production activation, M11 must prove the full ACTIVE path on a disposable Git repository and disposable port:
1. exact 13-tool surface;
2. ACTIVE canary readiness metadata;
3. begin → stage → validate → apply;
4. canonical unchanged before promotion;
5. S0 task execution with network denied;
6. local checkpoint;
7. ff-only expected-HEAD/CAS promotion;
8. stale-CAS denial with zero canonical mutation;
9. explicit rollback path;
10. zero worktree/container/network/runtime residue;
11. secret-output and protected-path denial remain current.

The real `C:\Workspace\haios-operator-canary` repository is read-only during this qualification.
## 7. Live Activation Transaction
The pre-live package prepares but does not execute a transactional activation:
- verify exact M11 candidate manifest and clean deployment source;
- verify current M10 final certification and live M10 read-only state;
- verify `operator-canary` root/branch/current HEAD and clean tracked state;
- materialize a sealed deployment at the exact M11 commit;
- create M11 state/config without changing the M10 key bytes;
- register an M11 scheduled task bound to an M11-specific bounded supervisor, but do not start it before the Human gate;
- at activation, stop M10 task, free `:8769`, start M11 ACTIVE task, and authenticate exact 13-tool/status/capability probes;
- keep the dedicated tunnel route unchanged because its backend remains `host.docker.internal:8769`.

Failure after mutation begins triggers automatic rollback to the exact M10 deployment/task/runtime preimage.

## 8. Canary Dogfood Boundary
The first live canary transaction, after separate activation authority, may target only `operator-canary`. The transaction must bind the current canonical HEAD at begin and use expected-HEAD/CAS promotion. No force update, push, fetch, pull, cloud call, S2 task, or destructive authority is permitted.

M11 certification requires at least one successful local canary transaction plus one stale-CAS negative transaction and one rollback/recovery exercise before the system may progress to broader Level-B dogfood.

## 9. Evidence
Pre-live evidence must include source manifest, focused/full test results, config negative matrix, disposable ACTIVE E2E result, M10-preservation proof, canary-preimage proof, activation transaction static proof, rollback static proof, secret scan, and an exact Human activation decision envelope.

No evidence may contain API-key bytes, tunnel credentials, raw secrets, or unrestricted host paths beyond the already-governed canonical project/deployment paths.
## 10. Qualification and Terminals
Pre-live qualification requires committed clean bytes, focused M11 tests, one final full regression after the final source mutation, typecheck/build, disposable ACTIVE E2E, zero unauthorized production mutation, and independent exact-byte review with zero blockers.

Pre-live terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_READY_FOR_EXACT_HUMAN_ACTIVATION_DECISION`

Live qualified terminal, only after the exact Human activation and live canary dogfood gates:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED`

Rollback terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ROLLED_BACK_TO_CERTIFIED_M10_READ_ONLY_STATE`

## 11. Explicit Non-Goals
M11 does not enable S2, unlock DESTRUCTIVE, expose arbitrary shell/exec, admit additional projects, mutate remote Git, deploy external workloads, mutate cloud resources, rotate the M10 API key, modify the shared Secure MCP tunnel, remove the old Docker Operator rollback lane, or claim Full Capability.

Those authorities are later capability-expansion milestones after canary stability is proven.
