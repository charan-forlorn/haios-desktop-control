import { readFile } from "node:fs/promises";
import { createB6ActiveRuntime, createB6ReadinessMetadata } from "../dist/src/operator/b6-active-runtime.js";

const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("B6_CONFIG_PATH_REQUIRED");
const config = JSON.parse(await readFile(args[0], "utf8"));
const started = await createB6ActiveRuntime(config);
await started.listen();
process.stdout.write(`${JSON.stringify(createB6ReadinessMetadata(config))}\n`);
const close = async () => { await started.close(); process.exitCode = 0; };
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
