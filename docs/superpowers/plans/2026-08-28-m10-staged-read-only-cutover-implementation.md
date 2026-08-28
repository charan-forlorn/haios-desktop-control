# M10 Staged Read-Only Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify and execute a staged production read-only cutover where only the dedicated Operator tunnel reaches the sealed Windows host runtime, while the shared Secure MCP route and Docker Operator rollback lane remain intact.

**Architecture:** Extend the certified M09 host runtime with an M10-only production policy layer, then build deterministic Windows/Docker preflight, cutover, and rollback transactions whose exact bytes are sealed before any production mutation. Non-live qualification ends at an exact Human cutover decision; only that later decision may hand off port `8769`, provision the production secret/task, or recreate the dedicated tunnel.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest 4, MCP SDK 1.30.0, PowerShell 7, Git CLI/worktrees, Docker Desktop/Compose, Windows ACLs, Windows Task Scheduler, `ghcr.io/openai/tunnel-client:v0.0.11`.

**Spec:** `docs/superpowers/specs/2026-08-28-m10-staged-read-only-cutover-design.md`

## Global Constraints
- Parent M09 HEAD/GitHub main: `8496242a443ca53e99c6357023a7321cb7394e44`.
- Parent M09 manifest: `8b6732e9163503d4d72d22ddb4cec381236c16e336019fa8b437f672b97c26c2`.
- Parent M09 final-cert SHA-256: `7ec685bdf157f37d8d0525f7da6ec60257b189bbde5bef77731ea344ef82d946`.
- Development worktree: `C:\Workspace\haios-desktop-control-m10`; production deployment worktree: `C:\Workspace\haios-desktop-control-runtime` only after live authority.
- Production M10 mode is exactly `READ_ONLY_EMERGENCY`; `activationScope` absent; `allowedProjects={}`; host fixed `127.0.0.1`; production port `8769`.
- Preflight runtime uses disposable `8774`; disposable dev-proxy ingress uses `18774`.
- Shared `haios-tunnel-client`, Secure MCP `:8768`, M08/M09 registry/effect identities, S2 disabled, and DESTRUCTIVE locked are immutable.
- No production cutover mutation is authorized by spec approval alone.

---## File Structure
- Create `src/operator/m10-production-config.ts`: M10-only strict wrapper around the certified M09 config boundary.
- Create `tests/m10-production-config.test.ts`: exact production-policy tests; no OS mutation.
- Create `scripts/m10-preflight.ps1`: read-only production inventory, disposable ACL fixture, Task Scheduler feasibility, compose-render checks, and sanitized preimage capture.
- Create `tests/m10-preflight-contract.test.ts`: static/behavioral contract for preflight and evidence fields.
- Create `scripts/live-m10-readonly-parity.mjs`: disposable `READ_ONLY_EMERGENCY` direct + dev-proxy parity on 8774/18774.
- Create `tests/m10-readonly-parity.test.ts`: exact 13-tool/status/capability and secret-cleanup contract.
- Create `scripts/execute-m10-readonly-cutover.ps1`: live transactional executor; unusable without exact sealed decision/currentness checks.
- Create `scripts/rollback-m10-readonly-cutover.ps1`: exact-preimage rollback transaction.
- Create `tests/m10-cutover-transaction.test.ts`: executor/rollback ordering, authority, hash, route, ACL, task, and fail-closed contracts.
- Create `tests/m10-adversarial.test.ts`: drift, secret, task, compose, route, and rollback negative matrix.
- Create `scripts/qualify-m10-preflight.ps1`: deterministic candidate qualification and Human decision envelope generation.
- Create `scripts/qualify-m10-live.ps1`: post-cutover read-only dogfood/fault-drill/currentness packaging only.

---

### Task 1: Strict M10 Production Config Boundary

**Files:**
- Create: `src/operator/m10-production-config.ts`
- Test: `tests/m10-production-config.test.ts`
- Regression: `tests/m09-host-runtime-config.test.ts`, `tests/m09-host-runtime.test.ts`

