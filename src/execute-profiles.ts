const PROJECT_ROOT = "C:\\Workspace\\haios-desktop-control";
const PREFIX = `Set-Location -LiteralPath '${PROJECT_ROOT}'; `;
const SHELL = "powershell" as const;

export interface ResolvedExecutionProfile {
  readonly command: string;
  readonly timeoutMs: number;
  readonly shell: typeof SHELL;
}

interface ProfileDescriptor {
  readonly kind: "fixed" | "git_diff" | "git_log";
  readonly command?: string;
  readonly timeoutMs: number;
}

function descriptor(value: ProfileDescriptor): Readonly<ProfileDescriptor> {
  return Object.freeze(value);
}

export const EXECUTION_PROFILES = Object.freeze({
  project_test: descriptor({ kind: "fixed", command: `${PREFIX}& npm.cmd test`, timeoutMs: 120_000 }),
  project_typecheck: descriptor({ kind: "fixed", command: `${PREFIX}& npm.cmd run typecheck`, timeoutMs: 120_000 }),
  project_build: descriptor({ kind: "fixed", command: `${PREFIX}& npm.cmd run build`, timeoutMs: 120_000 }),
  git_status: descriptor({ kind: "fixed", command: `${PREFIX}& git status --short --branch`, timeoutMs: 30_000 }),
  git_diff: descriptor({ kind: "git_diff", timeoutMs: 30_000 }),
  git_log: descriptor({ kind: "git_log", timeoutMs: 30_000 }),
});

export type ExecutionProfileName = keyof typeof EXECUTION_PROFILES;
type Resolution =
  | { readonly decision: "ALLOW"; readonly profile: ResolvedExecutionProfile }
  | { readonly decision: "DENY"; readonly reason: "PROFILE_DENIED" | "INVALID_ARGUMENTS" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((key) => allowed.includes(key));
}

function allow(command: string, timeoutMs: number): Resolution {
  return {
    decision: "ALLOW",
    profile: Object.freeze({ command, timeoutMs, shell: SHELL }),
  };
}

export function resolveExecutionProfile(name: string, rawArgs: unknown): Resolution {
  if (!(name in EXECUTION_PROFILES)) return { decision: "DENY", reason: "PROFILE_DENIED" };
  const args = isRecord(rawArgs) ? rawArgs : {};
  const descriptor = EXECUTION_PROFILES[name as ExecutionProfileName];

  if (descriptor.kind === "fixed") {
    if (!onlyKeys(args, [])) return { decision: "DENY", reason: "INVALID_ARGUMENTS" };
    return allow(descriptor.command ?? "", descriptor.timeoutMs);
  }
  if (descriptor.kind === "git_diff") {
    if (!onlyKeys(args, ["mode"])) return { decision: "DENY", reason: "INVALID_ARGUMENTS" };
    const mode = args.mode ?? "working";
    if (mode !== "working" && mode !== "staged") {
      return { decision: "DENY", reason: "INVALID_ARGUMENTS" };
    }
    const command = mode === "staged"
      ? `${PREFIX}& git diff --cached --`
      : `${PREFIX}& git diff --`;
    return allow(command, descriptor.timeoutMs);
  }

  if (!onlyKeys(args, ["maxCount"])) {
    return { decision: "DENY", reason: "INVALID_ARGUMENTS" };
  }
  const maxCount = args.maxCount ?? 10;
  if (!Number.isInteger(maxCount) || typeof maxCount !== "number" || maxCount < 1 || maxCount > 20) {
    return { decision: "DENY", reason: "INVALID_ARGUMENTS" };
  }
  return allow(
    `${PREFIX}& git log -${maxCount} --oneline --decorate`,
    descriptor.timeoutMs,
  );
}
