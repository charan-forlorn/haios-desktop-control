# M09 Host Runtime Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and qualify a Windows-host launcher for the certified M08 Operator plus disposable file-backed tunnel-client parity, without changing production 8768/8769.

**Architecture:** Add a small secret-file/config boundary and host-runtime factory around unchanged M08 primitives. Qualify direct host ACTIVE behavior on synthetic local Git bytes, then route read/status traffic through `tunnel-client dev proxy` using a synthetic tunnel id and file-backed `X-API-Key`.

**Tech Stack:** TypeScript, Node.js, Vitest, MCP SDK 1.30.0, PowerShell 7, Git CLI through M06 `LocalOperatorGit`, Docker through M07 `SandboxExecutor`, tunnel-client v0.0.11 dev proxy.

**Spec:** `docs/superpowers/specs/2026-08-28-m09-host-runtime-parity-design.md`

## Global Constraints
- Exact M08 parent HEAD `2228ffc856f7f3170913b5f61fae0234133f4712`, manifest `f5f89514270e052777c4678fd9d6c315ac516ef6ab927ea450d33fbbdd990c1e`, final-cert SHA `11306fafff964ba1518cd2d395cdee4bae489731b109d1a6b6ec62ea1c3c4aee`.
- Preserve M06/M07/M08 production logic unless a failing M09 test proves a narrow adapter is required.
- Host bind is always `127.0.0.1`; M09 qualification port is 8773.
- ACTIVE is test-only in M09 and requires exact `activationScope="M09_TEST_ONLY"`.
- API-key bytes come only from a local file; never inline/log/evidence/git.
- No production 8768/8769/tunnel/container mutation, restart, compose edit, or real tunnel id/channel use.
- Qualification MUST stop before live ACTIVE work while 8769 is not `READ_ONLY_EMERGENCY`.
- S2 disabled, DESTRUCTIVE locked, no generic shell/exec/cwd/env, remote Git, cloud, Docker socket, credential retrieval, or production dogfood.

---

### Task 1: Host Config + Secret File Boundary

**Files:**
- Create: `src/operator/host-runtime-config.ts`
- Test: `tests/m09-host-runtime-config.test.ts`

**Interfaces:**
- Produces `HostOperatorLaunchConfig`, `validateHostOperatorLaunchConfig(value)`, `loadHostApiKey(path)`.
- `HostOperatorLaunchConfig` fields: `apiKeyFile`, `worktreeRoot`, `allowedProjects`, `port`, `mode`, optional `activationScope`.

- [ ] **Step 1: Write RED tests** for exact-key config, fixed host semantics, valid port, frozen cloned `allowedProjects`, ACTIVE scope pairing, absolute file path, regular-file/no-symlink secret, length/control/whitespace rules, and error messages that never contain secret bytes.
- [ ] **Step 2: Run RED:** `npm test -- tests/m09-host-runtime-config.test.ts` and confirm failure because module is absent.
- [ ] **Step 3: Implement minimal config/secret loader** with stable M09 error codes and no secret-return metadata.
- [ ] **Step 4: Run GREEN:** `npm test -- tests/m09-host-runtime-config.test.ts && npm run typecheck`.
- [ ] **Step 5: Commit:** `git add src/operator/host-runtime-config.ts tests/m09-host-runtime-config.test.ts && git commit -m "feat: add m09 host runtime config boundary"`.

---

### Task 2: M08-Derived Host Runtime Factory

**Files:**
- Create: `src/operator/host-runtime.ts`
- Test: `tests/m09-host-runtime.test.ts`
- Regression: `tests/m08-runtime-provenance.test.ts`, `tests/m08-operator-server.test.ts`

**Interfaces:**
- Consumes Task 1 config/key loader plus `createQualifiedOperatorControlRuntime` and `createGatewayServer`.
- Produces `createHostOperatorRuntime(config): Promise<GatewayRuntime>` and non-secret readiness metadata helper.

