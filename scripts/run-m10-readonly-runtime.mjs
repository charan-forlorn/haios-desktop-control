import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_MODULE = "../dist/src/operator/m10-production-config.js";
const RUNTIME_MODULE = "../dist/src/operator/host-runtime.js";

async function readConfig(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error("M10_PRODUCTION_CONFIG_PATH_REQUIRED");
  }
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new Error("M10_PRODUCTION_CONFIG_INVALID");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("M10_PRODUCTION_CONFIG_INVALID");
  }
}

export async function startM10ReadOnlyRuntime(configPath) {
  const raw = await readConfig(configPath);
  const configModule = await import(CONFIG_MODULE);
  const runtimeModule = await import(RUNTIME_MODULE);
  const validated = configModule.validateM10ReadOnlyProductionConfig(raw);
  const metadata = runtimeModule.createHostOperatorReadinessMetadata(validated);
  const gateway = await runtimeModule.createHostOperatorRuntime(validated);
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
  if (error instanceof Error && /^(?:M10_|M09_|M08_)/u.test(error.message)) return error.message;
  return "M10_READONLY_RUNTIME_START_FAILED";
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error("M10_PRODUCTION_CONFIG_PATH_REQUIRED");
  const started = await startM10ReadOnlyRuntime(args[0]);
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
