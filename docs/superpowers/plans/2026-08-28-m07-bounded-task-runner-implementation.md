# M07 Internal Bounded Task Runner S0/S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify a hash-bound, transaction-worktree-only S0/S1 task runner without activating public `operator_run_task`.

**Architecture:** Preserve M05/M06 public behavior and add an internal execution subsystem. Resolve fixed argv from a v2 registry, bind execution to an M06 `APPLIED` worktree, run mutable code only inside a pinned Docker sandbox, then classify every workspace effect against a separately hash-bound effect policy.

**Tech Stack:** TypeScript, Node.js `child_process`/filesystem/crypto, Vitest, Docker Engine 29.7.2, PowerShell 7 qualification harness.

**Spec:** `docs/superpowers/specs/2026-08-28-m07-bounded-task-runner-design.md`

## Global Constraints
- Parent HEAD is `7b8e39f92e8444264a56a8f0e214095a25bf9016`.
- `operator13` stays `READ_ONLY_EMERGENCY`; `operator_run_task` remains denied.
- `legacy27` and M06 public behavior remain unchanged.
- No host execution of transaction-modified code.
- No generic shell/command/cwd/env/executable authority.
- S2 remains disabled.
- No Docker socket, host credential mount, host network, or implicit image pull.
- Production sandbox image is pinned to `haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe`.
- Qualification may use only disposable transaction-owned containers/networks and synthetic repositories.
- Existing listeners 8768/8769 must remain unchanged and 8772 must end free.
- No GitHub push occurs until M07 final certification and public-push audit pass.

---

### Task 1: R1.2-Complete Task Contract + Effect Policy

**Files:**
- Create: `task-registry.m07.json`
- Create: `task-effects.m07.json`
- Create: `src/operator/task-contract-v2.ts`
- Create: `src/operator/task-effects.ts`
- Test: `tests/m07-task-contract.test.ts`

**Interfaces:**
- Produces `BoundTaskRegistryV2`, `TaskRecipeV2`, `loadTaskRegistryV2(path)`.
- Produces `BoundTaskEffectPolicy`, `loadTaskEffectPolicy(path)`.
- Registry recipe exact fields: `argvTemplate,paramSchemas,requiredParams,toolchainProfile,sandboxProfile,networkAuthority,childProcessPolicy,envAllowlist,effectPolicyRef,timeoutMs,stdoutMaxBytes,stderrMaxBytes`.
- Production tasks remain `node.test.run`, `project.build`, `project.test`, `project.typecheck` and use S0/NONE.

- [ ] Write RED tests proving exact-key validation, immutable loaded objects, independent SHA-256 binding, fixed executable, typed placeholders, `shell/command/cwd/env/executable` rejection, S2 rejection, secret-like env-name rejection, network/profile compatibility, output/time bounds, and overbroad effect patterns rejection.
- [ ] Run `npm test -- tests/m07-task-contract.test.ts`; require RED because v2 modules/config do not exist.
- [ ] Implement strict parsers without modifying `src/operator/task-registry.ts` or `task-registry.m05.json`.
- [ ] Encode the four production tasks in `task-registry.m07.json`; bind `toolchainProfile=node22-sandbox-v1`, `childProcessPolicy=SANDBOX_OWNED_TREE`, `envAllowlist=["CI"]`, and bounded outputs.
- [ ] Encode effect policy `default-artifacts-v1` with protected source/secret rules and only bounded artifact patterns from the spec.
- [ ] Run focused test, `npm run typecheck`, `npm run build`; require PASS.
- [ ] Commit `feat: add m07 task and effect contracts`.

### Task 2: Resolver + Transaction/Path Binding + Effect Manifest

**Files:**
- Create: `src/operator/task-resolver.ts`
- Create: `src/operator/task-effect-manifest.ts`
- Test: `tests/m07-task-resolver.test.ts`
- Test: `tests/m07-task-effects.test.ts` 

**Interfaces:**
- `resolveTaskExecution(registry, taskId, params, expectedRegistrySha256, worktreePath)` returns immutable fixed executable/argv plus policy metadata.
- `captureTaskEffectManifest(worktreePath)` returns bounded path/type/hash metadata excluding only `.git` metadata; max entries/bytes are hard limits.
- `classifyTaskEffectDelta(before, after, policy)` returns every created/modified/removed effect with `ALLOWED_ARTIFACT`, `UNCLASSIFIED`, or `PROTECTED` classification.

