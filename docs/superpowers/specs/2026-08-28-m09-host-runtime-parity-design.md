# M09 Host Runtime Parity

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY`
**Date:** 2026-08-28
**Status:** implementation authorized by the Human continuation instruction after certified M08
**Parent:** M08 `HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_CONTROLLED_OPERATOR_WIRING_QUALIFIED`
**Parent HEAD:** `2228ffc856f7f3170913b5f61fae0234133f4712`
**Parent manifest:** `f5f89514270e052777c4678fd9d6c315ac516ef6ab927ea450d33fbbdd990c1e`
**Parent final-cert SHA-256:** `11306fafff964ba1518cd2d395cdee4bae489731b109d1a6b6ec62ea1c3c4aee`

## 1. Objective
M09 turns the certified M08 Windows-host runtime into a launchable, tunnel-parity-qualified candidate without rewriting M06/M07 path or sandbox primitives for Linux and without changing the long-lived production Operator/tunnels.

M09 is a **parity and launchability milestone**, not production activation. Its final state must leave production 8768/8769 and all existing tunnel containers unchanged. S2 remains disabled and DESTRUCTIVE remains locked.

## 2. Architectural Decision
Selected approach: **Windows host runtime + disposable tunnel-client dev proxy**.

Reasons:
- M06/M07 security primitives are certified with `node:path.win32` and Windows realpaths.
- M07 `SandboxExecutor` is certified to invoke Docker CLI from the Windows host; moving it into the Operator container would require Docker-socket authority.
- Docker Desktop proves containers can reach a host loopback service through `host.docker.internal`.
- `tunnel-client v0.0.11 dev proxy` provides an in-memory control plane and local MCP ingress using a synthetic tunnel id, so parity can be tested without any production tunnel id/channel.
- `MCP_EXTRA_HEADERS` / `--mcp.extra-headers` support file-backed values, allowing `X-API-Key` to remain secret-file backed.

Rejected:
1. Port M06/M07 to POSIX/Linux now — too broad and invalidates certified path-security assumptions.
2. Mount Docker socket into the Operator container — expands privileged authority.
3. Reuse a real OpenAI tunnel during qualification — unnecessary production coupling.

## 3. Current Live-State Drift
Read-only reconciliation on 2026-08-28 found the existing `haios-operator-mcp` container healthy on 8769 but actually booted `ACTIVE` while compose contains both `HAIOS_OPERATOR_MODE=READ_ONLY_EMERGENCY` and `HAIOS_OPERATOR_BOOT_MODE=ACTIVE`. The old bootstrap consumes `HAIOS_OPERATOR_BOOT_MODE`.

M09 MUST NOT remediate this live state itself. Qualification must fail before any disposable ACTIVE work with `M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY` unless live 8769 reports `READ_ONLY_EMERGENCY`. Restoring/changing 8769 is a separate human-authorized production action.

## 4. Host Launch Configuration
Create a narrow host-launch config whose only authority-bearing inputs are operator-owned startup data:
- `apiKeyFile`: absolute local file path; API-key bytes are never accepted inline.
- `worktreeRoot`: absolute Windows path for generated transaction worktrees.
- `allowedProjects`: fixed startup map of project id -> exact canonical root.
- `port`: explicit TCP port; M09 qualification uses 8773.
- `mode`: `READ_ONLY_EMERGENCY` or `ACTIVE`.
- `activationScope`: required exact value `M09_TEST_ONLY` when `mode=ACTIVE`; forbidden otherwise.

The host is always `127.0.0.1`; caller input cannot select another bind address.

Registry/effect paths are not configurable. The launcher binds repository `task-registry.m07.json` and `task-effects.m07.json`, whose identities remain enforced by `createQualifiedOperatorControlRuntime()`.

## 5. Secret File Contract
`loadHostApiKey(path)` must fail closed unless:
- path is absolute;
- target exists and is a regular non-symlink file;
- file size is 16..512 bytes;
- at most one final LF or CRLF is removed;
- resulting value is 16..512 characters;
- no NUL, CR, LF, leading/trailing whitespace remains.

Errors contain only stable reason codes, never secret bytes. The key is held only in memory and passed directly to `createGatewayServer`; it is never returned in metadata or written to evidence.

## 6. Host Runtime Construction
`createHostOperatorRuntime(config)` must:
1. validate/freeze config and allowed-project mapping;
2. load API key from file;
3. create a no-authority upstream stub used only because `createGatewayServer` requires an upstream interface;
4. for `READ_ONLY_EMERGENCY`, call `createGatewayServer({protocolMode:"operator13"})` with no active runtime;
5. for `ACTIVE`, require `activationScope="M09_TEST_ONLY"`, construct `createQualifiedOperatorControlRuntime()` from exact M08 identities, and inject it into `createGatewayServer({protocolMode:"operator13",operatorMode:"ACTIVE"})`;
6. bind only `127.0.0.1:<port>`.

No M09 API may accept a generic executable, shell, cwd, env, Docker socket, remote Git target, cloud endpoint, tunnel id, or tunnel channel.

## 7. Durable Host Launcher
Add a small Node launcher that consumes one JSON config-file path and starts the built `dist` host runtime. The JSON file contains only non-secret configuration and a pointer to `apiKeyFile`; secret bytes never appear in argv/config/log output.

The launcher prints only non-secret readiness metadata: host, port, mode, exact M08 runtime profile/registry/effect identities. Signal shutdown closes the gateway cleanly.

## 8. Tunnel Parity Gate
Use a disposable container only:
- image `ghcr.io/openai/tunnel-client:v0.0.11`;
- entrypoint `tunnel-client dev proxy`;
- synthetic default tunnel id `tunnel_22222222222222222222222222222222`;
- MCP target `http://host.docker.internal:8773/mcp`;
- local ingress bound in the disposable container and mapped to a disposable host port;
- `MCP_EXTRA_HEADERS` supplies `X-API-Key: file:/run/secrets/m09-api-key`;
- the same temporary key file is mounted read-only into the container.

