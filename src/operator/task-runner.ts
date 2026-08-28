import { createHash } from "node:crypto";
import { win32 } from "node:path";

import type { BoundTaskRegistryV2 } from "./task-contract-v2.js";
import type { BoundTaskEffectPolicy } from "./task-effects.js";
import {
  captureTaskEffectManifest,
  classifyTaskEffectDelta,
  type TaskEffectDelta,
} from "./task-effect-manifest.js";
import { resolveTaskExecution, type ResolvedTaskExecution } from "./task-resolver.js";
import type { SandboxExecutionRequest, SandboxExecutionResult } from "./sandbox-executor.js";
import { M07_NODE_TOOLCHAIN } from "./sandbox-toolchains.js";

export interface OperatorTaskRunRequest {
  readonly txId: string;
  readonly taskId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly expectedRegistrySha256: string;
}

export interface OperatorTaskResultMetadata {
  readonly decision: "ALLOW" | "DENY";
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly sandboxReason: string | null;
  readonly timedOut: boolean | null;
  readonly taskId: string | null;
  readonly registryId: string;
  readonly registryVersion: string;
  readonly registrySha256: string;
  readonly effectPolicySetId: string;
  readonly effectPolicyVersion: string;
  readonly effectPolicyId: string | null;
  readonly effectPolicySha256: string;
  readonly sandboxProfile: "S0" | "S1" | null;
  readonly toolchainProfile: string | null;
  readonly image: string;
  readonly imageId: string;
  readonly transactionId: string | null;
  readonly worktreePath: string | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly effectSummary: {
    readonly total: number;
    readonly allowedArtifact: number;
    readonly unclassified: number;
    readonly protected: number;
    readonly complete: boolean;
  };
  readonly canonicalPreHead: string | null;
  readonly canonicalPostHead: string | null;
  readonly canonicalPreStateDigest: string | null;
  readonly canonicalPostStateDigest: string | null;
  readonly canonicalStateUnchanged: boolean | null;
  readonly cleanupVerified: boolean;
  readonly cleanupStatus: "VERIFIED" | "UNVERIFIED" | "NOT_STARTED";
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
      readonly metadata: OperatorTaskResultMetadata;
    }
  | {
      readonly decision: "DENY";
      readonly reason: string;
      readonly exitCode?: number;
      readonly effects?: readonly TaskEffectDelta[];
      readonly metadata: OperatorTaskResultMetadata;
    };

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
interface CanonicalCurrentness {
  readonly canonicalHead: string;
  readonly canonicalStatus: string;
  readonly worktreeHead: string;
  readonly sharedRepository: boolean;
  readonly stateDigest: string;
}
interface MetadataContext {
  readonly request?: OperatorTaskRunRequest;
  readonly transaction?: TransactionSnapshot;
  readonly execution?: ResolvedTaskExecution;
  readonly sandbox?: SandboxExecutionResult;
  readonly effects?: readonly TaskEffectDelta[];
  readonly effectsComplete?: boolean;
  readonly pre?: CanonicalCurrentness;
  readonly post?: CanonicalCurrentness;
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
function requestShapeAllowed(request: unknown): request is OperatorTaskRunRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
  const record = request as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  const expected = new Set(["txId", "taskId", "params", "expectedRegistrySha256"]);
  if (keys.length !== expected.size || !keys.every((key) => typeof key === "string" && expected.has(key))) return false;
  if (typeof record.txId !== "string" || record.txId.length === 0) return false;
  if (typeof record.taskId !== "string" || record.taskId.length === 0) return false;
  if (typeof record.expectedRegistrySha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.expectedRegistrySha256)) return false;
  if (typeof record.params !== "object" || record.params === null || Array.isArray(record.params)) return false;
  const prototype = Object.getPrototypeOf(record.params);
  return prototype === Object.prototype || prototype === null;
}
function stateDigest(head: string, status: string): string {
  return createHash("sha256").update(JSON.stringify({ head, status }), "utf8").digest("hex");
}
function summarizeEffects(effects: readonly TaskEffectDelta[], complete: boolean) {
  return Object.freeze({
    total: effects.length,
    allowedArtifact: effects.filter((effect) => effect.classification === "ALLOWED_ARTIFACT").length,
    unclassified: effects.filter((effect) => effect.classification === "UNCLASSIFIED").length,
    protected: effects.filter((effect) => effect.classification === "PROTECTED").length,
    complete,
  });
}

export class OperatorTaskRunner {
  readonly #config: OperatorTaskRunnerConfig;
  constructor(config: OperatorTaskRunnerConfig) {
    this.#config = config;
  }