- [ ] **Step 1: Write RED tests** proving READ_ONLY_EMERGENCY creates operator13 without runtime, ACTIVE requires `M09_TEST_ONLY`, ACTIVE runtime is privately constructed from exact repo registry/effect files, host is always loopback, startup project mapping is fixed, no caller upstream/runtime/registry/effect override exists, and metadata excludes API-key bytes/path contents.
- [ ] **Step 2: Run RED:** `npm test -- tests/m09-host-runtime.test.ts tests/m08-runtime-provenance.test.ts tests/m08-operator-server.test.ts`.
- [ ] **Step 3: Implement minimal host factory** with an internal no-authority upstream stub and exact repository identity paths.
- [ ] **Step 4: Run GREEN + typecheck/build:** focused command above, `npm run typecheck`, `npm run build`.
- [ ] **Step 5: Commit:** `git add src/operator/host-runtime.ts tests/m09-host-runtime.test.ts && git commit -m "feat: add m09 host operator runtime"`.

---

### Task 3: Durable Host Launcher

**Files:**
- Create: `scripts/run-m09-host-runtime.mjs`
- Test: `tests/m09-host-launcher.test.ts`

**Interfaces:**
- Consumes built `dist/src/operator/host-runtime.js` and one non-secret JSON config path.
- Emits readiness metadata only; handles SIGINT/SIGTERM by closing gateway.

- [ ] **Step 1: Write RED static/behavior tests** requiring one config path argument, JSON parsing with exact config validation, no inline API-key option/env fallback, no secret output, no non-loopback bind option, and clean shutdown.
- [ ] **Step 2: Run RED:** `npm test -- tests/m09-host-launcher.test.ts`.
- [ ] **Step 3: Implement launcher**; do not add production service installation or compose changes.
- [ ] **Step 4: Run GREEN + build:** `npm test -- tests/m09-host-launcher.test.ts && npm run build`.
- [ ] **Step 5: Commit:** `git add scripts/run-m09-host-runtime.mjs tests/m09-host-launcher.test.ts && git commit -m "feat: add m09 host runtime launcher"`.

---

### Task 4: Direct Host ACTIVE Synthetic E2E

**Files:**
- Create: `scripts/live-m09-host-parity.mjs`
- Create: `tests/m09-live-helper.test.ts`

**Interfaces:**
- Helper args: runtime root, result path, direct port (qualification uses 8773).
- Produces sanitized JSON with exact-tool/status, promotion, rollback, stale-CAS, cleanup facts and no secret value.

- [ ] **Step 1: Write RED contract tests** requiring temporary API-key file, synthetic Git canonical/worktree roots, `createHostOperatorRuntime`, exact 13 tools, direct ACTIVE lifecycle, canonical unchanged pre-promotion, rollback, stale-CAS zero-write, and final key/worktree cleanup. Assert forbidden strings/operations (`git push/fetch/pull`, real tunnel ids, 8768/8769 mutation, Docker socket, cloud credentials) are absent.
- [ ] **Step 2: Run RED:** `npm test -- tests/m09-live-helper.test.ts`.
- [ ] **Step 3: Implement direct helper** by adapting M08 live flow through the M09 host factory. Use `project.test` and exact M07 sandbox identity.
- [ ] **Step 4: Run GREEN + typecheck/build:** helper test, `npm run typecheck`, `npm run build`.
- [ ] **Step 5: Commit:** `git add scripts/live-m09-host-parity.mjs tests/m09-live-helper.test.ts && git commit -m "test: add m09 direct host parity flow"`.

---

### Task 5: File-Backed Tunnel Dev-Proxy Parity

**Files:**
- Extend: `scripts/live-m09-host-parity.mjs`
- Create: `tests/m09-tunnel-parity.test.ts`

**Interfaces:**
- Uses disposable `ghcr.io/openai/tunnel-client:v0.0.11` with `tunnel-client dev proxy` and synthetic tunnel id only.
- Temporary API key is mounted read-only and supplied by `MCP_EXTRA_HEADERS` as `X-API-Key: file:/run/secrets/m09-api-key`.

