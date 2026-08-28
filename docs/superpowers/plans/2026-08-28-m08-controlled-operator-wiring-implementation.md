# M08 Controlled Operator Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the certified M05 13-tool protocol to the certified M06 isolated transaction/checkpoint/CAS service and M07 bounded task runner while keeping long-lived production activation locked.

**Architecture:** Add a narrow async `OperatorControlRuntime` dispatcher that owns exact active-mode routing and server-bound M07 task-registry currentness. Extend the MCP server with an explicit dual-key activation gate (`operatorMode="ACTIVE"` + injected runtime), leaving default `operator13` behavior byte-compatible with M05-M07. Qualify ACTIVE only on disposable 8772 against a synthetic local Git repo.

**Tech Stack:** TypeScript, Node.js, Vitest, MCP SDK, Git CLI through `LocalOperatorGit`, Docker through certified `SandboxExecutor`, PowerShell 7 qualification.

**Spec:** `docs/superpowers/specs/2026-08-28-m08-controlled-operator-wiring-design.md`

## Global Constraints
- Parent HEAD is `9a14ad42e31dbf43306d90b1f9ec98ce3c1c38e0` and M07 final-cert SHA-256 is `a6b58a86a4d60b5ee71dbab4672ad89c16ab5b3f30392d04eec8c03253e12533`.
- `legacy27` remains unchanged and never unions with `operator13`.
- Default `operator13` remains `READ_ONLY_EMERGENCY`.
- ACTIVE requires both explicit server configuration and an injected M08 runtime; caller input never controls mode.
- M06 is the only transaction/checkpoint/promotion backend; M07 is the only task backend.
- Public `operator_run_task` does not accept a registry digest; M08 injects the exact bound M07 digest server-side.
- S2 stays disabled; DESTRUCTIVE stays locked.
- No generic shell/exec/cwd/env, remote Git, package download, secret retrieval, cloud/production mutation, process termination, privileged configuration, or tunnel mutation.
- Live ACTIVE qualification is disposable loopback port 8772 only; 8768/8769 must remain unchanged.

---

### Task 1: Typed Active Operator Runtime Dispatcher

**Files:**
- Create: `src/operator/control-runtime.ts`
- Test: `tests/m08-operator-runtime.test.ts`

**Interfaces:**
- Consumes: `OperatorTransactionService`, `OperatorTaskRunner`, `BoundTaskRegistryV2`, `BoundTaskEffectPolicy`.
- Produces: `OperatorControlRuntime`, `createOperatorControlRuntime(config)`, `dispatchOperatorControlTool(name,args,runtime)`.

- [ ] **Step 1: Write failing runtime mapping tests**

Cover exact-key validation and one exact call for every active tool. Use fakes that record method name/arguments. Require `operator_run_task({txId,taskId,params})` to call the runner with:

```ts
{
  txId,
  taskId,
  params,
  expectedRegistrySha256: runtime.registry.sha256,
}
```

Require unknown fields to return `{decision:"DENY",reason:"OPERATOR_INPUT_FIELDS_DENIED"}` before any fake method records a call.

- [ ] **Step 2: Run RED**

Run:
```powershell
npm test -- tests/m08-operator-runtime.test.ts
```
Expected: FAIL because `control-runtime.ts` does not exist.

- [ ] **Step 3: Implement the dispatcher**

Use this public shape:

```ts
export interface OperatorControlRuntime {
  readonly mode: "ACTIVE";
  readonly transactions: OperatorTransactionService;
  readonly tasks: OperatorTaskRunner;
  readonly registry: BoundTaskRegistryV2;
  readonly effects: BoundTaskEffectPolicy;
}

export async function dispatchOperatorControlTool(
  name: string,
  args: unknown,
  runtime: OperatorControlRuntime,
): Promise<{
  readonly capabilityClass: "READ" | "EXECUTE" | "MUTATE" | "UNKNOWN";
  readonly result: Readonly<Record<string, unknown>> & { readonly decision: "ALLOW" | "DENY" };
}>;
```

Status must report ACTIVE plus exact registry/effect identities, `checkpointQualified=true`, `promotionQualified=true`, `s2Enabled=false`, `destructive="LOCKED"`, `genericShell=false`, `genericExec=false`.

- [ ] **Step 4: Run GREEN + typecheck/build**

```powershell
npm test -- tests/m08-operator-runtime.test.ts
npm run typecheck
npm run build
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/operator/control-runtime.ts tests/m08-operator-runtime.test.ts
git commit -m "feat: add m08 controlled operator runtime"
```

---

### Task 2: Explicit Server Activation Gate + MCP Routing

