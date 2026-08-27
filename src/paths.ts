import { realpath } from "node:fs/promises";
import { win32 } from "node:path";

export const M01_WORKSPACE_ROOT = "C:\\Workspace";

export type PathDecision =
  | { readonly decision: "ALLOW"; readonly normalizedPath: string }
  | {
      readonly decision: "DENY";
      readonly reason:
        | "AMBIGUOUS_PATH"
        | "OUTSIDE_WORKSPACE"
        | "SENSITIVE_PATH"
        | "REPARSE_ESCAPE";
    };

function comparisonPath(value: string): string {
  return value.replace(/[\\/]+$/, "").toLowerCase();
}

function isWithinRoot(value: string): boolean {
  const root = comparisonPath(M01_WORKSPACE_ROOT);
  const candidate = comparisonPath(value);
  return candidate === root || candidate.startsWith(`${root}\\`);
}

function hasSensitiveSegment(normalized: string): boolean {
  const segments = normalized.split("\\").map((segment) => segment.toLowerCase());
  return segments.some((segment) =>
    segment === ".git" ||
    segment === "credentials" ||
    segment === "secrets" ||
    segment === ".env" ||
    segment.startsWith(".env.") ||
    segment.endsWith(".pem") ||
    segment.endsWith(".key"),
  );
}

async function nearestExistingRealpath(normalized: string): Promise<string | null> {
  let candidate = normalized;
  const root = win32.parse(normalized).root;

  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }

    const parent = win32.dirname(candidate);
    if (candidate === parent || candidate === root) {
      return null;
    }
    candidate = parent;
  }
}

export async function authorizePath(inputPath: string): Promise<PathDecision> {
  if (
    typeof inputPath !== "string" ||
    inputPath.length === 0 ||
    inputPath.includes("\0") ||
    inputPath.startsWith("\\\\?\\") ||
    !win32.isAbsolute(inputPath)
  ) {
    return { decision: "DENY", reason: "AMBIGUOUS_PATH" };
  }

  const normalized = win32.normalize(inputPath);
  if (!isWithinRoot(normalized)) {
    return { decision: "DENY", reason: "OUTSIDE_WORKSPACE" };
  }
  if (hasSensitiveSegment(normalized)) {
    return { decision: "DENY", reason: "SENSITIVE_PATH" };
  }

  try {
    const resolved = await nearestExistingRealpath(normalized);
    if (resolved !== null && !isWithinRoot(win32.normalize(resolved))) {
      return { decision: "DENY", reason: "REPARSE_ESCAPE" };
    }
  } catch {
    return { decision: "DENY", reason: "AMBIGUOUS_PATH" };
  }

  return { decision: "ALLOW", normalizedPath: normalized };
}
