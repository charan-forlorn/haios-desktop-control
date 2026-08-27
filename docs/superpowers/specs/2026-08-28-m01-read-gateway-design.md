# HAIOS Desktop Control Plane R1 — M01 READ Gateway Design

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READ_GATEWAY`

**Status:** APPROVED DESIGN — SPECIFICATION LOCK CANDIDATE

**Date:** 2026-08-28

## 1. Objective

M01 introduces the first production-oriented policy boundary between an MCP client and Desktop Commander Local MCP. The gateway must expose only bounded, explicitly classified READ capabilities while keeping EXECUTE, MUTATE, and DESTRUCTIVE capabilities unavailable.

The M01 gateway is a new MCP server that acts as an MCP client to Desktop Commander Local MCP `0.2.47` over `stdio`. It is not a transparent proxy: every exposed tool is a HAIOS-owned wrapper with its own schema, policy checks, output bounds, and audit event.

## 2. Certified Baseline

Q2R1 established the transport baseline used by this design:

- Desktop Commander version: `0.2.47`
- Desktop Commander transport: `stdio`
- Upstream raw tool count: `26`
- Docker-to-Windows transport: qualified through `host.docker.internal`
- Existing HAIOS ports `8768` and `8769`: regression PASS
- Q2R1 bridge authentication negative test: HTTP `401`
- Q2R1 transient bridge cleanup: PASS; port `8771` returned free

## 3. Architecture

```text
MCP Client / later OpenAI Secure MCP Tunnel
                |
                v
HAIOS Desktop Policy Gateway
Streamable HTTP /mcp
                |
        Authentication
                |
       Capability Registry
                |
         Path Policy
                |
        Output Bounding
                |
          Audit Event
                |
                v
Desktop Commander Local MCP 0.2.47
             stdio
                |
                v
           Windows Host