**Interfaces:**
- Consumes: `validateHostOperatorLaunchConfig(value)` from `src/operator/host-runtime-config.ts`.
- Produces: `validateM10ReadOnlyProductionConfig(value): HostOperatorLaunchConfig` and constants `M10_PRODUCTION_PORT=8769`, `M10_PREFLIGHT_PORT=8774`.
- [ ] **Step 1: Write RED policy tests** proving M10 accepts only `{mode:"READ_ONLY_EMERGENCY", port:8769, allowedProjects:{}}`, rejects any `activationScope`, ACTIVE, nonempty project map, alternate production port, caller host/runtime/upstream/registry/effect/executable/env/tunnel fields, and preserves M09 secret-file error semantics.

```ts
const valid = { apiKeyFile:"C:\\state\\operator-api-key", worktreeRoot:"C:\\runtime\\worktrees", allowedProjects:{}, port:8769, mode:"READ_ONLY_EMERGENCY" };
expect(validateM10ReadOnlyProductionConfig(valid)).toMatchObject(valid);
for (const bad of [{...valid,mode:"ACTIVE"},{...valid,port:8774},{...valid,allowedProjects:{demo:"C:\\demo"}},{...valid,activationScope:"M09_TEST_ONLY"}]) {
  expect(() => validateM10ReadOnlyProductionConfig(bad)).toThrow("M10_PRODUCTION_CONFIG_DENIED");
}
```

- [ ] **Step 2: Run RED:** `npm test -- tests/m10-production-config.test.ts` and require module-not-found/failing policy assertions.
- [ ] **Step 3: Implement minimal wrapper:** first call M09 validation, then fail unless exact M10 production invariants hold; return the frozen validated object and never add a new activation scope.
- [ ] **Step 4: Run GREEN:** `npm test -- tests/m10-production-config.test.ts tests/m09-host-runtime-config.test.ts tests/m09-host-runtime.test.ts && npm run typecheck && npm run build`.
- [ ] **Step 5: Commit:** `git add src/operator/m10-production-config.ts tests/m10-production-config.test.ts && git commit -m "feat: add m10 read-only production config boundary"`.

---

### Task 2: Read-Only Production Preflight + Preimage Capture

**Files:**
- Create: `scripts/m10-preflight.ps1`
- Create: `tests/m10-preflight-contract.test.ts`

**Interfaces:**
- Script args: `-EvidenceRoot <absolute path> -Mode Inspect|Fixture`.
- Produces sanitized `production-preimage.json`, `acl-fixture-result.json`, `task-scheduler-feasibility.json`, and `compose-render-result.json`; never records secret values or host-side control-plane secret paths.
- [ ] **Step 1: Write RED contract tests** requiring exact read-only sources `C:\Workspace\haios-operator-mcp\docker-compose.operator.yml`, `C:\Workspace\haios-operator-mcp\docker-compose.operator-dedicated-tunnel.yml`, current containers `haios-operator-mcp`, `haios-operator-dedicated-tunnel-client`, `haios-tunnel-client`, listeners 8768/8769, current scheduled-task absence/presence, and deterministic container digests with sorted mounts/networks.
- [ ] **Step 2: Add fixture expectations**: ACL fixture may mutate only a disposable temp root; it must remove inherited broad access, allow exact current operator + `SYSTEM` + `BUILTIN\Administrators`, reject `Everyone`/generic writable `Users`, delete the fixture, and leave production state untouched.
- [ ] **Step 3: Add Task Scheduler feasibility check** using `Get-ScheduledTask`/COM capability read-only and in-memory definition validation for task name `HAIOS-M10-Operator-ReadOnly`, exact current-user logon trigger, `Interactive` logon semantics, no stored password, restart-on-failure, one launcher + one config-path argument.
- [ ] **Step 4: Add compose dry-render check** proving an M10 operator override can remove only `127.0.0.1:8769:8769` while preserving service/image/network/env/mount identities, and a dedicated-tunnel override can change only target + read-only API-key mount/header. Use `docker compose ... config`; do not run `up`, `down`, `restart`, `rm`, or `create`.
- [ ] **Step 5: Run RED:** `npm test -- tests/m10-preflight-contract.test.ts`; then implement the PowerShell functions and rerun GREEN.
- [ ] **Step 6: Execute non-live preflight:** `pwsh -NoProfile -File .\scripts\m10-preflight.ps1 -EvidenceRoot .\runtime\m10-preflight-fixture -Mode Fixture`; require production container/listener digests before/after identical and disposable residue zero.
- [ ] **Step 7: Commit:** `git add scripts/m10-preflight.ps1 tests/m10-preflight-contract.test.ts && git commit -m "test: add m10 production preflight contract"`.

