import { spawn } from "node:child_process";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STRICT_RUNTIME_LAUNCHER = resolve(HERE, "run-m10-readonly-runtime.mjs");
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_BACKOFF_MS = 1000;

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export function spawnStrictRuntime(configPath) {
  return spawn(process.execPath, [STRICT_RUNTIME_LAUNCHER, resolve(configPath)], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    shell: false,
  });
}

const waitForChild = (child) => new Promise((resolveChild) => {
  const onExit = (code, signal) => {
    child.removeListener("error", onError);
    resolveChild({ kind: "exit", code, signal });
  };
  const onError = () => {
    child.removeListener("exit", onExit);
    resolveChild({ kind: "error", code: 1, signal: null });
  };
  child.once("exit", onExit);
  child.once("error", onError);
});

export async function superviseM10Runtime({
  configPath,
  signal,
  spawnRuntime = spawnStrictRuntime,
  sleep = delay,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  backoffMs = DEFAULT_BACKOFF_MS,
}) {
  if (!configPath) throw new Error("M10_SUPERVISOR_CONFIG_REQUIRED");
  if (!signal) throw new Error("M10_SUPERVISOR_SIGNAL_REQUIRED");
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 10) {
    throw new Error("M10_SUPERVISOR_RESTART_BOUND_INVALID");
  }
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 30000) {
    throw new Error("M10_SUPERVISOR_BACKOFF_INVALID");
  }

  let restartCount = 0;
  while (!signal.aborted) {
    const child = spawnRuntime(configPath);
    const childDone = waitForChild(child);
    let onAbort;
    const aborted = new Promise((resolveAbort) => {
      onAbort = () => resolveAbort({ kind: "abort" });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([childDone, aborted]);
    signal.removeEventListener("abort", onAbort);

    if (outcome.kind === "abort" || signal.aborted) {
      if (!child.killed) child.kill();
      await Promise.race([childDone, sleep(2000)]);
      return 0;
    }

    if (restartCount >= maxRestarts) {
      return Number.isInteger(outcome.code) && outcome.code !== 0 ? outcome.code : 1;
    }
    restartCount += 1;
    await sleep(backoffMs * restartCount);
  }
  return 0;
}

function expectedM10ConfigPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("M10_SUPERVISOR_LOCALAPPDATA_REQUIRED");
  return resolve(localAppData, "HAIOS", "M10", "host-config.json");
}

async function main() {
  if (process.argv.length !== 3) throw new Error("M10_SUPERVISOR_ARGS_REQUIRED");
  const suppliedConfig = resolve(process.argv[2]);
  const expectedConfig = expectedM10ConfigPath();
  if (suppliedConfig.toLowerCase() !== expectedConfig.toLowerCase()) {
    throw new Error("M10_SUPERVISOR_CONFIG_REJECTED");
  }
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.once("SIGHUP", requestStop);
  try {
    return await superviseM10Runtime({ configPath: suppliedConfig, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    process.removeListener("SIGHUP", requestStop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
}