```

The production M01 path does not require `mcp-proxy`. The Q2R1 proxy remains qualification tooling only. The gateway owns downstream Streamable HTTP and upstream Desktop Commander stdio lifecycle directly.

## 4. Capability Classes

The control plane uses four monotonic capability classes:

- `READ`: observable, non-mutating access. M01 may expose this class.
- `EXECUTE`: commands/processes capable of computation or side effects. Locked in M01.
- `MUTATE`: filesystem/project/config changes. Locked in M01.
- `DESTRUCTIVE`: termination, privileged configuration, destructive runtime actions. Locked in M01.

## 5. M01 Downstream Tool Surface

M01 exposes HAIOS-owned names rather than raw Desktop Commander names:

- `desktop_status`
- `gateway_status`
- `filesystem_list`
- `filesystem_read`
- `filesystem_read_multiple`
- `filesystem_stat`
- `search_start`
- `search_results`
- `search_stop`
- `search_list`
- `process_list`
- `session_list`

The gateway may call these Desktop Commander tools internally:

- `list_directory`
- `read_file`
- `read_multiple_files`
- `get_file_info`
- `start_search`
- `get_more_search_results`
- `stop_search`
- `list_searches`
- `list_processes`
- `list_sessions`
- sanitized internal `get_config` only for identity/status checks

No raw upstream tool name is automatically exported downstream.

## 6. Explicitly Locked Upstream Capabilities

M01 must not expose or dispatch any of the following raw capabilities:

- `create_directory`
- `edit_block`
- `move_file`
- `write_file`
- `write_pdf`
- `start_process`
- `interact_with_process`
- `kill_process`
- `force_terminate`
- `set_config_value`
- `give_feedback_to_desktop_commander`
- `get_prompts`

Any unknown or unclassified tool request fails closed before an upstream call is made. The M01 evidence set must prove unauthorized upstream dispatch count equals zero.

## 7. Filesystem Scope

The initial authorized filesystem root is exactly:

`C:\Workspace`

The gateway canonicalizes paths before authorization. A request is denied if the canonical target is outside the authorized root, escapes through `..`, resolves through a symlink/reparse point to an outside target, or targets a denied sensitive path.

Initial sensitive-path deny rules include:

- `.env` and `.env.*`
- `*.pem`
- `*.key`
- `.git/**`
- `credentials/**`
- `secrets/**`

Path comparison must be Windows-aware and fail closed on normalization ambiguity.

## 8. Authentication and Secret Handling

The downstream gateway requires an API key supplied through runtime environment or an equivalent secret mount. The key must never be committed, printed, written into durable evidence, or included in audit records.

Required authentication behavior:

- missing key: HTTP `401`
- incorrect key: HTTP `401`
- correct key: MCP initialize may proceed

The gateway must not inherit the Desktop Commander configuration as its authority model. HAIOS policy remains authoritative even if Desktop Commander itself is configured with broader filesystem access.

## 9. Request Pipeline

Every downstream call follows this deterministic order:

```text
AUTHENTICATE
  -> CLASSIFY TOOL
  -> VALIDATE INPUT SCHEMA
  -> AUTHORIZE PATH/SCOPE
  -> DISPATCH ALLOWED UPSTREAM TOOL
  -> BOUND/SANITIZE OUTPUT
  -> EMIT AUDIT EVENT
```

Failure or uncertainty at any stage terminates the request as DENIED. No fallback from a denied HAIOS wrapper to a raw Desktop Commander call is permitted.

## 10. Output Bounding

READ does not imply unlimited exfiltration. Every file read, search, directory listing, process listing, and upstream diagnostic must have deterministic result bounds. Truncation must be explicit in the response metadata rather than silently dropping content.

Audit records store metadata only; they do not persist returned file contents, terminal output, credentials, API keys, or secret-bearing request payloads.

## 11. Audit Contract

Each gateway decision emits a bounded metadata event containing at least:

- timestamp
- request ID
- downstream tool name
- capability class
- normalized target scope where applicable
- policy decision (`ALLOW` or `DENY`)
- result class
- duration

Audit events must support proving that denied capability requests never reached Desktop Commander upstream.

## 12. M01 Qualification Gates

### G1 — Identity

- Desktop Commander version equals `0.2.47`.
- Upstream transport equals `stdio`.
- Gateway build/config identity is recorded in evidence.

### G2 — Positive READ

- directory listing PASS
- text file read PASS
- multi-file read PASS
- file metadata PASS
- search lifecycle PASS
- process listing PASS
- session listing PASS

### G3 — Capability Isolation

Calls equivalent to `write_file`, `edit_block`, `start_process`, `kill_process`, `force_terminate`, and `set_config_value` must be absent downstream or return DENIED without upstream dispatch.

### G4 — Filesystem Adversarial

The following must fail closed:

- target outside `C:\Workspace`
- `..` traversal escape
- absolute path outside the authorized root
- symlink/reparse escape
- sensitive-path access
- case or normalization bypass

### G5 — Authentication and Protocol

- no authentication -> HTTP `401`
- wrong authentication -> HTTP `401`
- valid authentication -> initialize PASS
- `tools/list` PASS
- downstream tool surface equals the M01 allowlist only

### G6 — Regression and Independence

- existing HAIOS Secure MCP on `8768` remains available and unchanged
- existing HAIOS Operator MCP on `8769` remains available and unchanged
- Q2R1 qualification port `8771` remains free outside qualification runs
- existing tunnel configuration is not modified by M01
- independent read-only verification confirms source/evidence currentness before M01 seal

## 13. M01 Definition of Done

M01 is qualified only when all gates pass and durable evidence supports:

```text
M01_GATEWAY_IMPLEMENTED=true
READ_CAPABILITY=QUALIFIED
EXECUTE_CAPABILITY=LOCKED
MUTATE_CAPABILITY=LOCKED
DESTRUCTIVE_CAPABILITY=LOCKED
UNAUTHORIZED_UPSTREAM_CALLS=0
PATH_ESCAPE_TESTS=PASS
AUTH_NEGATIVE_TESTS=PASS
SENSITIVE_PATH_TESTS=PASS
DESKTOP_COMMANDER_VERSION=0.2.47
EXISTING_SECURE_MCP_REGRESSION=PASS
EXISTING_OPERATOR_MCP_REGRESSION=PASS
M01_INDEPENDENT_VERIFICATION=PASS
```

## 14. Non-Goals for M01

M01 does not:

- bind the gateway to an OpenAI Secure MCP Tunnel
- enable arbitrary PowerShell or command execution
- write, edit, move, create, or delete project files through the gateway
- terminate processes
- change Desktop Commander configuration
- alter Windows Firewall or OS security settings
- replace the existing HAIOS Secure MCP independent verifier
- retire the existing HAIOS Operator MCP

These capabilities belong to later Plan A milestones and remain locked even if the upstream Desktop Commander server technically supports them.

## 15. Planned Source Boundaries

Implementation should keep responsibilities separate:

```text
src/server.ts             downstream MCP transport/lifecycle
src/upstream.ts           Desktop Commander stdio client/lifecycle
src/policy.ts             capability classification and authorization
src/paths.ts              Windows path canonicalization/boundary rules
src/auth.ts               downstream API-key validation
src/audit.ts              metadata-only audit events
src/tools/read-tools.ts   HAIOS READ wrappers and schemas
```

Tests must mirror these boundaries and include positive, negative, adversarial, and regression coverage.

## 16. Promotion Boundary

Successful M01 qualification unlocks design/implementation work for the next Plan A milestone only. It does not automatically authorize EXECUTE capability.

M01 terminal on successful independent certification:

`HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READ_GATEWAY_QUALIFIED`
