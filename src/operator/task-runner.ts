import { win32 } from "node:path";

import type { BoundTaskRegistryV2 } from "./task-contract-v2.js";
import type { BoundTaskEffectPolicy } from "./task-effects.js";
import {
  captureTaskEffectManifest,
  classifyTaskEffectDelta,
  type TaskEffectDelta,
} from "./task-effect-manifest.js";
import { resolveTaskExecution } from "./task-resolver.js";
import type { SandboxExecutionRequest, SandboxExecutionResult } from "./sandbox-executor.js";

export interface OperatorTaskRunRequest {
  readonly txId: string;
  readonly taskId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly expectedRegistrySha256: string;
}
export type OperatorTaskRunResult =
  | {
      readonly decision: "ALLOW";
      readonly taskId: string;
      readonly registrySha256: string;
      readonly effectPolicySha256: string;
      readonly exitCode: 0;
      readonly stdout: string;
      readonly stderr: string;
      readonly effects: readonly TaskEffectDelta[];
      readonly cleanupVerified: true;
    }
  | { readonly decision: "DENY"; readonly reason: string; readonly exitCode?: number; readonly effects?: readonly TaskEffectDelta[] };

interface TransactionSnapshot {
  readonly txId: string;
  readonly canonicalRoot: string;
  readonly worktreePath: string;
  readonly baseHeadSha: string;
  readonly state: string;
}
interface TransactionStatusProvider {
  status(txId: string): Promise<
    | { readonly decision: "ALLOW"; readonly transaction: TransactionSnapshot; readonly state: string }
    | { readonly decision: "DENY"; readonly reason: string }
  >;
}
interface RunnerGit {
  head(cwd: string): Promise<string>;
  status(cwd: string): Promise<string>;
  commonDir(cwd: string): Promise<string>;
}
interface RunnerSandbox {
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}
export interface OperatorTaskRunnerConfig {
  readonly transactions: TransactionStatusProvider;
  readonly git: RunnerGit;
  readonly registry: BoundTaskRegistryV2;
  readonly effects: BoundTaskEffectPolicy;
  readonly qualifiedEffectPolicySha256: string;
  readonly sandbox: RunnerSandbox;
  readonly safeEnvironment: Readonly<Record<string, string>>;
  readonly fixtureProfileId?: string;
}

function samePath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}
function commonDirAbsolute(cwd: string, raw: string): string {
  return win32.normalize(win32.isAbsolute(raw) ? raw : win32.resolve(cwd, raw));
}
export class OperatorTaskRunner {
  readonly #config: OperatorTaskRunnerConfig;
  constructor(config: OperatorTaskRunnerConfig) {
    this.#config = config;
  }

  async #currentness(transaction: TransactionSnapshot): Promise<boolean> {
    if ((await this.#config.git.head(transaction.canonicalRoot)) !== transaction.baseHeadSha) return false;
    if ((await this.#config.git.status(transaction.canonicalRoot)).trim() !== "") return false;
    if ((await this.#config.git.head(transaction.worktreePath)) !== transaction.baseHeadSha) return false;
    const canonicalIdentity = commonDirAbsolute(
      transaction.canonicalRoot,
      await this.#config.git.commonDir(transaction.canonicalRoot),
    );
    const worktreeIdentity = commonDirAbsolute(
      transaction.worktreePath,
      await this.#config.git.commonDir(transaction.worktreePath),
    );
    return samePath(canonicalIdentity, worktreeIdentity);
  }

  async run(request: OperatorTaskRunRequest): Promise<OperatorTaskRunResult> {
    const status = await this.#config.transactions.status(request.txId);
    if (status.decision !== "ALLOW") return { decision: "DENY", reason: "TASK_TRANSACTION_NOT_FOUND" };
    const transaction = status.transaction;
    if (status.state !== "APPLIED" || transaction.state !== "APPLIED") {
      return { decision: "DENY", reason: "TASK_TRANSACTION_STATE_DENIED" };
    }
    if (request.expectedRegistrySha256 !== this.#config.registry.sha256) {
      return { decision: "DENY", reason: "TASK_REGISTRY_CURRENTNESS_MISMATCH" };
    }
    if (this.#config.effects.sha256 !== this.#config.qualifiedEffectPolicySha256) {
      return { decision: "DENY", reason: "TASK_EFFECT_POLICY_CURRENTNESS_MISMATCH" };
    }
    if (!(await this.#currentness(transaction))) {
      return { decision: "DENY", reason: "TASK_CANONICAL_CURRENTNESS_DENIED" };
    }
    let execution;
    try {
      execution = await resolveTaskExecution(
        this.#config.registry,
        request.taskId,
        request.params,
        request.expectedRegistrySha256,
        transaction.worktreePath,
      );
    } catch {
      return { decision: "DENY", reason: "TASK_RESOLUTION_FAILED" };
    }

    let before;
    try { before = await captureTaskEffectManifest(transaction.worktreePath); }
    catch { return { decision: "DENY", reason: "TASK_EFFECT_MANIFEST_FAILED" }; }

    const sandbox = await this.#config.sandbox.execute({
      transactionId: transaction.txId,
      execution,
      worktreePath: transaction.worktreePath,
      safeEnvironment: this.#config.safeEnvironment,
      ...(execution.sandboxProfile === "S1" && this.#config.fixtureProfileId
        ? { fixtureProfileId: this.#config.fixtureProfileId }
        : {}),
    });

    let after;
    try { after = await captureTaskEffectManifest(transaction.worktreePath); }
    catch { return { decision: "DENY", reason: "TASK_EFFECT_MANIFEST_FAILED" }; }

    if (!(await this.#currentness(transaction))) {
      return { decision: "DENY", reason: "TASK_CANONICAL_MUTATION_DETECTED" };
    }
    const postStatus = await this.#config.transactions.status(request.txId);
    if (postStatus.decision !== "ALLOW" || postStatus.state !== "APPLIED") {
      return { decision: "DENY", reason: "TASK_TRANSACTION_STATE_DRIFT" };
    }
    let effects: readonly TaskEffectDelta[];
    try {
      effects = classifyTaskEffectDelta(before, after, this.#config.effects, execution.effectPolicyRef);
    } catch {
      return { decision: "DENY", reason: "TASK_EFFECT_CLASSIFICATION_FAILED" };
    }
    if (effects.some((effect) => effect.classification === "PROTECTED")) {
      return { decision: "DENY", reason: "TASK_PROTECTED_EFFECT", effects };
    }
    if (effects.some((effect) => effect.classification === "UNCLASSIFIED")) {
      return { decision: "DENY", reason: "TASK_EFFECT_POLICY_VIOLATION", effects };
    }
    if (!sandbox.cleanupVerified) {
      return { decision: "DENY", reason: "TASK_SANDBOX_CLEANUP_UNVERIFIED", effects };
    }
    if (sandbox.decision !== "ALLOW" || sandbox.exitCode !== 0) {
      return {
        decision: "DENY",
        reason: "TASK_SANDBOX_FAILED",
        ...(sandbox.exitCode === undefined ? {} : { exitCode: sandbox.exitCode }),
        effects,
      };
    }
    return {
      decision: "ALLOW",
      taskId: request.taskId,
      registrySha256: this.#config.registry.sha256,
      effectPolicySha256: this.#config.effects.sha256,
      exitCode: 0,
      stdout: sandbox.stdout,
      stderr: sandbox.stderr,
      effects,
      cleanupVerified: true,
    };
  }
}
