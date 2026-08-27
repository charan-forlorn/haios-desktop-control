# HAIOS Desktop Control Plane R1 — M02 Controlled Execute Design

**Mission:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M02_CONTROLLED_EXECUTE`

**Status:** DESIGN LOCK CANDIDATE

**Parent certification:** `HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READ_GATEWAY_QUALIFIED`

## 1. Objective

M02 adds bounded EXECUTE capability without exposing arbitrary shell access. M01 READ behavior remains unchanged and independently testable.

The gateway may internally call Desktop Commander `start_process`, but downstream clients never receive raw `start_process`, `interact_with_process`, process termination, filesystem mutation, or configuration tools.

M02 is a pilot for exactly `C:\Workspace\haios-desktop-control`; expansion to arbitrary projects is a later qualification step.

## 2. Capability State

```text
READ        = QUALIFIED
EXECUTE     = QUALIFICATION_CANDIDATE
MUTATE      = LOCKED
DESTRUCTIVE = LOCKED
```
## 3. Downstream Execute Surface

M02 adds only six HAIOS-owned tools:

- `project_test`
- `project_typecheck`
- `project_build`
- `git_status`
- `git_diff`
- `git_log`

There is no generic command parameter. Each tool maps to a fixed command template owned by HAIOS.

`git_diff` accepts only `mode = working | staged`. `git_log` accepts only a validated integer `maxCount` in the range 1..20. Project root is not client-controlled in M02.

## 4. Command Profiles

```text
project_test      -> npm test
project_typecheck -> npm run typecheck
project_build     -> npm run build
git_status        -> git status --short --branch
git_diff working  -> git diff --
git_diff staged   -> git diff --cached --
git_log N         -> git log -N --oneline --decorate
```

Commands execute only from the exact M02 project root. User-provided text is never concatenated into a shell command.
## 5. Execution Guard

Every execute request follows:

```text
AUTHENTICATE
 -> CLASSIFY EXECUTE TOOL
 -> VALIDATE TYPED INPUT
 -> SELECT FIXED PROFILE
 -> CAPTURE PRE-EXECUTION CURRENTNESS
 -> START BOUNDED PROCESS
 -> CAPTURE BOUNDED OUTPUT
 -> VERIFY PROCESS EXIT/CLEANUP
 -> CAPTURE POST-EXECUTION CURRENTNESS
 -> AUDIT
```

Unknown profiles, malformed inputs, command fragments, shell metacharacters, arbitrary paths, or unclassified tools fail closed before `start_process` is called.

## 6. Mutation Boundary

M02 permits execution side effects only when they are expected runtime/regenerable artifacts. It does not authorize source, configuration, Git-index, Git-ref, or credential mutation.

For every profile the gateway records a deterministic pre/post tracked-state digest. A changed tracked-state digest causes the execution result to fail closed as `UNAUTHORIZED_MUTATION_DETECTED`.

`project_build` may update ignored `dist/**`; tests may create and clean temporary files. Such artifacts do not grant MUTATE capability.
## 7. Runtime Bounds

- default timeout: 120 seconds
- hard maximum timeout: 180 seconds
- captured output: maximum 64 KiB per execution
- output truncation must be explicit
- only one process per request in M02
- no interactive stdin
- no detached/background processes
- no process termination tools exposed downstream
- the gateway may use internal `read_process_output` to observe only the PID returned by its own `start_process` call
- on hard timeout only, the gateway may use internal `kill_process` against that exact gateway-owned PID as a cleanup guard; clients cannot select a PID or invoke termination

Timeout or protocol uncertainty returns DENY/ERROR. Qualification must prove cleanup is exact-target, bounded, and leaves no mission-owned process tree. Cleanup-only termination does not unlock DESTRUCTIVE capability.

## 8. Explicitly Locked Capabilities

The following remain unavailable downstream:

- raw `start_process`
- `interact_with_process`
- `kill_process`
- `force_terminate`
- `write_file`, `edit_block`, `move_file`, `create_directory`, `write_pdf`
- `set_config_value`
- arbitrary PowerShell, cmd, bash, Python, Node, Docker, Git, npm, or npx commands
- package installation
- Git commit/reset/checkout/switch/add/restore
- Docker start/stop/restart/rm/exec
## 9. Qualification Gates

### G1 — M01 Preservation
- all M01 tests remain PASS
- M01 READ surface remains exact
- M01 certified source lineage remains traceable

### G2 — Positive Execute
- project_test PASS
- project_typecheck PASS
- project_build PASS
- git_status PASS
- git_diff working/staged PASS
- git_log bounded PASS

### G3 — Injection / Escape
- arbitrary command input impossible by schema
- unexpected properties denied
- invalid enum/integer denied
- shell metacharacter payloads never reach upstream
- wrong project/path cannot be selected

### G4 — Mutation Detection
- tracked-state digest stable for successful profiles
- simulated tracked mutation is detected and fails qualification
- Git index/ref remain unchanged

### G5 — Process Safety
- timeout enforced
- output bound enforced
- exit code recorded
- process cleanup verified
- no interactive/background execution

### G6 — Independent Closure
- full tests/typecheck/build PASS
- live Desktop Commander execution profiles PASS
- ports 8768/8769 regress PASS
- ports 8771/8772 qualification state preserved
- independent read-only review PASS with 0 blockers
## 10. Definition of Done

```text
M01_READ_CAPABILITY=QUALIFIED
M02_EXECUTE_CAPABILITY=QUALIFIED
MUTATE_CAPABILITY=LOCKED
DESTRUCTIVE_CAPABILITY=LOCKED
RAW_START_PROCESS_EXPOSED=false
ARBITRARY_SHELL_EXPOSED=false
COMMAND_INJECTION_TESTS=PASS
TRACKED_SOURCE_MUTATION_COUNT=0
PROCESS_CLEANUP=PASS
M02_INDEPENDENT_VERIFICATION=PASS
```

Successful terminal:

`HAIOS_DESKTOP_CONTROL_PLANE_R1_M02_CONTROLLED_EXECUTE_QUALIFIED`

M02 qualification unlocks design/implementation work for transactional MUTATE. It does not authorize raw shell access or privileged/destructive operations.
