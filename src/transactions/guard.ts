import { lstat, realpath } from "node:fs/promises";
import { win32 } from "node:path";

import { authorizePath } from "../paths.js";
import { TRANSACTION_PROJECT_ROOT } from "./currentness.js";

const PROJECT_ROOT = TRANSACTION_PROJECT_ROOT.toLowerCase();

export type RemoveTargetGuardResult =
  | { readonly decision: "ALLOW"; readonly normalizedPath: string }
  | { readonly decision: "DENY"; readonly reason: "PATH_DENIED" | "REMOVE_TARGET_NOT_REGULAR_FILE" | "REMOVE_TARGET_MISSING" };

function projectScoped(normalizedPath: string): boolean {
  const lower = normalizedPath.toLowerCase();
  return lower === PROJECT_ROOT || lower.startsWith(`${PROJECT_ROOT}\\`);
}

async function nearestExistingProjectRealpath(normalizedPath: string): Promise<string | null> {
  let candidate = normalizedPath;
  const volumeRoot = win32.parse(normalizedPath).root;
  while (true) {
    try {
      return win32.normalize(await realpath(candidate));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    const parent = win32.dirname(candidate);
    if (parent === candidate || candidate === volumeRoot) return null;
    candidate = parent;
  }
}

export async function authorizeProjectPath(input: string): Promise<string | null> {
  const decision = await authorizePath(input);
  if (decision.decision !== "ALLOW" || !projectScoped(decision.normalizedPath)) return null;
  const resolvedAncestor = await nearestExistingProjectRealpath(decision.normalizedPath);
  if (resolvedAncestor === null || !projectScoped(resolvedAncestor)) return null;
  return decision.normalizedPath;
}

export async function authorizeRemoveTarget(input: string): Promise<RemoveTargetGuardResult> {
  const normalizedPath = await authorizeProjectPath(input);
  if (normalizedPath === null) return { decision: "DENY", reason: "PATH_DENIED" };
  try {
    const stat = await lstat(normalizedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { decision: "DENY", reason: "REMOVE_TARGET_NOT_REGULAR_FILE" };
    }
  } catch {
    return { decision: "DENY", reason: "REMOVE_TARGET_MISSING" };
  }
  return { decision: "ALLOW", normalizedPath };
}