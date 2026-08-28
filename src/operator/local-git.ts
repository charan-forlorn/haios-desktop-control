import { execFile } from "node:child_process";

export interface OperatorGitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type OperatorGitExecutor = (
  args: readonly string[],
  cwd: string,
) => Promise<OperatorGitExecResult>;

const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function validSha(value: string): void {
  if (!FULL_GIT_SHA.test(value)) throw new Error("INVALID_GIT_SHA");
}

function validBranch(value: string): void {
  if (
    value.length === 0 || value.length > 200 || value.startsWith("-") ||
    value.includes("..") || value.includes("@{") || value.includes("//") ||
    value.includes("\\") || /\s/.test(value) || value.endsWith(".") || value.endsWith(".lock")
  ) throw new Error("INVALID_GIT_BRANCH");
}

const defaultExecutor: OperatorGitExecutor = (args, cwd) => new Promise((resolve) => {
  execFile("git", [...args], { cwd, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
    resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code });
  });
});
export class LocalOperatorGit {
  readonly #executor: OperatorGitExecutor;

  constructor(executor: OperatorGitExecutor = defaultExecutor) {
    this.#executor = executor;
  }

  async #execute(cwd: string, args: readonly string[]): Promise<OperatorGitExecResult> {
    return this.#executor(["--no-optional-locks", ...args], cwd);
  }

  async #expectZero(cwd: string, args: readonly string[]): Promise<OperatorGitExecResult> {
    const result = await this.#execute(cwd, args);
    if (result.exitCode !== 0) {
      throw new Error(`GIT_COMMAND_FAILED:${args[0] ?? "UNKNOWN"}:${result.exitCode}`);
    }
    return result;
  }

  async head(cwd: string): Promise<string> {
    return (await this.#expectZero(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async status(cwd: string): Promise<string> {
    return (await this.#expectZero(cwd, ["status", "--porcelain"])).stdout.replace(/\r\n/g, "\n").trimEnd();
  }

  async commonDir(cwd: string): Promise<string> {
    return (await this.#expectZero(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
  }
  async worktreeAdd(repo: string, path: string, branch: string, startPoint: string): Promise<void> {
    validBranch(branch);
    validSha(startPoint);
    await this.#expectZero(repo, ["worktree", "add", "-b", branch, path, startPoint]);
  }

  async worktreeRemove(repo: string, path: string): Promise<void> {
    await this.#expectZero(repo, ["worktree", "remove", "--force", path]);
  }

  async addAll(cwd: string): Promise<void> {
    await this.#expectZero(cwd, ["add", "-A"]);
  }

  async commit(cwd: string, message: string): Promise<string> {
    if (message.trim().length === 0 || message.length > 200) throw new Error("INVALID_COMMIT_MESSAGE");
    await this.#expectZero(cwd, [
      "-c", "user.email=haios-operator@local",
      "-c", "user.name=HAIOS Operator",
      "commit", "-m", message,
    ]);
    const checkpoint = await this.head(cwd);
    validSha(checkpoint);
    return checkpoint;
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    validSha(ancestor);
    validSha(descendant);
    const result = await this.#execute(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`GIT_COMMAND_FAILED:merge-base:${result.exitCode}`);
  }
  async mergeFastForward(cwd: string, checkpoint: string): Promise<string> {
    validSha(checkpoint);
    await this.#expectZero(cwd, ["merge", "--ff-only", checkpoint]);
    return this.head(cwd);
  }

  async deleteBranch(cwd: string, branch: string): Promise<void> {
    validBranch(branch);
    await this.#expectZero(cwd, ["branch", "-D", branch]);
  }
}