**Files:**
- Modify: `src/server.ts`
- Test: `tests/m08-operator-server.test.ts`
- Regression: `tests/m05-operator-server.test.ts`, `tests/server-tools-list.test.ts`

**Interfaces:**
- Consumes: `OperatorControlRuntime`, `dispatchOperatorControlTool`.
- Produces new `GatewayServerConfig` fields:

```ts
readonly operatorMode?: "READ_ONLY_EMERGENCY" | "ACTIVE";
readonly operatorRuntime?: OperatorControlRuntime;
```

- [ ] **Step 1: Write failing mode-gate tests**

Require:
- default `operator13` remains inactive M05 behavior;
- `operatorMode:"ACTIVE"` without runtime rejects server creation with `M08_ACTIVE_RUNTIME_REQUIRED`;
- runtime without `operatorMode:"ACTIVE"` rejects with `M08_ACTIVE_RUNTIME_NOT_AUTHORIZED`;
- Operator activation fields with `legacy27` reject with `M08_OPERATOR_CONFIG_PROTOCOL_MISMATCH`;
- controlled ACTIVE lists exactly the same 13 tools and routes status/capabilities plus active calls to the injected runtime;
- no legacy tool appears.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/m08-operator-server.test.ts tests/m05-operator-server.test.ts tests/server-tools-list.test.ts
```
Expected: M08 cases fail; existing regressions remain green.

- [ ] **Step 3: Implement minimal server selection**

At server construction validate the mode/runtime pair before binding. In the CallTool handler select:

```ts
const operatorDispatch = operatorFoundation === undefined
  ? undefined
  : operatorMode === "ACTIVE"
    ? await dispatchOperatorControlTool(name, args, operatorRuntime!)
    : dispatchOperatorFoundationTool(name, operatorFoundation);
```

Do not add a caller-visible mode tool/field. Do not fall through active Operator names into legacy transaction/execute dispatch.

- [ ] **Step 4: Run GREEN + typecheck/build**

```powershell
npm test -- tests/m08-operator-server.test.ts tests/m05-operator-server.test.ts tests/server-tools-list.test.ts
npm run typecheck
npm run build
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts tests/m08-operator-server.test.ts
git commit -m "feat: wire controlled operator13 active mode"
```

---

### Task 3: Disposable ACTIVE MCP End-to-End Fixture

**Files:**
- Create: `scripts/live-m08-qualification.mjs`
- Test: `tests/m08-live-helper.test.ts`

**Interfaces:**
- Consumes: `createGatewayServer`, `OperatorTransactionService`, `LocalOperatorGit`, `OperatorTaskRunner`, `SandboxExecutor`, M07 registry/effect loaders.
- Produces deterministic JSON live result containing transaction/checkpoint/promotion/rollback/CAS/tunnel-safe facts but no secrets or staged content.

- [ ] **Step 1: Write RED static-contract tests**

Require the helper to:
- bind only `127.0.0.1:8772`;
- build an allowlisted synthetic Git repo and separate generated worktree root;
- load exact `task-registry.m07.json` and `task-effects.m07.json`;
- use `LocalOperatorGit`, `OperatorTransactionService`, `OperatorTaskRunner`, `SandboxExecutor`;
- call all mutation/task/checkpoint/promotion operations through MCP requests, not direct service methods after runtime construction;
- include separate rollback and stale-CAS scenarios;
- contain no `git push`, `git fetch`, `git pull`, `docker pull`, credential reads, cloud endpoints, 8768 mutation, or 8769 mutation.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/m08-live-helper.test.ts
```
Expected: FAIL because helper is absent.

- [ ] **Step 3: Implement synthetic live flow**

Create a dependency-free Node fixture with a `package.json` whose `test`, `build`, and `typecheck` scripts use only the pinned Node runtime. Initialize a local Git repo with fixed local identity. Start the gateway with `protocolMode:"operator13"`, `operatorMode:"ACTIVE"`, and injected runtime.

Through MCP:
- assert 13 tools;
- begin/stage/validate/apply;
- assert canonical unchanged;
- run `project.test`;
- checkpoint;
- promote with captured base HEAD + returned checkpoint;
- assert canonical equals checkpoint and is clean;
- create a second transaction and rollback it;
- create a third transaction/checkpoint, advance canonical independently, then prove stale promotion DENY and no additional canonical mutation;
- close port 8772 and ensure transaction worktree root is empty/removed.

- [ ] **Step 4: Run helper-focused GREEN**