---

### Task 3: Disposable Read-Only Host + Dev-Proxy Parity

**Files:**
- Create: `scripts/live-m10-readonly-parity.mjs`
- Create: `tests/m10-readonly-parity.test.ts`

**Interfaces:**
- Helper args: runtime root, result path, direct port `8774`, proxy port `18774`.
- Produces sanitized JSON booleans: exact 13 tools, emergency mode, mutation inactive, S2 false, generic exec/shell false, destructive locked, tunnel parity, key removed, container removed, logs secret-free.

- [ ] **Step 1: Write RED tests** requiring a temporary M09-compatible key/config with `READ_ONLY_EMERGENCY`, `allowedProjects:{}`, direct loopback 8774, synthetic dev-proxy tunnel id only, `--entrypoint /usr/bin/tunnel-client`, read-only key mount, file-backed `X-API-Key`, and official MCP SDK calls.
- [ ] **Step 2: Require negative read-only proof**: `operator_status` reports `READ_ONLY_EMERGENCY`; `operator_capabilities` reports mutation inactive/S2 false/generic exec false/generic shell false/destructive locked; one representative mutation call must be denied without creating transaction/runtime state.
- [ ] **Step 3: Run RED:** `npm test -- tests/m10-readonly-parity.test.ts`.
- [ ] **Step 4: Implement by adapting M09 parity transport only**; do not copy ACTIVE transaction/promotion logic and do not reference real tunnel IDs or production ports.
- [ ] **Step 5: Run GREEN + live disposable proof:** `npm test -- tests/m10-readonly-parity.test.ts && npm run build`, then `node .\scripts\live-m10-readonly-parity.mjs .\runtime\m10-parity .\runtime\m10-parity-result.json 8774 18774`.
- [ ] **Step 6: Reconcile:** require ports 8774/18774 free, M10-labeled container count zero, temp key absent, and long-lived 8768/8769/container digests unchanged.
- [ ] **Step 7: Commit:** `git add scripts/live-m10-readonly-parity.mjs tests/m10-readonly-parity.test.ts && git commit -m "test: add m10 read-only host tunnel parity"`.

---

### Task 4: Sealed Cutover Transaction + Exact Rollback Scripts

**Files:**
- Create: `scripts/execute-m10-readonly-cutover.ps1`
- Create: `scripts/rollback-m10-readonly-cutover.ps1`
- Create: `tests/m10-cutover-transaction.test.ts`

**Interfaces:**
- Executor args: `-DecisionEnvelope <absolute json> -EvidenceRoot <absolute path>`.
- Rollback args: `-DecisionEnvelope <absolute json> -ExecutionJournal <absolute jsonl> -EvidenceRoot <absolute path>`.
- Both require exact SHA/currentness bindings and stable error codes; neither accepts arbitrary compose path, container name, port, task name, tunnel id, secret path, command, or project root from caller input.

