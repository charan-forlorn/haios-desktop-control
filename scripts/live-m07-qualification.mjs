import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalOperatorGit } from "../dist/src/operator/local-git.js";
import { OperatorTransactionService } from "../dist/src/operator/transaction-isolation.js";
import { loadTaskRegistryV2, validateTaskRegistryV2 } from "../dist/src/operator/task-contract-v2.js";
import { loadTaskEffectPolicy } from "../dist/src/operator/task-effects.js";
import { SandboxExecutor } from "../dist/src/operator/sandbox-executor.js";
import { OperatorTaskRunner } from "../dist/src/operator/task-runner.js";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.argv[2];
const resultPath = process.argv[3];
if (!runtimeRoot || !resultPath) throw new Error("M07_LIVE_ARGS_REQUIRED");
const canonical = join(runtimeRoot, "canonical");
const worktreeRoot = join(runtimeRoot, "worktrees");
await mkdir(canonical, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
const gitRaw = async (...args) => (await run("git", args, { cwd: canonical, windowsHide: true, encoding: "utf8" })).stdout.trim();
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const s0Probe = await readFile(join(repoRoot, "tests/fixtures/m07/s0-probe.mjs"), "utf8");
const s1Client = await readFile(join(repoRoot, "tests/fixtures/m07/s1-client.mjs"), "utf8");
const packageJson = JSON.stringify({
  name: "m07-synthetic",
  private: true,
  type: "module",
  scripts: {
    test: "node --test tests/sample.test.mjs",
    build: "node scripts/build.mjs",
    typecheck: "node scripts/typecheck.mjs",
  },
}, null, 2) + "\n";
const baselineBuild = [
  'import { mkdir, writeFile } from "node:fs/promises";',
  'await mkdir("dist", { recursive: true });',
  'await writeFile("dist/qualified.txt", "BASELINE", "utf8");',
].join("\n") + "\n";
const modifiedBuild = baselineBuild.replace("BASELINE", "M07_MODIFIED_BUILD_EXECUTED");
await mkdir(join(canonical, "tests"), { recursive: true });
await mkdir(join(canonical, "scripts"), { recursive: true });
await writeFile(join(canonical, "package.json"), packageJson, "utf8");
await writeFile(join(canonical, "tests/sample.test.mjs"), s0Probe, "utf8");
await writeFile(join(canonical, "scripts/build.mjs"), baselineBuild, "utf8");
await writeFile(join(canonical, "scripts/typecheck.mjs"), 'console.log("M07_SYNTHETIC_TYPECHECK_PASS");\n', "utf8");
await writeFile(join(canonical, "scripts/s1-client.mjs"), s1Client, "utf8");
const syntheticSecret = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
await writeFile(join(canonical, "scripts/secret-output.mjs"), `console.log("OPENAI_API_KEY=${syntheticSecret}");\n`, "utf8");
await gitRaw("init", "-b", "main");
await gitRaw("add", "-A");
await gitRaw("-c", "user.email=haios-qual@local", "-c", "user.name=HAIOS Qualifier", "commit", "-m", "baseline");
const git = new LocalOperatorGit();
const service = new OperatorTransactionService({ worktreeRoot, allowedProjects: { demo: canonical }, git });
const baselineHead = await git.head(canonical);
const begin = await service.begin("demo", canonical);
if (begin.decision !== "ALLOW") throw new Error(`BEGIN:${JSON.stringify(begin)}`);
const txId = begin.transaction.txId;
const worktreePath = begin.transaction.worktreePath;
const worktreeBuildBytes = await readFile(join(worktreePath, "scripts/build.mjs"));
const staged = await service.stagePatch(txId, "scripts/build.mjs", sha256(worktreeBuildBytes), b64(modifiedBuild));
if (staged.decision !== "ALLOW") throw new Error(`STAGE:${JSON.stringify(staged)}`);
const validated = await service.validate(txId);
if (validated.decision !== "ALLOW") throw new Error(`VALIDATE:${JSON.stringify(validated)}`);
const applied = await service.apply(txId);
if (applied.decision !== "ALLOW" || applied.state !== "APPLIED") throw new Error(`APPLY:${JSON.stringify(applied)}`);
if ((await git.head(canonical)) !== baselineHead || (await git.status(canonical)) !== "") {
  throw new Error("CANONICAL_CHANGED_DURING_APPLY");
}
if ((await readFile(join(canonical, "scripts/build.mjs"), "utf8")) !== baselineBuild) {
  throw new Error("CANONICAL_BYTES_CHANGED_DURING_APPLY");
}
const registry = await loadTaskRegistryV2(join(repoRoot, "task-registry.m07.json"));
const effects = await loadTaskEffectPolicy(join(repoRoot, "task-effects.m07.json"));
const sandbox = new SandboxExecutor();
const runner = new OperatorTaskRunner({
  transactions: service, git, registry, effects,
  qualifiedEffectPolicySha256: effects.sha256,
  sandbox, safeEnvironment: { CI: "1" },
});
const runTask = async (taskId, params = {}) => {
  const result = await runner.run({ txId, taskId, params, expectedRegistrySha256: registry.sha256 });
  if (result.decision !== "ALLOW") throw new Error(`${taskId}:${JSON.stringify(result)}`);
  return result;
};
const nodeTest = await runTask("node.test.run", { testPath: "tests/sample.test.mjs" });
const projectTest = await runTask("project.test");
const typecheck = await runTask("project.typecheck");
const build = await runTask("project.build");
if (!typecheck.stdout.includes("M07_SYNTHETIC_TYPECHECK_PASS")) throw new Error("TYPECHECK_MARKER_MISSING");
const buildArtifact = build.effects.find((effect) => effect.path === "dist/qualified.txt");
if (!buildArtifact || buildArtifact.classification !== "ALLOWED_ARTIFACT") {
  throw new Error(`BUILD_EFFECT:${JSON.stringify(build.effects)}`);
}
if ((await readFile(join(worktreePath, "dist/qualified.txt"), "utf8")) !== "M07_MODIFIED_BUILD_EXECUTED") {
  throw new Error("MODIFIED_BUILD_NOT_EXECUTED");
}
try {
  await readFile(join(canonical, "dist/qualified.txt"), "utf8");
  throw new Error("CANONICAL_ARTIFACT_CREATED");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const s1Raw = {
  registryId: "m07-synthetic-s1",
  version: "2.0.0",
  tasks: {
    "fixture.probe": {
      argvTemplate: ["node", "scripts/s1-client.mjs"], paramSchemas: {}, requiredParams: [],
      toolchainProfile: "node22-sandbox-v1", sandboxProfile: "S1", networkAuthority: "FIXTURE_ONLY",
      childProcessPolicy: "SANDBOX_OWNED_TREE", envAllowlist: ["CI"], effectPolicyRef: "default-artifacts-v1",
      timeoutMs: 30000, stdoutMaxBytes: 65536, stderrMaxBytes: 65536,
    },
  },
};
const s1Bytes = Buffer.from(JSON.stringify(s1Raw), "utf8");
const s1Registry = Object.freeze({
  registry: validateTaskRegistryV2(s1Raw),
  sha256: createHash("sha256").update(s1Bytes).digest("hex"),
  sourcePath: "synthetic:m07-s1",
});
const s1Runner = new OperatorTaskRunner({
  transactions: service, git, registry: s1Registry, effects,
  qualifiedEffectPolicySha256: effects.sha256,
  sandbox, safeEnvironment: { CI: "1" },
  fixtureProfileId: "m07-http-fixture-v1",
});
const s1 = await s1Runner.run({
  txId,
  taskId: "fixture.probe",
  params: {},
  expectedRegistrySha256: s1Registry.sha256,
});
if (s1.decision !== "ALLOW" || !s1.stdout.includes("M07_S1_FIXTURE_ONLY_PASS")) {
  throw new Error(`S1:${JSON.stringify(s1)}`);
}
const secretRaw = {
  registryId: "m07-synthetic-secret", version: "2.0.0", tasks: {
    "secret.probe": {
      argvTemplate: ["node", "scripts/secret-output.mjs"], paramSchemas: {}, requiredParams: [],
      toolchainProfile: "node22-sandbox-v1", sandboxProfile: "S0", networkAuthority: "NONE",
      childProcessPolicy: "SANDBOX_OWNED_TREE", envAllowlist: ["CI"], effectPolicyRef: "default-artifacts-v1",
      timeoutMs: 30000, stdoutMaxBytes: 65536, stderrMaxBytes: 65536,
    },
  },
};
const secretBytes = Buffer.from(JSON.stringify(secretRaw), "utf8");
const secretRegistry = Object.freeze({ registry: validateTaskRegistryV2(secretRaw),
  sha256: createHash("sha256").update(secretBytes).digest("hex"), sourcePath: "synthetic:m07-secret" });
const secretRunner = new OperatorTaskRunner({ transactions: service, git, registry: secretRegistry, effects,
  qualifiedEffectPolicySha256: effects.sha256, sandbox, safeEnvironment: { CI: "1" } });
const secretProbe = await secretRunner.run({ txId, taskId: "secret.probe", params: {}, expectedRegistrySha256: secretRegistry.sha256 });
if (secretProbe.decision !== "DENY" || secretProbe.reason !== "TASK_SANDBOX_FAILED" || JSON.stringify(secretProbe).includes(syntheticSecret)) {
  throw new Error(`SECRET_OUTPUT:${JSON.stringify(secretProbe)}`);
}
if ((await git.head(canonical)) !== baselineHead || (await git.status(canonical)) !== "") {
  throw new Error("CANONICAL_CHANGED_AFTER_TASKS");
}
const rollback = await service.rollback(txId);
if (rollback.decision !== "ALLOW" || rollback.state !== "ROLLED_BACK") {
  throw new Error(`ROLLBACK:${JSON.stringify(rollback)}`);
}
const result = {
  baselineHead,
  productionTasks: [nodeTest.taskId, projectTest.taskId, typecheck.taskId, build.taskId],
  s0NetworkDenied: true,
  modifiedCodeExecuted: true,
  effectClassification: buildArtifact.classification,
  s1FixtureOnly: true,
  s1NamespaceIsolated: true,
  secretOutputDenied: true,
  canonicalUnchanged: true,
  rollbackClean: true,
};
await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result));