- [ ] **Step 1: Write RED tests** requiring dev-proxy image/entrypoint, `host.docker.internal:<directPort>/mcp`, synthetic tunnel id, read-only secret mount, file-backed header, bounded duration, unique M09-owned container name/label, and official SDK connection through local proxy ingress. No real tunnel id/control-plane key/channel may appear.
- [ ] **Step 2: Run RED:** `npm test -- tests/m09-tunnel-parity.test.ts tests/m09-live-helper.test.ts`.
- [ ] **Step 3: Implement parity phase**: start dev proxy, wait for readiness, connect official MCP client through proxy ingress, assert exact 13 tools and controlled ACTIVE status/capabilities, close client, remove owned container, verify secret key never appears in stdout/stderr/result.
- [ ] **Step 4: Run GREEN + focused M09 suite:** `npm test -- tests/m09-*.test.ts`.
- [ ] **Step 5: Commit:** `git add scripts/live-m09-host-parity.mjs tests/m09-tunnel-parity.test.ts && git commit -m "test: add m09 tunnel dev proxy parity"`.

---

### Task 6: Adversarial + Deterministic Qualification

**Files:**
- Create: `tests/m09-adversarial.test.ts`
- Create: `scripts/qualify-m09.ps1`

**Interfaces:**
- Produces `evidence/m09/<RUN_ID>/` qualification package and `independent-review-handoff.json`.

- [ ] **Step 1: Add adversarial tests** for inline-secret denial, symlink secret file, mutable allowed-project input, ACTIVE without scope, wrong scope, non-loopback attempts, registry/effect/runtime injection absence, real tunnel-id literals, Docker-socket authority, caller mode/executable/env/remote fields, and inherited M08 provenance immutability.
- [ ] **Step 2: Run focused GREEN before freeze:** `npm test -- tests/m09-*.test.ts tests/m08-runtime-provenance.test.ts tests/m08-adversarial.test.ts tests/m07-adversarial.test.ts tests/m06-adversarial.test.ts`, then typecheck/build.
- [ ] **Step 3: Implement `qualify-m09.ps1`**. It must require PowerShell 7 and clean committed bytes; bind exact M08 cert/ancestry; snapshot tunnel/container digests and 8768/8769 listener identities; query 8769 health and fail with `M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY` before live ACTIVE work unless mode is `READ_ONLY_EMERGENCY`; assert 8773/proxy port free; verify pinned images; run focused tests; run exactly one final full regression; typecheck/build; write ordinal deterministic source manifest; execute live helper; scan evidence for secrets; assert zero M09/M07 residue; assert long-lived digests/listeners unchanged; assert source manifest stable; emit review handoff.
- [ ] **Step 4: Commit qualification gates:** `git add tests/m09-adversarial.test.ts scripts/qualify-m09.ps1 && git commit -m "test: add m09 host parity qualification"`.
- [ ] **Step 5: Run fresh qualification on committed bytes:** `pwsh -NoProfile -File .\scripts\qualify-m09.ps1`. Current known expectation: it MUST stop at the preexisting 8769 ACTIVE precondition until a separate authorized recovery changes that live state.

Pre-review terminal only after all gates pass:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_READY_FOR_INDEPENDENT_VERIFICATION`

---

### Task 7: Independent Review + Final Certification Preparation

**Files:**
- Evidence only under the current `evidence/m09/<RUN_ID>/`.

- [ ] **Step 1:** If Task 6 is precondition-blocked by live 8769 ACTIVE, persist the sanitized blocker result and STOP before independent certification; do not alter production.
- [ ] **Step 2:** After an externally authorized restoration to READ_ONLY_EMERGENCY, rerun one fresh qualification on unchanged committed bytes. Do not rerun earlier full regression if the qualification bytes/evidence remain current unless the qualification script requires the single frozen-byte run.
- [ ] **Step 3:** Dispatch fresh read-only Codex review bound to exact HEAD + deterministic manifest; reviewer verifies M09 host config/secret boundary, M08 provenance, direct E2E, dev-proxy parity, no real tunnel authority, long-lived integrity, zero residue, and evidence currentness. No unchanged test rerun.
- [ ] **Step 4:** Remediate only reviewer blockers with delta TDD, recommit, one fresh qualification, and scoped re-review.
- [ ] **Step 5:** With blocker_count=0, perform fresh post-review currentness and create `m09-final-certification.json` + SHA-256 sidecar. Final terminal: `HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY_QUALIFIED`.

Final cert must state: production 8769 remains `READ_ONLY_EMERGENCY`; production dogfood not activated; S2 disabled; DESTRUCTIVE locked; no tunnel cutover performed.