- [ ] **Step 1: Write RED static tests** requiring hard-bound integration points: old compose `C:\Workspace\haios-operator-mcp\docker-compose.operator.yml`, dedicated compose `C:\Workspace\haios-operator-mcp\docker-compose.operator-dedicated-tunnel.yml`, deployment root `C:\Workspace\haios-desktop-control-runtime`, state root `$env:LOCALAPPDATA\HAIOS\M10`, task `HAIOS-M10-Operator-ReadOnly`, production port 8769, exact three container identities.
- [ ] **Step 2: Require decision gate before mutation**: executor must hash itself, rollback script, candidate manifest, parent cert, both compose preimages, three container digests, listeners, and exact Human decision string from the sealed envelope before the first mutating command.
- [ ] **Step 3: Require live ordering**: (a) exact fresh preimage capture, (b) remove only old Operator host publish via a generated Compose override and recreate only `haios-operator-mcp`, (c) prove old internal Docker health, (d) create deployment worktree at exact candidate HEAD and verify manifest, (e) build dist, (f) create fresh random API key + non-secret config + hardened ACL, (g) register/start exact scheduled task, (h) require host 8769 emergency health, then and only then (i) recreate only dedicated tunnel with target `host.docker.internal:8769/mcp` plus read-only key mount/header.
- [ ] **Step 4: Require journal-before-mutation**: append-only JSONL journal exists before first write/recreate and records preflight, each authorized mutation, postcondition, and rollback decision without secret bytes.
- [ ] **Step 5: Require automatic rollback on any forward failure** after mutation begins; rollback restores dedicated tunnel preimage first if switched, stops/removes M10 task/runtime, restores old Operator host publish from preimage, verifies 8769 emergency health, then removes only M10-owned deployment/state residue allowed by the envelope.
- [ ] **Step 6: Require drift-safe rollback**: rollback refuses to overwrite concurrent unrelated compose/container/task/ACL drift; ambiguous state produces `M10_ROLLBACK_CURRENTNESS_BLOCKED` and preserves evidence rather than broad cleanup.
- [ ] **Step 7: Run RED:** `npm test -- tests/m10-cutover-transaction.test.ts`; implement scripts without executing production branches; rerun GREEN plus PowerShell parser checks.
- [ ] **Step 8: Exercise scripts only against synthetic copied compose/state fixtures** with a fake decision envelope; assert mutating production command paths remain unreachable and fixture rollback restores byte-exact preimages.
- [ ] **Step 9: Commit:** `git add scripts/execute-m10-readonly-cutover.ps1 scripts/rollback-m10-readonly-cutover.ps1 tests/m10-cutover-transaction.test.ts && git commit -m "feat: add sealed m10 cutover rollback transaction"`.

---

### Task 5: Adversarial Matrix + Deterministic Pre-Live Qualification

**Files:**
- Create: `tests/m10-adversarial.test.ts`
- Create: `scripts/qualify-m10-preflight.ps1`

**Interfaces:**
- Produces `evidence/m10/<RUN_ID>/` and a sealed `human-read-only-cutover-decision-envelope.json`.
- Success terminal: `HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_READY_FOR_EXACT_HUMAN_READ_ONLY_CUTOVER_DECISION`.

- [ ] **Step 1: Add RED adversarial cases** for candidate HEAD drift, parent-cert drift, dirty tracked bytes, nonempty allowedProjects, ACTIVE/activationScope, stale compose/container/listener preimages, shared tunnel mutation attempt, 8768 mutation attempt, existing deployment root/task/state collision, weak ACL fixture, wrong scheduled-task principal, secret in argv/env/evidence, wrong/missing API key, port 8774/18774 collision, real tunnel id in disposable helper, cutover executor hash drift, rollback hash drift, and missing rollback currentness.
- [ ] **Step 2: Implement qualifier preconditions**: PowerShell 7, clean committed bytes, exact M09 ancestry/final-cert SHA, GitHub main ancestry, production 8769 currently `READ_ONLY_EMERGENCY`, 8768/8769 listeners present, 8774/18774 free, no M10 deployment/task/state residue, Docker/tunnel images available, and no preexisting M10-owned containers/processes.
- [ ] **Step 3: Run focused qualification**: all M10 tests plus M09 host/config/parity and M08/M07/M06 adversarial/provenance tests; then typecheck/build.
- [ ] **Step 4: Run exactly one full regression on frozen committed bytes**, parse actual Vitest pass/file counts, require worktree/HEAD unchanged, and write ordinal deterministic tracked-source manifest.
- [ ] **Step 5: Run non-live preflight + disposable parity** from Tasks 2–3; require production container/listener digests unchanged, secret scan zero, fixture residue zero, and manifest stable post-probe.
- [ ] **Step 6: Seal executable identities**: SHA-256 of executor, rollback, preflight, live qualifier, candidate HEAD/manifest, parent cert, exact compose files, sanitized production preimage, and required exact Human decision string `APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER`.
- [ ] **Step 7: Emit decision envelope only if every pre-live gate passes**; otherwise emit a sanitized blocker package and no approval string. The envelope states `production_mutation_performed=false`, `task_created=false`, `secret_created=false`, `tunnel_reconfigured=false`.
- [ ] **Step 8: Commit qualification gates:** `git add tests/m10-adversarial.test.ts scripts/qualify-m10-preflight.ps1 && git commit -m "test: add m10 pre-live qualification"`.
- [ ] **Step 9: Run fresh qualifier on committed bytes:** `pwsh -NoProfile -File .\scripts\qualify-m10-preflight.ps1` and STOP at the exact Human live-cutover boundary.