```powershell
npm test -- tests/m08-live-helper.test.ts
npm run typecheck
npm run build
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/live-m08-qualification.mjs tests/m08-live-helper.test.ts
git commit -m "test: add m08 active operator live fixture"
```

---

### Task 4: M08 Adversarial + Deterministic Qualification

**Files:**
- Create: `tests/m08-adversarial.test.ts`
- Create: `scripts/qualify-m08.ps1`

**Interfaces:**
- Consumes committed Task 1-3 bytes.
- Produces `evidence/m08/<RUN_ID>/` with final regression, source manifests, live result, qualification result, and independent-review handoff.

- [ ] **Step 1: Add adversarial tests**

Cover:
- ACTIVE without runtime denied;
- runtime without explicit ACTIVE denied;
- legacy27 + activation config denied;
- caller cannot add mode, executable, shell, cwd, env, registry digest, S2, remote Git, or extra top-level fields;
- exact 13-tool projection only;
- public task registry digest is server-bound;
- inactive mode dispatch count remains zero;
- wrong project/root, stale preimage, stale CAS, wrong checkpoint, invalid state, task failure, effect violation, and rollback cleanup all fail closed;
- status/capabilities never report S2/destructive/generic exec authority.

- [ ] **Step 2: Run focused/adversarial GREEN before freeze**

```powershell
npm test -- tests/m08-*.test.ts tests/m05-operator-server.test.ts tests/m06-adversarial.test.ts tests/m07-adversarial.test.ts
npm run typecheck
npm run build
```
Expected: PASS.

- [ ] **Step 3: Implement qualification script**

The script must require PowerShell 7, clean committed bytes, certified M07 ancestry/final-cert hash, focused adversarial PASS, exactly one final full regression on frozen bytes, typecheck/build, ordinal deterministic tracked-source manifest, pre/post tunnel digests, live M08 helper execution, post-live source-manifest equality, zero Docker/worktree/runtime residue, ports 8768/8769 unchanged, 8772 free, persisted secret scan zero, and active production runtime not changed.

Pre-review terminal must be:

```text
HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_READY_FOR_INDEPENDENT_VERIFICATION
```

- [ ] **Step 4: Commit qualification gates**

```powershell
git add tests/m08-adversarial.test.ts scripts/qualify-m08.ps1
git commit -m "test: add m08 controlled wiring qualification"
```

- [ ] **Step 5: Run fresh qualification on committed bytes**

```powershell
pwsh -NoProfile -File .\scripts\qualify-m08.ps1
```
Expected: all gates PASS and exact pre-review terminal.

---

### Task 5: Fresh Independent Review + Final Certification

**Files:**
- Append-only evidence under `evidence/m08/<RUN_ID>/` only.

- [ ] **Step 1: Fresh read-only Codex review**

Bind exact HEAD + deterministic source-manifest digest. Reviewer must independently verify the full M08 design, not just latest diff, and return a structured PASS/BLOCKED verdict. Do not rerun unchanged regression unless the reviewer finds evidence invalid.

- [ ] **Step 2: Remediate only if blockers exist**

If blockers > 0, return to TDD on only the identified delta, recommit, run one fresh qualification, then request a new exact-byte review.

- [ ] **Step 3: Post-review currentness**

Require exact HEAD/manifest match, clean worktree, M07 ancestry/final-cert binding, tunnel digests unchanged, ports 8768/8769 listening, 8772 free, Docker/worktree residue zero, and reviewer blocker count zero.

- [ ] **Step 4: Seal final certification**

Create `m08-final-certification.json` plus SHA-256 sidecar only after zero blockers and fresh currentness. Final terminal:

```text
HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_CONTROLLED_OPERATOR_WIRING_QUALIFIED
```

The certification must explicitly state that the long-lived/dedicated Operator production runtime is still `READ_ONLY_EMERGENCY`, S2 is disabled, DESTRUCTIVE is locked, and production dogfood activation has not occurred.

## Independent Review Remediation R1

The first fresh M08 review returned one blocker: ACTIVE accepted an unbranded structural runtime. Remediation is limited to runtime provenance/identity binding.

- [x] Add `src/operator/qualified-control-runtime.ts` with exact registry/effect digest checks, internal construction of M06/M07 primitives, frozen attestation, and module-private `WeakSet` branding.
- [x] Add `tests/m08-runtime-provenance.test.ts` proving structural fakes are rejected and artifact drift fails closed.
- [x] Require `isQualifiedOperatorControlRuntime()` at the ACTIVE server boundary.
- [x] Route the disposable live helper through `createQualifiedOperatorControlRuntime()`.
- [ ] Commit remediation bytes, run fresh deterministic qualification, and request a new exact-byte independent review.
