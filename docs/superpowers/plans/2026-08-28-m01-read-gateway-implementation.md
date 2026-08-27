# M01 READ Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a fail-closed READ-only MCP gateway in front of Desktop Commander Local MCP 0.2.47.

**Architecture:** The gateway is a Streamable HTTP MCP server on loopback and a stdio MCP client to pinned Desktop Commander. It exposes only HAIOS READ wrappers, enforces authentication/path policy before upstream calls, bounds output, and records metadata-only audit events.

**Tech Stack:** Node 24.19.0, TypeScript 7.0.2, @modelcontextprotocol/sdk 1.30.0, zod 4.4.3, Vitest 4.1.11.

**Spec:** `docs/superpowers/specs/2026-08-28-m01-read-gateway-design.md`

## Global Constraints
- Desktop Commander pinned exactly to `0.2.47`.
- Allowed filesystem root exactly `C:\Workspace` for M01.
- Sensitive paths fail closed.
- EXECUTE, MUTATE, and DESTRUCTIVE capabilities remain LOCKED.
- Unauthorized upstream calls must equal zero.
- Existing ports 8768 and 8769 must regress PASS; qualification port 8771 remains free.
- Authentication secrets are runtime-only and never persisted.
- No Tunnel mutation in M01.

---
### Task 1: Project baseline and deterministic dependency lock

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`.

**Interfaces:** Produces the reproducible Node/TypeScript test/build environment used by all later tasks.

- [ ] Write `package.json` with exact dependency pins and scripts: `test`, `test:focused`, `build`, `typecheck`.
- [ ] Run `npm install` and require the lockfile to resolve the declared direct dependency versions exactly.
- [ ] Add TypeScript configuration for NodeNext/ESM, strict mode, `src` + `tests`.
- [ ] Initialize Git if absent, create branch `haios/m01-read-gateway`, and record baseline state.
- [ ] Run empty baseline `npm test -- --run` and TypeScript compile; failures caused only by not-yet-created tests are not allowed.
- [ ] Commit the deterministic project baseline.

### Task 2: Capability registry and deny-before-upstream contract

**Files:** Create `src/capabilities.ts`, `src/policy.ts`, `tests/capability-policy.test.ts`.

**Interfaces:** Produces `READ_TOOL_DEFINITIONS`, `classifyGatewayTool(name)`, and `authorizeTool(name)`; later dispatch must call authorization before any upstream client method.

- [ ] Write failing tests proving only the approved READ wrappers are exposed and unknown/raw mutating names are denied.
- [ ] Verify RED with `npm test -- tests/capability-policy.test.ts`.
- [ ] Implement immutable READ capability definitions plus fail-closed authorization.
- [ ] Add explicit assertions for `write_file`, `edit_block`, `start_process`, `kill_process`, `force_terminate`, and `set_config_value` => DENY.
- [ ] Verify GREEN and commit.
### Task 3: Authentication, path boundary, and sensitive-path policy

**Files:** Create `src/auth.ts`, `src/paths.ts`, `tests/auth.test.ts`, `tests/path-policy.test.ts`.

**Interfaces:** Produces `authenticateApiKey(headers, expectedKey)` and `authorizePath(inputPath)` returning normalized allowed paths or structured denial codes.

- [ ] Write failing tests for missing/wrong/correct key, `C:\Workspace` access, outside-root denial, `..` traversal, case normalization, `.env`, `.git/**`, `*.pem`, `*.key`, `credentials/**`, and `secrets/**`.
- [ ] Verify RED.
- [ ] Implement constant-time API-key comparison and canonical Windows path checks using `path.win32` plus filesystem realpath/reparse checks where the target exists.
- [ ] Require parent-chain containment so symlink/junction escape cannot produce an allowed upstream path.
- [ ] Verify all negative tests GREEN and commit.

### Task 4: Desktop Commander stdio upstream adapter and READ wrappers

**Files:** Create `src/upstream.ts`, `src/tools/read-tools.ts`, `tests/read-tools.test.ts`, `tests/upstream-deny.test.ts`.

**Interfaces:** `DesktopCommanderClient` exposes only typed READ methods; `dispatchReadTool(name,args,ctx)` performs tool authorization and path authorization before `client.callTool`.

- [ ] Write a fake upstream client that records every call.
- [ ] Write failing tests proving denied requests record zero upstream calls.
- [ ] Implement pinned stdio launch: `cmd /d /s /c npx -y @wonderwhy-er/desktop-commander@0.2.47`.
- [ ] Implement wrappers for list/read/multi-read/stat/search/process/session/status operations only.
- [ ] Bound returned text/list payloads and reject malformed/oversized requests before upstream.
- [ ] Verify positive wrapper behavior and `UNAUTHORIZED_UPSTREAM_CALLS=0`; commit.
### Task 5: Streamable HTTP MCP server and metadata-only audit

**Files:** Create `src/audit.ts`, `src/server.ts`, `tests/server-tools-list.test.ts`, `tests/audit.test.ts`.

**Interfaces:** `createGatewayServer(config)` exposes the approved tool surface at `/mcp`; audit records contain request metadata but never file contents or API keys.

- [ ] Write failing tests for HTTP authentication, MCP initialize/tools-list, exact public tool names, and absent raw Desktop Commander mutation tools.
- [ ] Write failing audit tests proving content/key values are not persisted.
- [ ] Implement loopback-only server configuration, API-key middleware, MCP session transport, READ dispatcher, bounded errors, and metadata audit sink.
- [ ] Verify no-auth/wrong-auth => 401; correct auth => initialize/tools-list PASS.
- [ ] Verify audit schema and commit.

### Task 6: M01 qualification harness and adversarial closure

**Files:** Create `scripts/qualify-m01.ps1`, `tests/m01-adversarial.test.ts`; generate `evidence/m01/*` at qualification time.

**Interfaces:** Qualification produces machine-readable gate results, source/tool identities, test results, regression checks, and a terminal verdict without persisting secrets.

- [ ] Add adversarial tests for traversal, sensitive files, junction/reparse escape, unknown tool, raw mutation tool, malformed inputs, oversized output, and auth bypass.
- [ ] Run focused tests first, then full `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Start the gateway transiently on port 8772 with an ephemeral key; perform real MCP initialize/tools-list and representative READ calls against Desktop Commander 0.2.47.
- [ ] Verify port 8768 and 8769 regress PASS and port 8771 remains free.
- [ ] Persist evidence with hashes/tool inventory and assert secrets persisted = false, unauthorized upstream calls = 0.
- [ ] Stop the gateway process tree deterministically and prove qualification port is free.
- [ ] Emit `HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READ_GATEWAY_QUALIFIED` only when every mandatory gate passes; commit final M01 implementation/evidence contract.