---

### Task 6: Authorized Read-Only Production Cutover + Dogfood/Fault Drills

**Files:**
- Create before the gate: `scripts/qualify-m10-live.ps1`
- Test before the gate: extend `tests/m10-cutover-transaction.test.ts`, `tests/m10-adversarial.test.ts`
- Runtime/evidence writes after approval only; no source mutation during live execution.

**Authority gate:** Do not execute this task until the Human supplies exact decision `APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER` matching the sealed envelope and all sealed hashes/currentness remain exact.

- [ ] **Step 1: Before Human gate, implement/test `qualify-m10-live.ps1`** as read-only post-cutover verifier: direct 8769 health, dedicated-route initialize/tools/status/capabilities, shared 8768/tunnel currentness, old internal Operator health, scheduled-task identity/principal, secret ACL facts, and residue/secret scans. Commit it before rerunning Task 5 so its SHA is included in the decision envelope.
- [ ] **Step 2: On exact Human approval, rerun envelope currentness only**; do not rerun full regression unless tracked bytes changed. If any HEAD/manifest/script/compose/container/listener binding differs, emit `M10_CUTOVER_AUTHORITY_CURRENTNESS_FAILED` and mutate zero.
- [ ] **Step 3: Execute:** `pwsh -NoProfile -File .\scripts\execute-m10-readonly-cutover.ps1 -DecisionEnvelope <sealed-envelope> -EvidenceRoot <live-run-root>`; executor owns automatic rollback on any failure after mutation begins.
- [ ] **Step 4: Require staged handoff observations**: old Operator stays healthy on Docker network; Windows host exclusively owns loopback 8769 and reports emergency before tunnel switch; dedicated tunnel alone changes route; shared tunnel/container/config/listener identities remain exact.
- [ ] **Step 5: Run read-only dogfood** through the dedicated route only: initialize, exactly 13 tools, `operator_status`, `operator_capabilities`, and a representative mutation denial. No task, transaction, stage/apply/promote, or project mutation may execute.
- [ ] **Step 6: Run bounded fault drills** one at a time with currentness checks between them: missing/wrong header is denied; dedicated tunnel restart reconnects; controlled host-process termination is recovered by `HAIOS-M10-Operator-ReadOnly`; stale config copy is rejected; port-collision probe is performed on a disposable port rather than stealing production 8769.
- [ ] **Step 7: After each drill**, verify 8768/shared tunnel unchanged, old internal Operator healthy, host production mode emergency, dedicated route exact, no leaked secret, and rollback remains executable/current.
- [ ] **Step 8: Run `qualify-m10-live.ps1`** and require terminal `M10_LIVE_READ_ONLY_QUALIFICATION_PASS`; if it fails, execute exact rollback and require terminal `HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_ROLLED_BACK_TO_CERTIFIED_M09_READ_ONLY_STATE`.

---

### Task 7: Independent Read-Only Review + Post-Review Currentness

**Files:**
- Evidence only under the successful `evidence/m10/<RUN_ID>/`; no production/source mutation.