- [ ] Write RED resolver tests for registry-digest mismatch, unknown/extra/missing params, enum mismatch, absolute/traversal/`.git`/secret path denial, symlink/junction escape, `mustExist`, and argv-element substitution without shell parsing.
- [ ] Write RED effect tests for deterministic manifest ordering/hashes, entry/byte limit fail-closed behavior, allowed `dist/coverage/cache/tsbuildinfo` effects, tracked/source-like or secret-sensitive effects, and deny-overrides-allow semantics.
- [ ] Run both focused files and require RED.
- [ ] Implement resolver with worktree realpath containment and no caller-controlled cwd/executable/env.
- [ ] Implement bounded manifest/delta classifier; never follow symlinks/reparse points and treat them as protected effects.
- [ ] Run Task 1–2 focused tests, typecheck, build; require PASS.
- [ ] Commit `feat: add m07 task resolution effect verification`.

### Task 3: Pinned Docker S0/S1 Sandbox Executor

**Files:**
- Create: `src/operator/sandbox-toolchains.ts`
- Create: `src/operator/sandbox-executor.ts`
- Test: `tests/m07-sandbox-executor.test.ts`

**Interfaces:**
- `M07_NODE_TOOLCHAIN` pins image digest and fixed resource/security bounds.
- `SandboxExecutor.execute(request)` accepts only trusted resolved recipe + server-derived worktree + optional server-owned fixture profile.
- `DockerExecutor(args)` is injected for tests; production uses `execFile('docker', args)` with no shell.
- Result includes exit code, stdout/stderr, truncation flags, duration, timeout/cleanup status, container/network identities.

- [ ] Write RED tests for exact S0 Docker argv: `--network none`, non-root, read-only root, `--cap-drop ALL`, `no-new-privileges`, PID/memory/CPU limits, `/workspace` bind, nested read-only `.git` bind, bounded tmpfs, fixed workdir, static safe env only, no Docker socket/host secrets.
- [ ] Write RED S1 tests proving generated `--internal` network, fixed synthetic fixture profile only, no arbitrary target, task/fixture containers on owned network, and cleanup of both containers + network.
- [ ] Prove no `pull`, host network, privileged mode, socket mount, generic shell, or caller-supplied Docker args are reachable.
- [ ] Implement deterministic owned resource names/labels and timeout cleanup; failure to prove cleanup returns fail-closed result.
- [ ] Run focused sandbox tests, typecheck, build; require PASS.
- [ ] Commit `feat: add m07 pinned docker sandbox executor`.

### Task 4: Internal Bounded Task Runner Orchestration

**Files:**
- Create: `src/operator/task-runner.ts`
- Test: `tests/m07-task-runner.test.ts`
- Test: `tests/m07-task-runner-adversarial.test.ts`

**Interfaces:**
- `OperatorTaskRunner.run({txId,taskId,params,expectedRegistrySha256})` is the only internal orchestration entrypoint.
- Consumes M06 `status(txId)`, `LocalOperatorGit`, bound v2 registry/effects, resolver, manifest classifier, and sandbox executor.
- Accepts only transaction state `APPLIED`; all transaction/canonical/worktree paths come from server-side transaction status.

- [ ] Write RED tests proving unknown/non-APPLIED transactions deny, canonical HEAD/status drift denies, worktree HEAD drift denies, canonical/worktree common-dir mismatch denies, registry currentness mismatch denies, and sandbox is never invoked after a failed gate.
- [ ] Write RED success tests proving cwd is exactly transaction worktree, S0/S1 choice comes only from registry, pre/post effect manifests are captured, canonical remains unchanged, allowed artifacts are tolerated/recorded, and unclassified/protected effects deny.
- [ ] Write RED process/result tests for bounded stdout/stderr, timeout, non-zero exit, cleanup-pending, and deterministic reason codes.
- [ ] Prove M07 runner is not imported by `src/server.ts` or `src/operator/server-foundation.ts`; public `operator_run_task` remains `TOOL_DENIED_INACTIVE_MODE`.
- [ ] Implement minimum orchestration without modifying public routing.
- [ ] Run all M07 focused tests, typecheck, build; require PASS.
- [ ] Commit `feat: add m07 internal bounded task runner`.

### Task 5: Adversarial + Disposable Live Docker Qualification

**Files:**
- Create: `tests/m07-adversarial.test.ts`
- Create: `tests/fixtures/m07/s0-probe.mjs`
- Create: `tests/fixtures/m07/s1-client.mjs`
- Create: `scripts/qualify-m07.ps1`