The parity client uses the official MCP SDK against the dev-proxy ingress and proves exactly 13 tools and expected status/capabilities. No real tunnel id, OpenAI control-plane key, cloud endpoint mutation, or existing tunnel container is used.

## 9. Disposable ACTIVE Flow
On synthetic local Git bytes only, M09 ACTIVE qualification must prove through the host MCP surface:
1. exact 13 tools;
2. ACTIVE status with S2 false, genericExec false, DESTRUCTIVE locked;
3. begin/stage/validate/apply;
4. canonical unchanged before promotion;
5. bounded S0 task execution through M07 sandbox;
6. checkpoint and ff-only CAS promotion;
7. separate rollback path;
8. stale-CAS denial with zero canonical mutation;
9. all generated worktrees/branches and M07-owned containers/networks cleaned.

The same helper then proves dev-proxy header parity using read/status/list operations only; the proxy does not need to mutate the synthetic project.

## 10. Authority Table
| Authority | M09 |
|---|---|
| Exact 13-tool operator surface | qualified candidate |
| M06 local transaction/checkpoint/CAS | reused unchanged |
| M07 S0/S1 bounded task runner | reused unchanged |
| S2 | disabled |
| DESTRUCTIVE | locked |
| Generic shell/exec/cwd/env | denied |
| Remote Git/push/fetch/pull | denied |
| Cloud/production mutation | denied |
| Docker socket in Operator | denied |
| API key inline/log/evidence | denied |
| Production 8768/8769 mutation | denied |
| Real tunnel id/channel use in M09 | denied |
| Disposable dev proxy | allowed for qualification only |

## 11. Fail-Closed Errors
Stable M09 reasons include:
- `M09_HOST_CONFIG_INVALID`
- `M09_API_KEY_PATH_INVALID`
- `M09_API_KEY_FILE_INVALID`
- `M09_ACTIVE_SCOPE_REQUIRED`
- `M09_ACTIVE_SCOPE_NOT_AUTHORIZED`
- `M09_PORT_INVALID`
- `M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY`
- `M09_TUNNEL_PARITY_FAILED`
- `M09_SECRET_PERSISTENCE_DETECTED`
- `M09_RESIDUE_DETECTED`

Unknown/partial state is failure, never promotion.

## 12. Qualification Gates
M09 qualification requires committed clean bytes and proves:
1. exact M08 parent ancestry/final-cert/hash binding;
2. focused M09 tests PASS before broad regression;
3. M08 provenance/immutability regressions remain PASS;
4. typecheck/build PASS;
5. one final full regression only on frozen committed candidate;
6. deterministic tracked-source manifest stable before/after live work;
7. 8768/8769 listener identities and existing tunnel/container integrity digests unchanged;
8. **preexisting 8769 mode is READ_ONLY_EMERGENCY before any M09 ACTIVE live work**;
9. 8773 and dev-proxy ingress port start/end free;
10. pinned M07 sandbox image identity unchanged;
11. direct host ACTIVE synthetic E2E PASS;
12. file-backed X-API-Key parity through disposable `dev proxy` PASS;
13. no real tunnel/control-plane credentials used;
14. zero M09/M07 Docker container/network/worktree/runtime residue;
15. persisted secret scan zero;
16. production/dogfood activation false;
17. independent exact-byte read-only review returns blocker_count=0.

## 13. Evidence and Review
Qualification writes only under `evidence/m09/<RUN_ID>/`: focused log, full-test log, direct-live result, tunnel-parity result, pre/post manifests, sanitized runtime/tunnel integrity snapshots, qualification result, and independent-review handoff. Secret files live under ignored runtime paths and are deleted before result emission.

Pre-review terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_READY_FOR_INDEPENDENT_VERIFICATION`

Final zero-blocker terminal:
`HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY_QUALIFIED`

## 14. Exit State / Non-Goals
A successful M09 certifies only a host-launchable M08-derived runtime and disposable tunnel parity. It does **not** switch 8769, change compose, restart long-lived containers, change ChatGPT connector routing, activate dogfood, enable S2, or grant production write authority.

After M09, production remains `READ_ONLY_EMERGENCY`; a later M10/activation decision must bind exact M09 certified bytes to the long-lived launcher/tunnel configuration and separately authorize the cutover.