- [ ] **Step 1: Freeze live evidence hashes** for candidate HEAD/manifest, parent cert, executor/rollback/live-qualifier scripts, pre/live/post container and listener identities, task definition, ACL facts, dedicated-route proof, fault drills, and zero-secret scan.
- [ ] **Step 2: Dispatch fresh Codex reviewer read-only** bound to exact HEAD + manifest + live evidence. Reviewer must not rerun unchanged tests/build or mutate Docker/Task Scheduler/files.
- [ ] **Step 3: Reviewer must explicitly verify** authorized mutation scope only, shared `haios-tunnel-client`/8768 preservation, old Operator rollback lane health, sealed deployment currentness, dedicated route targeting host runtime, emergency-only capability state, secret/ACL boundary, supervisor recovery, rollback executability, residue semantics, and blocker_count=0.
- [ ] **Step 4: If reviewer finds a source blocker**, rollback production first if safety/currentness requires it, then remediate source delta with TDD on the M10 development worktree, recommit, rerun Task 5, obtain a new exact Human cutover decision for changed executable bytes, and repeat live cutover. Never reuse the old decision envelope after byte changes.
- [ ] **Step 5: With PASS/0 blockers**, recompute HEAD/manifest, runtime/listener/container/task/ACL currentness and reviewer SHA without changing state.

---

### Task 8: Final Certification + GitHub Integration

**Files:**
- Evidence only: create `m10-final-certification.json`, SHA-256 sidecar, post-cert currentness, and GitHub fast-forward evidence.

- [ ] **Step 1: Create final certification only if** Task 7 blocker_count=0, deployment commit/manifest equals candidate, production 8769 remains `READ_ONLY_EMERGENCY`, shared 8768/tunnel unchanged, old Operator rollback lane healthy, S2 false, destructive locked, production write dogfood false, secrets persisted false, and rollback package current.
- [ ] **Step 2: Final terminal:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER_QUALIFIED`.
- [ ] **Step 3: Fresh seal verification**: verify certification sidecar, every bound input hash, current HEAD/manifest, production mode, shared/dedicated tunnel identities, task identity, rollback currentness, and zero unauthorized residue.
- [ ] **Step 4: GitHub safety gate**: `git fetch origin main`; require `origin/main` is ancestor of certified M10 HEAD, behind=0 locally, worktree clean, public-history secret scan zero, and no unrelated commits.
- [ ] **Step 5: Normal fast-forward only**: push exact certified M10 HEAD to `origin/main`; never force-push. Verify `git ls-remote origin refs/heads/main` equals certified HEAD and persist post-push reconciliation evidence.
- [ ] **Step 6: Do not remove** the old Docker Operator rollback lane or activate production ACTIVE mode after certification. Those are separate future authority milestones.

---

## Execution/Failure Invariants

```text
BEFORE LIVE AUTHORITY:
production mutations = 0
production secret creation = 0
production scheduled task creation = 0
dedicated tunnel recreation = 0

AFTER LIVE AUTHORITY:
any currentness/hash mismatch -> mutate 0 / STOP
any failure after first mutation -> exact rollback transaction
ambiguous rollback drift -> preserve state/evidence / HUMAN decision
shared tunnel or :8768 drift -> immediate blocker + rollback where safe
production mode != READ_ONLY_EMERGENCY -> blocker; ACTIVE is never auto-selected
```

## Self-Review Checklist
- Spec §§1–13 map to Tasks 1–8: production policy (1), topology/preimages (2), secrets/ACL/task supervisor (2/4), disposable preflight (3), staged cutover + rollback (4/6), evidence/qualification (5/6), independent review (7), certification/integration (8).
- No M10 task exposes ACTIVE, `M10_TEST_ONLY`, S2, DESTRUCTIVE, generic shell/exec, remote Git mutation, Docker socket authority, or project mutation.
- Live executor/rollback/live verifier bytes are all created and sealed **before** the Human cutover decision.
- The decision envelope cannot be reused after source/script/compose/runtime-currentness drift.
- No TODO/TBD/placeholder implementation steps remain.
