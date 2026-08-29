import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_MODULE = "../dist/src/operator/m12-active-canary-runtime.js";

async function readConfig(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error("M12_ACTIVE_CANARY_CONFIG_PATH_REQUIRED");
  }
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new Error("M12_ACTIVE_CANARY_CONFIG_INVALID");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("M12_ACTIVE_CANARY_CONFIG_INVALID");
  }
}

export async function startM12ActiveCanaryRuntime(configPath) {
  const config = await readConfig(configPath);
  const runtimeModule = await import(RUNTIME_MODULE);
  const metadata = runtimeModule.createM12ActiveCanaryReadinessMetadata(config);
  const gateway = await runtimeModule.createM12ActiveCanaryRuntime(config);
  await gateway.listen();

  let closed = false;
  const close = Object.freeze(async () => {
    if (closed) return;
    closed = true;
    await gateway.close();
  });
  return Object.freeze({ metadata, close });
}

function stableError(error) {
  if (error instanceof Error && /^M12_/u.test(error.message)) return error.message;
  return "M12_ACTIVE_CANARY_RUNTIME_START_FAILED";
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error("M12_ACTIVE_CANARY_CONFIG_PATH_REQUIRED");
  const started = await startM12ActiveCanaryRuntime(args[0]);
  process.stdout.write(`${JSON.stringify(started.metadata)}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await started.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
const selfPath = resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (entryPath === selfPath) {
  main().catch((error) => {
    process.stderr.write(`${stableError(error)}\n`);
    process.exitCode = 1;
  });
}