- [ ] Add adversarial tests proving no host execution path, no public Operator activation, no legacy/operator union, no S2, no image pull, no Docker socket/host-network/privileged authority, and no arbitrary cwd/env/executable/network target.
- [ ] Add contract tests ensuring qualification checks exact pinned image digest, immutable M06 parent binding, deterministic tracked-source manifest, tunnel integrity, Docker residue, secret scan, and port 8772 cleanup.
- [ ] Run M07 adversarial tests first.
- [ ] Commit the complete candidate before broad qualification.
- [ ] On committed bytes, run exactly one final broad regression, typecheck, and build.
- [ ] Freeze ordinal/lowercase SHA-256 tracked-source manifest and verify post-live equality.
- [ ] Run live S0 in a disposable synthetic Git worktree; execute modified JavaScript in Docker, prove network none/non-root/no socket/canonical unchanged, and classify one bounded artifact.
- [ ] Run live S1 with one generated Docker `--internal` network and fixed synthetic fixture container; prove fixture reachable and unrelated external/host authority unavailable.
- [ ] Verify all M07 containers/networks are removed, Docker residue is zero, ports 8768/8769 integrity unchanged, and 8772 free.
- [ ] Produce qualification result + independent-review handoff bound to exact HEAD and manifest.
- [ ] Stop at `HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_READY_FOR_INDEPENDENT_VERIFICATION`.

### Final Certification Gate

Independent review must verify exact HEAD/manifest, all M07 authority boundaries, S0/S1 sandbox semantics, effect classification, no public activation, tunnel/runtime cleanup, and zero persisted secrets. Final certification and GitHub push occur only after zero-blocker independent review plus fresh post-review currentness and public-history secret audit.
## Exact Interface and Verification Appendix

The following signatures are binding across tasks; later tasks must consume these names exactly.

```ts
export type TaskSandboxProfileV2 = "S0" | "S1";
export type TaskNetworkAuthority = "NONE" | "FIXTURE_ONLY";
export interface BoundTaskRegistryV2 {
  readonly registry: TaskRegistryV2;
  readonly sha256: string;
  readonly sourcePath: string;
}
export interface BoundTaskEffectPolicy {
  readonly policySet: TaskEffectPolicySet;
  readonly sha256: string;
  readonly sourcePath: string;
}
export async function loadTaskRegistryV2(sourcePath: string): Promise<BoundTaskRegistryV2>;
export async function loadTaskEffectPolicy(sourcePath: string): Promise<BoundTaskEffectPolicy>;
``````ts
export interface ResolvedTaskExecution {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly sandboxProfile: "S0" | "S1";
  readonly networkAuthority: "NONE" | "FIXTURE_ONLY";
  readonly effectPolicyRef: string;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly registrySha256: string;
}
export async function resolveTaskExecution(
  registry: BoundTaskRegistryV2,
  taskId: string,
  params: Readonly<Record<string, unknown>>,
  expectedRegistrySha256: string,
  worktreePath: string,
): Promise<ResolvedTaskExecution>;
export async function captureTaskEffectManifest(worktreePath: string): Promise<TaskEffectManifest>;
export function classifyTaskEffectDelta(
  before: TaskEffectManifest,
  after: TaskEffectManifest,
  policy: BoundTaskEffectPolicy,
): readonly TaskEffectDelta[];
``````ts
export type DockerExecutor = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<DockerExecResult>;
export interface SandboxExecutionRequest {
  readonly execution: ResolvedTaskExecution;
  readonly worktreePath: string;
  readonly safeEnvironment: Readonly<Record<string, string>>;
  readonly fixtureProfileId?: string;
}
export interface SandboxExecutionResult {
  readonly decision: "ALLOW" | "DENY";
  readonly reason?: string;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly cleanupVerified: boolean;
}
export class SandboxExecutor {
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}
```
Task containers MUST use Docker `--entrypoint <resolved fixed executable>` so the image's `/bin/sh -c` entrypoint is never used for transaction-modified code.```ts
export interface OperatorTaskRunRequest {
  readonly txId: string;
  readonly taskId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly expectedRegistrySha256: string;
}
export type OperatorTaskRunResult =
  | {
      readonly decision: "ALLOW";
      readonly taskId: string;
      readonly registrySha256: string;
      readonly exitCode: 0;
      readonly stdout: string;
      readonly stderr: string;
      readonly effects: readonly TaskEffectDelta[];
    }
  | { readonly decision: "DENY"; readonly reason: string; readonly exitCode?: number };
export class OperatorTaskRunner {
  run(request: OperatorTaskRunRequest): Promise<OperatorTaskRunResult>;
}
```

Focused RED commands are exact:
- Task 1: `npm test -- tests/m07-task-contract.test.ts`
- Task 2: `npm test -- tests/m07-task-resolver.test.ts tests/m07-task-effects.test.ts`
- Task 3: `npm test -- tests/m07-sandbox-executor.test.ts`
- Task 4: `npm test -- tests/m07-task-runner.test.ts tests/m07-task-runner-adversarial.test.ts`
- Task 5 first gate: `npm test -- tests/m07-adversarial.test.ts`

Final broad commands on committed candidate bytes are exactly `npm test`, `npm run typecheck`, and `npm run build`. No redundant broad rerun occurs unless candidate bytes change.