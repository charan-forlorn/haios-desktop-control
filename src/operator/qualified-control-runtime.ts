import { LocalOperatorGit } from "./local-git.js";
import { SandboxExecutor } from "./sandbox-executor.js";
import { loadTaskRegistryV2 } from "./task-contract-v2.js";
import { loadTaskEffectPolicy } from "./task-effects.js";
import { OperatorTaskRunner } from "./task-runner.js";
import { OperatorTransactionService, type OperatorTransactionRecoveryCoordinator } from "./transaction-isolation.js";
import {
  createOperatorControlRuntime,
  type OperatorControlRuntime,
  type OperatorControlTaskApi,
  type OperatorControlTransactionApi,
} from "./control-runtime.js";

export const M08_QUALIFIED_RUNTIME_IDENTITY = Object.freeze({
  profile: "M08_M06_M07_QUALIFIED_RUNTIME_V1" as const,
  parentM07Head: "9a14ad42e31dbf43306d90b1f9ec98ce3c1c38e0",
  parentM07CertificationSha256: "a6b58a86a4d60b5ee71dbab4672ad89c16ab5b3f30392d04eec8c03253e12533",
  registrySha256: "e94aaa6e60534316736a958c80bd33db691b2494b1518391a15d9f90f1e7e72c",
  effectPolicySha256: "00dfb27757d629e09bf2f91c4247004ecd1162bdd7e14faee88c1a777b2e5335",
});

export interface QualifiedOperatorControlRuntimeConfig {
  readonly worktreeRoot: string;
  readonly allowedProjects: Readonly<Record<string, string>>;
  readonly registryPath: string;
  readonly effectPolicyPath: string;
  readonly recovery?: OperatorTransactionRecoveryCoordinator;
}
export interface QualifiedOperatorControlRuntime extends OperatorControlRuntime {
  readonly attestation: typeof M08_QUALIFIED_RUNTIME_IDENTITY;
}

const QUALIFIED_RUNTIMES = new WeakSet<object>();

function freezeBound<T extends (...args: any[]) => any>(owner: object, fn: T): T {
  return Object.freeze(fn.bind(owner)) as T;
}

function transactionFacade(service: OperatorTransactionService): OperatorControlTransactionApi {
  return Object.freeze({
    begin: freezeBound(service, service.begin),
    stagePatch: freezeBound(service, service.stagePatch),
    stageCreate: freezeBound(service, service.stageCreate),
    stageMove: freezeBound(service, service.stageMove),
    stageRemove: freezeBound(service, service.stageRemove),
    validate: freezeBound(service, service.validate),
    apply: freezeBound(service, service.apply),
    rollback: freezeBound(service, service.rollback),
    checkpoint: freezeBound(service, service.checkpoint),
    promote: freezeBound(service, service.promote),
    status: freezeBound(service, service.status),
  });
}

function taskFacade(runner: OperatorTaskRunner): OperatorControlTaskApi {
  return Object.freeze({ run: freezeBound(runner, runner.run) });
}
export async function createQualifiedOperatorControlRuntime(
  config: QualifiedOperatorControlRuntimeConfig,
): Promise<QualifiedOperatorControlRuntime> {
  const registry = await loadTaskRegistryV2(config.registryPath);
  if (registry.sha256 !== M08_QUALIFIED_RUNTIME_IDENTITY.registrySha256) {
    throw new Error("M08_QUALIFIED_REGISTRY_IDENTITY_MISMATCH");
  }
  const effects = await loadTaskEffectPolicy(config.effectPolicyPath);
  if (effects.sha256 !== M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256) {
    throw new Error("M08_QUALIFIED_EFFECT_POLICY_IDENTITY_MISMATCH");
  }

  const git = new LocalOperatorGit();
  const transactions = new OperatorTransactionService({
    worktreeRoot: config.worktreeRoot,
    allowedProjects: Object.freeze({ ...config.allowedProjects }),
    git,
    ...(config.recovery === undefined ? {} : { recovery: config.recovery }),
  });
  const sandbox = new SandboxExecutor();
  const tasks = new OperatorTaskRunner({
    transactions,
    git,
    registry,
    effects,
    qualifiedEffectPolicySha256: M08_QUALIFIED_RUNTIME_IDENTITY.effectPolicySha256,
    sandbox,
    safeEnvironment: Object.freeze({ CI: "1" }),
  });
  const base = createOperatorControlRuntime({
    transactions: transactionFacade(transactions),
    tasks: taskFacade(tasks),
    registry,
    effects,
  });
  const runtime: QualifiedOperatorControlRuntime = Object.freeze({
    ...base,
    attestation: M08_QUALIFIED_RUNTIME_IDENTITY,
  });
  QUALIFIED_RUNTIMES.add(runtime);
  return runtime;
}

export function isQualifiedOperatorControlRuntime(
  value: unknown,
): value is QualifiedOperatorControlRuntime {
  return typeof value === "object"
    && value !== null
    && QUALIFIED_RUNTIMES.has(value as object);
}
