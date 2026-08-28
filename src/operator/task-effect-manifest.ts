import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, win32 } from "node:path";

import type { BoundTaskEffectPolicy } from "./task-effects.js";

export type TaskEffectEntryType = "file" | "symlink";
export interface TaskEffectManifestEntry {
  readonly path: string;
  readonly type: TaskEffectEntryType;
  readonly size: number;
  readonly sha256: string;
}
export interface TaskEffectManifest {
  readonly root: string;
  readonly entries: readonly TaskEffectManifestEntry[];
  readonly totalBytes: number;
}
export interface TaskEffectManifestLimits {
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}
export type TaskEffectClassification = "ALLOWED_ARTIFACT" | "UNCLASSIFIED" | "PROTECTED";
export interface TaskEffectDelta {
  readonly path: string;
  readonly operation: "CREATED" | "MODIFIED" | "REMOVED";
  readonly classification: TaskEffectClassification;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
function deny(reason: string): never { throw new Error(`TASK_EFFECT_MANIFEST_DENIED:${reason}`); }
function classifyDeny(reason: string): never { throw new Error(`TASK_EFFECT_CLASSIFICATION_DENIED:${reason}`); }
function posixRelative(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}
function validLimit(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) deny(`LIMIT:${name}`);
  return value;
}
function sameEntry(left: TaskEffectManifestEntry | undefined, right: TaskEffectManifestEntry | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.type === right.type && left.size === right.size && left.sha256 === right.sha256;
}

export async function captureTaskEffectManifest(
  root: string,
  limits: TaskEffectManifestLimits = {},
): Promise<TaskEffectManifest> {
  const rootReal = win32.normalize(await realpath(root));
  const maxEntries = validLimit(limits.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, DEFAULT_MAX_ENTRIES, "ENTRIES");
  const maxFileBytes = validLimit(limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, DEFAULT_MAX_FILE_BYTES, "FILE_BYTES");
  const maxTotalBytes = validLimit(limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 1, DEFAULT_MAX_TOTAL_BYTES, "TOTAL_BYTES");
  const entries: TaskEffectManifestEntry[] = [];
  let totalBytes = 0;

  async function walk(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      if (child.name === ".git") continue;
      const absolute = join(directory, child.name);
      const rel = posixRelative(rootReal, absolute);
      if (rel.startsWith("../") || rel === "..") deny("PATH_ESCAPE");      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        entries.push(Object.freeze({ path: rel, type: "symlink", size: stat.size, sha256: "" }));
      } else if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      } else if (stat.isFile()) {
        if (stat.size > maxFileBytes) deny("FILE_BYTES");
        totalBytes += stat.size;
        if (totalBytes > maxTotalBytes) deny("TOTAL_BYTES");
        const bytes = await readFile(absolute);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        entries.push(Object.freeze({ path: rel, type: "file", size: stat.size, sha256 }));
      } else {
        deny("UNSUPPORTED_FILE_TYPE");
      }
      if (entries.length > maxEntries) deny("ENTRY_COUNT");
    }
  }
  await walk(rootReal);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({ root: rootReal, entries: Object.freeze(entries), totalBytes });
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { source += "(?:.*/)?"; i += 2; }
      else { source += ".*"; i += 1; }
    } else if (char === "*") source += "[^/]*";
    else source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "i");
}
function secretSensitive(path: string): boolean {
  return path.split("/").some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".env" || lower.startsWith(".env.")
      || lower.includes("secret") || lower.includes("credential")
      || lower.endsWith(".pem") || lower.endsWith(".key");
  });
}
function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export function classifyTaskEffectDelta(
  before: TaskEffectManifest,
  after: TaskEffectManifest,
  bound: BoundTaskEffectPolicy,
  policyId: string,
): readonly TaskEffectDelta[] {
  if (!Object.hasOwn(bound.policySet.policies, policyId)) classifyDeny("POLICY_NOT_FOUND");
  const policy = bound.policySet.policies[policyId]!;
  const left = new Map(before.entries.map((entry) => [entry.path, entry] as const));
  const right = new Map(after.entries.map((entry) => [entry.path, entry] as const));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const deltas: TaskEffectDelta[] = [];
  for (const path of paths) {
    const previous = left.get(path);
    const current = right.get(path);
    if (sameEntry(previous, current)) continue;
    const operation = previous === undefined ? "CREATED" : current === undefined ? "REMOVED" : "MODIFIED";
    let classification: TaskEffectClassification;
    if (
      previous?.type === "symlink" || current?.type === "symlink"
      || secretSensitive(path)
      || matchesAny(path, policy.protectedPatterns)
    ) classification = "PROTECTED";
    else if (matchesAny(path, policy.allowedArtifactPatterns)) classification = "ALLOWED_ARTIFACT";
    else classification = "UNCLASSIFIED";
    deltas.push(Object.freeze({ path, operation, classification }));
  }
  return Object.freeze(deltas);
}
