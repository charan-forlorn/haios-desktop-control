# M07 Internal Bounded Task Runner S0/S1
**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_BOUNDED_TASK_RUNNER`
**Status:** APPROVED — IMPLEMENTATION AUTHORIZED
**Date:** 2026-08-28
**Approach:** A — qualify an internal bounded runner before any public Operator activation
**Parent milestone:** M06 `HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_ISOLATED_CHECKPOINT_CAS_QUALIFIED`
**Parent HEAD:** `7b8e39f92e8444264a56a8f0e214095a25bf9016`
**Parent source manifest:** `4105dde2361e8ebccb743d698dede5698dc1a65b5bc8415d9c88fdc171a75021`
**Parent final-cert SHA256:** `42a3bcdc84fcf10c903147fe811702a3313d001ced51807baaa3e0d4ccd2c749`

## 1. Objective
M07 qualifies the bounded task-execution primitive required by Level B before `operator_run_task` can be wired or activated.
The runner consumes only a hash-bound typed task registry, caller task ID, typed parameters, and an existing M06 transaction worktree identity.
It resolves a fixed executable and argv, executes only inside the transaction-owned worktree, enforces S0/S1 policy, bounds output and lifetime, and verifies post-task effects.

M07 remains an internal foundation milestone.
It does **not** activate public `operator13`, does not expose arbitrary shell/command/cwd/env, does not enable S2, and does not add network or credential authority.

## 2. Public Authority Boundary
Public behavior inherited from M05/M06 remains unchanged throughout M07:
- `operator13` mode stays `READ_ONLY_EMERGENCY`.
- `operator_run_task` continues to return `TOOL_DENIED_INACTIVE_MODE`.
- Public mutation, checkpoint, and promotion remain inactive/unqualified.
- `legacy27` behavior remains unchanged.
- Destructive capability remains `LOCKED`.

M07 source must not be imported by `src/server.ts` or `src/operator/server-foundation.ts`.
## 3. Runner Inputs and Non-Inputs
The internal runner accepts exactly:
- transaction ID resolved by the M06 transaction service;
- task ID present in the bound registry;
- typed parameter object declared by that task recipe;
- expected task-registry SHA-256.

The caller cannot provide or override:
- executable or command string;
- shell;
- working directory;
- environment variables;
- timeout beyond the registry value;
- effect policy;
- sandbox profile;
- credentials, tokens, network target, or process ID.

Unknown top-level or parameter fields fail closed.
Missing required parameters fail closed.
The registry digest must exactly equal the digest loaded by the runner or execution is denied with deterministic currentness failure.

## 4. Task Resolution
M07 preserves the M05 registry validation principles but uses the separately versioned R1.2-complete `task-registry.m07.json` and M07 validator.
The first `argvTemplate` element is always fixed registry data and can never contain a placeholder.
Every placeholder is expanded only from its declared typed parameter schema.
The resolver returns an immutable execution recipe containing fixed executable, argv, timeout, sandbox profile, effect-policy reference, task identity, and registry digest.
No shell interpolation or command-string concatenation is permitted.
## 5. Parameter Safety
`relpath` parameters are resolved only against the transaction worktree.
They reject absolute paths, traversal, empty segments, `.git`, secret-sensitive names, symlink/reparse escape, and any realpath that leaves the worktree.
When `mustExist=true`, the resolved target must already exist and satisfy the required file-type constraint before execution.
`enum` parameters must match one exact registry value.
Parameter expansion is argv-element substitution, never shell parsing.

The resolver must reject a parameter value that would change executable identity, inject additional argv elements, or reinterpret path authority.

## 6. Transaction Binding
A task can execute only against a live M06 transaction known to the internal transaction service.
The runner obtains `worktreePath`, `projectId`, `canonicalRoot`, `baseHeadSha`, and state from server-side transaction state; none are caller-controlled.
Initial M07 execution eligibility is limited to state `APPLIED`.
`OPEN`, `STAGED`, `VALIDATED`, `CHECKPOINTED`, `PROMOTED`, `ROLLED_BACK`, and unknown transactions are denied.

Before execution, the runner verifies:
- transaction worktree still exists;
- current worktree and canonical Git common-directory identities match each other for the transaction paths recorded by M06;
- canonical HEAD still equals the transaction base HEAD;
- canonical worktree remains clean;
- worktree HEAD still equals the transaction base HEAD before checkpoint;
- the task working directory is exactly the transaction worktree.

Task execution never changes canonical HEAD or canonical tracked bytes.
## 7. R1.2-Complete Task Contract
M07 introduces `task-registry.m07.json` as a new qualified registry version and preserves `task-registry.m05.json` byte-for-byte for M05 compatibility.
The M07 registry adds the execution bindings required by Level B R1.2 without changing the public M05 foundation.
Each M07 task recipe binds:
- fixed executable through `argvTemplate[0]`;
- fixed argument-vector structure;
- typed parameter schemas and required parameters;
- `toolchainProfile` identifying the qualified sandbox runtime;
- `sandboxProfile` (`S0` or `S1` only);
- `networkAuthority` (`NONE` for S0, `FIXTURE_ONLY` for S1);
- `childProcessPolicy = SANDBOX_OWNED_TREE`;
- `envAllowlist` containing only explicitly safe variable names;
- `effectPolicyRef`;
- timeout;
- independent stdout and stderr byte bounds.

The task working directory is not configurable: it is always the transaction worktree mounted as `/workspace` in the mutable-code sandbox.
Secret-like environment names are forbidden even if accidentally listed in a registry.
S2 is rejected by registry validation and runner policy during M07.

The production M07 registry retains the four existing logical tasks unless qualification proves one cannot satisfy the new contract:
`node.test.run`, `project.build`, `project.test`, and `project.typecheck`.
M07 may use separate synthetic qualification registries for S1 fixture tests; those fixture-only task IDs are not production registry members.
## 8. Mutable-Code Sandbox
All M07 task execution that may interpret transaction-modified source, tests, package scripts, or build scripts runs inside a separately qualified Docker sandbox.
Host-side execution of transaction-modified project code is forbidden.
The host runner may invoke only fixed Docker lifecycle operations required to create, observe, stop, and remove transaction-owned sandbox resources.

### S0 — PURE
S0 uses a pinned Node toolchain image with:
- network mode `none`;
- non-root user;
- read-only container root filesystem;
- transaction worktree mounted only at /workspace with required task write authority;
- the worktree .git control file/metadata is read-only or masked from mutable-code writes;
- no canonical project mount and no unrelated host-workspace mount;
- bounded scratch only;
- explicit minimal environment only; no ambient host-environment inheritance;
- no host credential stores or secret mounts;
- no Docker socket;
- no host service access;
- dropped Linux capabilities and `no-new-privileges`;
- bounded memory, CPU, PIDs, timeout, stdout, and stderr.

### S1 — LOCAL_FIXTURE
S1 inherits all S0 restrictions except that it shares the network namespace of one fixed synthetic fixture container.
The fixture container itself runs with `--network none` and listens only on `127.0.0.1:8080`; the task container runs with `--network container:<fixture>`.
This creates no bridge, gateway, routable non-loopback interface, Internet path, host-network path, arbitrary host/port input, or Docker-socket authority.
Fixture and task containers are transaction-owned, labeled, bounded, and removed after the task.

### S2 — HOST_SERVICE_RESTRICTED
S2 remains `DISABLED` and every M07 attempt to select it returns deterministic denial.
## 9. Qualified Task Effect Policies
M07 introduces `task-effects.m07.json`, independently hash-bound from the task registry.
A transaction/task cannot add, remove, or widen effect rules at runtime.
Rules are root-anchored to `/workspace` or the bounded scratch root.
Overbroad project-wide patterns such as unrestricted `**/*` are invalid.
Protected/deny rules always override allowed artifact rules.

The initial qualified artifact policy may classify only bounded known outputs such as:
- `**/__pycache__/**`;
- `**/.pytest_cache/**`;
- `**/.cache/**`;
- `coverage/**`;
- `dist/**`;
- `*.tsbuildinfo`.

Before task execution, M07 captures a bounded Transaction Effect Manifest of the worktree, including empty-directory effects and nested `.git` descendants while excluding only the transaction root `.git` control metadata.
After execution it computes the exact delta and classifies every effect.
Classification semantics are:
- declared qualified ephemeral/build artifact → tolerated and recorded;
- benign unclassified workspace effect → task verification failure;
- unexpected tracked-source mutation beyond the pre-task transaction state → task verification failure;
- any canonical mutation → high-severity task failure;
- protected or secret-sensitive effect → emergency-class failure suitable for later circuit-breaker wiring.

M07 records classification but does not itself switch public Operator mode; M08 owns public runtime wiring.
## 10. Process and Resource Ownership
M07 tracks sandbox resources by transaction ID plus runner-generated resource identity.
Timeout/crash cleanup may stop or remove only containers, fixture containers, and networks whose ownership labels and recorded IDs match the active transaction.
The runner exposes no arbitrary PID/container/network kill interface.
External processes and unrelated Hermes/HAIOS containers are never terminated.
Cleanup failure is explicit and fail-closed; success cannot be reported while owned mutable-code execution remains active.

## 11. Output and Result Contract
The runner captures stdout and stderr separately and applies the task recipe byte bounds before returning or persisting output.
Result metadata includes at minimum:
- decision and deterministic reason;
- task ID;
- registry ID/version/SHA-256;
- effect-policy ID/version/SHA-256;
- sandbox profile and qualified toolchain image identity;
- transaction ID and worktree identity;
- exit code or timeout/crash state;
- duration;
- stdout/stderr byte counts and truncation flags;
- effect classification summary;
- canonical pre/post HEAD and state-digest comparison;
- owned-resource cleanup status.

Secret values are never included in task result metadata or logs. Raw stdout/stderr is checked for fixed high-risk secret patterns before result exposure; a match returns deterministic DENY with blank stdout/stderr.
Non-zero exit, timeout, crash, sandbox setup failure, effect-policy violation, currentness mismatch, secret-like output, or cleanup uncertainty returns DENY/failure rather than ALLOW.

## 12. Dependency Provisioning Boundary
M07 does not gain package-download or Internet authority in order to make a task pass.
Every M07 Docker `run` uses `--pull never`, so a missing sandbox image fails locally rather than creating implicit image-download authority.
It does not automatically run `npm install`, `npm ci`, pip install, package-manager login, or any network dependency hydration.
It does not mount the host Docker socket or secret-bearing package-manager configuration into the sandbox.

M07 live qualification uses synthetic fixtures whose required runtime is already present in the pinned sandbox image.
Production registry recipes that require project dependencies may be resolved and policy-validated, but M07 does not claim successful real-project execution unless those dependencies are available through a separately qualified, non-secret, non-network runtime input.
Dependency provisioning for real-project activation is therefore an explicit M08/M09 activation prerequisite, not an implicit M07 authority expansion.
## 13. Source Boundaries
M07 is expected to add these focused units:
- `task-registry.m07.json` — R1.2-complete production task recipes;
- `task-effects.m07.json` — versioned qualified Task Effect Policies;
- pinned existing mutable-code image `haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe` — reused without implicit pull or rebuild;
- `src/operator/task-contract-v2.ts` — R1.2-complete registry validation and hash binding;
- `src/operator/task-resolver.ts` — typed argv/path resolution;
- `src/operator/task-effects.ts` — effect-policy validation and hash binding;
- `src/operator/task-effect-manifest.ts` — bounded manifest inventory and delta classification;
- `src/operator/sandbox-toolchains.ts` — pinned toolchain identity and resource ceilings;
- `src/operator/sandbox-executor.ts` — fixed Docker S0/S1 lifecycle and ownership enforcement;
- `src/operator/task-runner.ts` — transaction/currentness/effect/output orchestration;
- focused M07 unit/integration/adversarial tests and synthetic fixtures;
- `scripts/qualify-m07.ps1` — deterministic live qualification and evidence handoff.

M07 should not modify public routing files unless a proven compile-only interface blocker makes that unavoidable.
Any required public-routing change upgrades scope and requires explicit review before activation behavior is introduced.

## 14. Qualification Matrix
The committed M07 candidate must prove all of the following before independent review:
1. exact M06 parent ancestry and clean worktree baseline;
2. M01-M06 regression remains green;
3. M07 registry rejects executable/cwd/env/shell/unknown-field injection and S2;
4. typed relpath/enum expansion produces argv elements with no shell parsing;
5. registry and effect-policy SHA-256 currentness mismatch fails closed;
6. S0 has no network, host service access, host secrets, Docker socket, or out-of-workspace/scratch writes;
7. S1 reaches only the fixed loopback synthetic fixture through a shared `--network none` fixture namespace and has no bridge/gateway/Internet/host network/Docker socket;
8. timeout/crash cleanup removes only transaction-owned sandbox resources;
9. stdout/stderr bounds and non-zero exit semantics are deterministic;
10. declared artifacts classify as tolerated while unclassified, tracked-source, protected, and secret effects fail at their required severities;
11. canonical HEAD/status/tracked bytes remain unchanged across task execution;
12. worktree/repository currentness drift fails closed;
13. production `operator_run_task` remains publicly denied and `operator13` remains `READ_ONLY_EMERGENCY`;
14. S2 remains disabled;
15. existing tunnel runtimes on 8768/8769 remain byte/config identity-stable and disposable 8772 ends free;
16. runtime/container/network residue is zero;
17. persisted secret-pattern hits are zero;
18. deterministic tracked-source manifest is stable pre/post live qualification;
19. exactly one final broad regression is run after candidate bytes freeze;
20. independent read-only review of exact HEAD + manifest returns zero blockers.
## 15. Runtime Identity and Currentness
Final M07 qualification must bind the mutable-code runtime identity rather than trusting a floating image tag.
The sandbox base image must be pinned by digest or the built sandbox image must be sealed by immutable image ID plus Dockerfile/source manifest, with qualification evidence recording the exact resolved identity.
The host-side Docker client path/version and Docker Engine identity are recorded as qualification facts.
A later activation must not claim M07 sandbox qualification if the executable/runtime identity materially drifts without requalification.

## 16. Explicit Non-Goals
M07 does not implement:
- public `operator_run_task` dispatch;
- public transaction/checkpoint/promotion routing;
- ACTIVE mode;
- S2;
- host-service access;
- arbitrary local service control;
- dependency download/install authority;
- package publishing or Docker push;
- Git remote mutation;
- cloud/production mutation;
- secret retrieval or secret environment inheritance;
- autonomous remediation-loop failure fingerprints or stagnation policy wiring;
- Level B final activation/dogfood certification.

Failure-fingerprint and remediation-loop logic may consume M07 task results in a later milestone; M07 therefore preserves stable failure metadata but does not broaden itself into the full autonomous loop.

## 17. Fixed M07 Resource Ceilings
The M07 qualified default sandbox profile uses these hard ceilings unless a task recipe is stricter:
- task timeout maximum: 600,000 ms;
- stdout maximum: 65,536 bytes;
- stderr maximum: 65,536 bytes;
- task-container memory: 1,536 MiB;
- task-container CPU limit: 2 CPUs;
- task-container PID limit: 256;
- scratch maximum: 512 MiB;
- effect-inventory maximum: 50,000 files, 64 MiB per inventoried file, and 1 GiB total inventoried bytes.

Exceeding any bound is a deterministic failure, never an implicit relaxation.
The qualified sandbox image uses Node 22.23.2 and is pinned to `haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe`; any runtime identity drift requires requalification.

## 18. Qualification Claim Boundary
The four production M07 recipes are executed end-to-end against a synthetic dependency-free Node fixture so their fixed recipe mechanics are live-qualified without package download authority.
The synthetic fixture provides `test`, `build`, and `typecheck` package scripts using only runtime components already present in the sealed sandbox image; `node.test.run` uses a built-in `node:test` fixture.
Adversarial variants edit package/test/build scripts to attempt network access, host-file access, Docker-socket access, protected-worktree mutation, out-of-workspace writes, and secret-environment discovery; containment must prevent or detect every attempt.

This proves the task contract and sandbox mechanics, not dependency availability for every future real project.
Real-project activation must separately prove that its required dependency/runtime input is qualified and non-secret without granting network-install authority implicitly.

## 19. Exit State
If qualification and independent verification pass, M07 may certify only:
- internal bounded task resolver = qualified;
- Task Effect Policy/TEM engine = qualified;
- S0 sandbox = qualified;
- S1 synthetic-fixture sandbox = qualified;
- S2 = disabled;
- internal task runner = qualified;
- public `operator_run_task` = still inactive;
- public `operator13` = `READ_ONLY_EMERGENCY`;
- destructive capability = `LOCKED`.

Pre-review terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_READY_FOR_INDEPENDENT_VERIFICATION`

Final terminal if zero blockers:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_BOUNDED_TASK_RUNNER_QUALIFIED`

The next architectural milestone is M08: wire only previously qualified M05/M06/M07 primitives into the exact 13-tool Operator surface, then qualify controlled activation separately.