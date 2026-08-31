import { describe, expect, it } from "vitest";

import {
  LocalOperatorGit,
  readLocalGitCurrentBranch,
  type OperatorGitExecutor,
  type OperatorGitExecResult,
} from "../src/operator/local-git.js";

type Call = { readonly cwd: string; readonly args: readonly string[] };

function fixture(results: OperatorGitExecResult[] = []) {
  const calls: Call[] = [];
  let index = 0;
  const executor: OperatorGitExecutor = async (args, cwd) => {
    calls.push({ cwd, args: [...args] });
    return results[index++] ?? { stdout: "", stderr: "", exitCode: 0 };
  };
  return { git: new LocalOperatorGit(executor), executor, calls };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("M06 typed local-only Git boundary", () => {
  it("uses only fixed typed local Git argv for worktree/checkpoint/promotion", async () => {
    const fx = fixture([
      { stdout: `${SHA_A}\n`, stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: ".git\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "commit ok", stderr: "", exitCode: 0 },
      { stdout: `${SHA_B}\n`, stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "ff", stderr: "", exitCode: 0 },
      { stdout: `${SHA_B}\n`, stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);
    expect(await fx.git.head("C:\\repo")).toBe(SHA_A);
    expect(await fx.git.status("C:\\repo")).toBe("");
    expect(await fx.git.commonDir("C:\\repo")).toBe(".git");
    await fx.git.worktreeAdd("C:\\repo", "C:\\worktrees\\tx1", "haios-tx-tx1", SHA_A);
    await fx.git.addAll("C:\\worktrees\\tx1");
    expect(await fx.git.commit("C:\\worktrees\\tx1", "HAIOS checkpoint")).toBe(SHA_B);
    expect(await fx.git.isAncestor("C:\\repo", SHA_A, SHA_B)).toBe(true);
    expect(await fx.git.mergeFastForward("C:\\repo", SHA_B)).toBe(SHA_B);
    await fx.git.worktreeRemove("C:\\repo", "C:\\worktrees\\tx1");
    await fx.git.deleteBranch("C:\\repo", "haios-tx-tx1");

    expect(fx.calls.map((call) => call.args)).toEqual([
      ["--no-optional-locks", "rev-parse", "HEAD"],
      ["--no-optional-locks", "status", "--porcelain"],
      ["--no-optional-locks", "rev-parse", "--git-common-dir"],
      ["--no-optional-locks", "worktree", "add", "-b", "haios-tx-tx1", "C:\\worktrees\\tx1", SHA_A],
      ["--no-optional-locks", "add", "-A"],
      ["--no-optional-locks", "-c", "user.email=haios-operator@local", "-c", "user.name=HAIOS Operator", "commit", "-m", "HAIOS checkpoint"],
      ["--no-optional-locks", "rev-parse", "HEAD"],
      ["--no-optional-locks", "merge-base", "--is-ancestor", SHA_A, SHA_B],
      ["--no-optional-locks", "merge", "--ff-only", SHA_B],
      ["--no-optional-locks", "rev-parse", "HEAD"],
      ["--no-optional-locks", "worktree", "remove", "--force", "C:\\worktrees\\tx1"],
      ["--no-optional-locks", "branch", "-D", "haios-tx-tx1"],
    ]);
  });
  it("treats ancestor exit code 1 as false and rejects other Git failures", async () => {
    const no = fixture([{ stdout: "", stderr: "", exitCode: 1 }]);
    await expect(no.git.isAncestor("C:\\repo", SHA_A, SHA_B)).resolves.toBe(false);

    const error = fixture([{ stdout: "", stderr: "fatal", exitCode: 2 }]);
    await expect(error.git.isAncestor("C:\\repo", SHA_A, SHA_B)).rejects.toThrow(/GIT_COMMAND_FAILED/);
  });

  it("reads the current worktree branch through a fixed local Git command outside the certified adapter prototype", async () => {
    const fx = fixture([{ stdout: "haios-tx-owned\n", stderr: "", exitCode: 0 }]);
    await expect(readLocalGitCurrentBranch("C:\\worktrees\\tx1", fx.executor)).resolves.toBe("haios-tx-owned");
    expect(fx.calls.map((call) => call.args)).toEqual([
      ["--no-optional-locks", "branch", "--show-current"],
    ]);
  });

  it("fails the separate branch reader when its fixed command is nonzero", async () => {
    const fx = fixture([{ stdout: "", stderr: "fatal", exitCode: 2 }]);
    await expect(readLocalGitCurrentBranch("C:\\worktrees\\tx1", fx.executor)).rejects.toThrow(/GIT_COMMAND_FAILED:branch:2/);
  });

  it("validates SHA, branch and commit message before invoking Git", async () => {
    const fx = fixture();
    await expect(fx.git.mergeFastForward("C:\\repo", "bad")).rejects.toThrow(/INVALID_GIT_SHA/);
    await expect(fx.git.worktreeAdd("C:\\repo", "C:\\w", "", SHA_A)).rejects.toThrow(/INVALID_GIT_BRANCH/);
    await expect(fx.git.commit("C:\\repo", "   ")).rejects.toThrow(/INVALID_COMMIT_MESSAGE/);
    expect(fx.calls).toHaveLength(0);
  });

  it("does not expose generic or network Git entrypoints", () => {
    const names = Object.getOwnPropertyNames(LocalOperatorGit.prototype);
    for (const forbidden of ["run", "exec", "push", "pull", "fetch", "clone", "remote", "reset", "rebase"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names.sort()).toEqual([
      "addAll", "commit", "commonDir", "constructor", "deleteBranch", "head",
      "isAncestor", "mergeFastForward", "status", "worktreeAdd", "worktreeRemove",
    ].sort());
  });
});
