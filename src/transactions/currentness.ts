import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { TransactionCurrentness } from "./types.js";

export type CurrentnessProvider = () => Promise<TransactionCurrentness>;
const execFile = promisify(execFileCallback);
export const TRANSACTION_PROJECT_ROOT = "C:\\Workspace\\haios-desktop-control";

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", [...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.replace(/\r\n/g, "\n").trimEnd();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createGitCurrentnessProvider(root = TRANSACTION_PROJECT_ROOT): CurrentnessProvider {
  return async () => {
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    const branch = (await git(root, ["symbolic-ref", "-q", "HEAD"])).trim();
    const index = await git(root, ["ls-files", "-s"]);
    const listed = await git(root, ["ls-files"]);
    const paths = listed === "" ? [] : listed.split("\n").filter(Boolean).sort();
    const working: string[] = [];
    for (const path of paths) {
      const hash = (await git(root, ["hash-object", "--", path])).trim();
      working.push(`${hash}  ${path}`);
    }
    const trackedStateDigest = digest(`${index}\n--WORKTREE--\n${working.join("\n")}\n`);
    return Object.freeze({ head, branch, trackedStateDigest });
  };
}

export function sameCurrentness(a: TransactionCurrentness, b: TransactionCurrentness): boolean {
  return a.head === b.head && a.branch === b.branch && a.trackedStateDigest === b.trackedStateDigest;
}