  async #captureCurrentness(transaction: TransactionSnapshot): Promise<CanonicalCurrentness> {
    const canonicalHead = await this.#config.git.head(transaction.canonicalRoot);
    const canonicalStatus = await this.#config.git.status(transaction.canonicalRoot);
    const worktreeHead = await this.#config.git.head(transaction.worktreePath);
    const canonicalIdentity = commonDirAbsolute(
      transaction.canonicalRoot,
      await this.#config.git.commonDir(transaction.canonicalRoot),
    );
    const worktreeIdentity = commonDirAbsolute(
      transaction.worktreePath,
      await this.#config.git.commonDir(transaction.worktreePath),
    );
    return Object.freeze({
      canonicalHead,
      canonicalStatus,
      worktreeHead,
      sharedRepository: samePath(canonicalIdentity, worktreeIdentity),
      stateDigest: stateDigest(canonicalHead, canonicalStatus),
    });
  }

  #isCurrent(transaction: TransactionSnapshot, currentness: CanonicalCurrentness): boolean {
    return currentness.canonicalHead === transaction.baseHeadSha
      && currentness.canonicalStatus.trim() === ""
      && currentness.worktreeHead === transaction.baseHeadSha
      && currentness.sharedRepository;
  }

  #metadata(
    context: MetadataContext,
    decision: "ALLOW" | "DENY",
    reason: string | null,
    exitCode: number | null,
  ): OperatorTaskResultMetadata {
    const effects = context.effects ?? [];
    const cleanupStatus = context.sandbox === undefined
      ? "NOT_STARTED"
      : context.sandbox.cleanupVerified ? "VERIFIED" : "UNVERIFIED";
    return Object.freeze({
      decision,
      reason,
      exitCode,
      sandboxReason: context.sandbox?.reason ?? null,
      timedOut: context.sandbox?.timedOut ?? null,
      taskId: context.execution?.taskId ?? context.request?.taskId ?? null,
      registryId: this.#config.registry.registry.registryId,
      registryVersion: this.#config.registry.registry.version,
      registrySha256: this.#config.registry.sha256,
      effectPolicySetId: this.#config.effects.policySet.policySetId,
      effectPolicyVersion: this.#config.effects.policySet.version,
      effectPolicyId: context.execution?.effectPolicyRef ?? null,
      effectPolicySha256: this.#config.effects.sha256,
      sandboxProfile: context.execution?.sandboxProfile ?? null,
      toolchainProfile: context.execution?.toolchainProfile ?? null,
      image: M07_NODE_TOOLCHAIN.image,
      imageId: M07_NODE_TOOLCHAIN.imageId,
      transactionId: context.transaction?.txId ?? context.request?.txId ?? null,
      worktreePath: context.transaction?.worktreePath ?? null,
      durationMs: context.sandbox?.durationMs ?? 0,
      stdoutBytes: context.sandbox?.stdoutBytes ?? 0,
      stderrBytes: context.sandbox?.stderrBytes ?? 0,
      stdoutTruncated: context.sandbox?.stdoutTruncated ?? false,
      stderrTruncated: context.sandbox?.stderrTruncated ?? false,
      effectSummary: summarizeEffects(effects, context.effectsComplete ?? false),
      canonicalPreHead: context.pre?.canonicalHead ?? null,
      canonicalPostHead: context.post?.canonicalHead ?? null,
      canonicalPreStateDigest: context.pre?.stateDigest ?? null,
      canonicalPostStateDigest: context.post?.stateDigest ?? null,
      canonicalStateUnchanged: context.pre !== undefined && context.post !== undefined
        ? context.pre.canonicalHead === context.post.canonicalHead
          && context.pre.stateDigest === context.post.stateDigest
        : null,
      cleanupVerified: context.sandbox?.cleanupVerified ?? false,
      cleanupStatus,
    });
  }

  #deny(
    reason: string,
    context: MetadataContext = {},
    exitCode?: number,
  ): OperatorTaskRunResult {
    return {
      decision: "DENY",
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(context.effects === undefined ? {} : { effects: context.effects }),
      metadata: this.#metadata(context, "DENY", reason, exitCode ?? context.sandbox?.exitCode ?? null),
    };
  }

  async run(request: OperatorTaskRunRequest): Promise<OperatorTaskRunResult> {
    if (!requestShapeAllowed(request)) return this.#deny("TASK_REQUEST_FIELDS_DENIED");

    const status = await this.#config.transactions.status(request.txId);
    if (status.decision !== "ALLOW") return this.#deny("TASK_TRANSACTION_NOT_FOUND", { request });
    const transaction = status.transaction;
    const baseContext: MetadataContext = { request, transaction };
    if (status.state !== "APPLIED" || transaction.state !== "APPLIED") {
      return this.#deny("TASK_TRANSACTION_STATE_DENIED", baseContext);
    }
    if (request.expectedRegistrySha256 !== this.#config.registry.sha256) {
      return this.#deny("TASK_REGISTRY_CURRENTNESS_MISMATCH", baseContext);
    }
    if (this.#config.effects.sha256 !== this.#config.qualifiedEffectPolicySha256) {
      return this.#deny("TASK_EFFECT_POLICY_CURRENTNESS_MISMATCH", baseContext);
    }

    let pre: CanonicalCurrentness;
    try { pre = await this.#captureCurrentness(transaction); }
    catch { return this.#deny("TASK_CANONICAL_CURRENTNESS_UNAVAILABLE", baseContext); }
    if (!this.#isCurrent(transaction, pre)) {
      return this.#deny("TASK_CANONICAL_CURRENTNESS_DENIED", { ...baseContext, pre });
    }

    let execution: ResolvedTaskExecution;
    try {
      execution = await resolveTaskExecution(
        this.#config.registry,
        request.taskId,
        request.params,
        request.expectedRegistrySha256,
        transaction.worktreePath,
      );
    } catch {
      return this.#deny("TASK_RESOLUTION_FAILED", { ...baseContext, pre });
    }
    const executionContext: MetadataContext = { ...baseContext, execution, pre };

    let before;
    try { before = await captureTaskEffectManifest(transaction.worktreePath); }
    catch { return this.#deny("TASK_EFFECT_MANIFEST_FAILED", executionContext); }

    let sandbox: SandboxExecutionResult;
    try {
      sandbox = await this.#config.sandbox.execute({
        transactionId: transaction.txId,
        execution,
        worktreePath: transaction.worktreePath,
        safeEnvironment: this.#config.safeEnvironment,
        ...(execution.sandboxProfile === "S1" && this.#config.fixtureProfileId
          ? { fixtureProfileId: this.#config.fixtureProfileId }
          : {}),
      });
    } catch {
      return this.#deny("TASK_SANDBOX_EXECUTION_UNAVAILABLE", executionContext);
    }
    const sandboxContext: MetadataContext = { ...executionContext, sandbox };

    let after;
    try { after = await captureTaskEffectManifest(transaction.worktreePath); }
    catch {
      let post: CanonicalCurrentness | undefined;
      try { post = await this.#captureCurrentness(transaction); } catch { /* remain fail-closed */ }
      return this.#deny("TASK_EFFECT_MANIFEST_FAILED", { ...sandboxContext, ...(post ? { post } : {}) });
    }

    let post: CanonicalCurrentness;
    try { post = await this.#captureCurrentness(transaction); }
    catch { return this.#deny("TASK_CANONICAL_CURRENTNESS_UNAVAILABLE", sandboxContext); }
    const postContext: MetadataContext = { ...sandboxContext, post };
    if (!this.#isCurrent(transaction, post)) {
      return this.#deny("TASK_CANONICAL_MUTATION_DETECTED", postContext);
    }

    const postStatus = await this.#config.transactions.status(request.txId);
    if (postStatus.decision !== "ALLOW" || postStatus.state !== "APPLIED") {
      return this.#deny("TASK_TRANSACTION_STATE_DRIFT", postContext);
    }

    let effects: readonly TaskEffectDelta[];
    try {
      effects = classifyTaskEffectDelta(before, after, this.#config.effects, execution.effectPolicyRef);
    } catch {
      return this.#deny("TASK_EFFECT_CLASSIFICATION_FAILED", postContext);
    }
    const completeContext: MetadataContext = { ...postContext, effects, effectsComplete: true };

    if (effects.some((effect) => effect.classification === "PROTECTED")) {
      return this.#deny("TASK_PROTECTED_EFFECT", completeContext);
    }
    if (effects.some((effect) => effect.classification === "UNCLASSIFIED")) {
      return this.#deny("TASK_EFFECT_POLICY_VIOLATION", completeContext);
    }
    if (!sandbox.cleanupVerified) {
      return this.#deny("TASK_SANDBOX_CLEANUP_UNVERIFIED", completeContext, sandbox.exitCode);
    }
    if (sandbox.decision !== "ALLOW" || sandbox.exitCode !== 0) {
      return this.#deny("TASK_SANDBOX_FAILED", completeContext, sandbox.exitCode);
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
      metadata: this.#metadata(completeContext, "ALLOW", null, 0),
    };
  }
}
