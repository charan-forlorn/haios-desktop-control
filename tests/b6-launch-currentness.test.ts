import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("B6 launch currentness hardening", () => {
  it("revalidates frozen source immediately before private runtime import", async () => {
    const attestation = await import(pathToFileURL(join(root, "scripts", "b6-runtime-attestation.mjs")).href) as Record<string, unknown>;
    expect(typeof attestation.assertPreparedCandidateStillCurrent).toBe("function");
    if (typeof attestation.assertPreparedCandidateStillCurrent !== "function") return;
    const assertCurrent = attestation.assertPreparedCandidateStillCurrent as (prepared: unknown) => Promise<unknown>;
    await expect(assertCurrent({ candidateHeadSha: "0".repeat(40), candidateTrackedCount: 1, candidateManifestSha256: "0".repeat(64) }))
      .rejects.toThrow("B6_RUNTIME_SOURCE_NOT_CURRENT");
    const launcher = await readFile(join(root, "scripts", "run-b6-project-expansion-runtime.mjs"), "utf8");
    const marker = "await assertPreparedCandidateStillCurrent(prepared)";
    const verify = launcher.indexOf("buildRoot = await verifyPreparedB6RuntimeBuild(prepared)");
    const revalidate = launcher.lastIndexOf(marker);
    const runtimeImport = launcher.indexOf("await import(pathToFileURL(join(executionRoot");
    expect(revalidate).toBeGreaterThan(verify);
    expect(revalidate).toBeLessThan(runtimeImport);
  });

  it("binds attestation to process creation identity and the actual listening PID", async () => {
    const helperPath = join(root, "scripts", "b6-process-identity.mjs");
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;
    const helper = await import(pathToFileURL(helperPath).href) as Record<string, unknown>;
    expect(typeof helper.inspectProcessIdentity).toBe("function");
    expect(typeof helper.assertAttestedListenerIdentity).toBe("function");
    const child = spawn(process.execPath, ["--input-type=module", "-e", "import {createServer} from 'node:net'; const s=createServer(); s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port}))); setInterval(()=>{},1000);"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(() => reject(new Error("B6_TEST_LISTENER_TIMEOUT")), 10_000);
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`B6_TEST_LISTENER_EXIT_${code}`)); });
        child.stdout!.once("data", (chunk) => { clearTimeout(timer); resolvePort(JSON.parse(String(chunk).trim()).port); });
      });
      const inspect = helper.inspectProcessIdentity as (pid: number) => Promise<Record<string, unknown>>;
      const assertIdentity = helper.assertAttestedListenerIdentity as (value: unknown, port: number) => Promise<unknown>;
      const identity = await inspect(child.pid!);
      await expect(assertIdentity(identity, port)).resolves.toBeUndefined();
      await expect(assertIdentity({ ...identity, processCreationTime: "1970-01-01T00:00:00.000Z" }, port))
        .rejects.toThrow("B6_RUNTIME_PROCESS_NOT_CURRENT");
    } finally {
      child.kill();
      await new Promise<void>((resolveDone) => child.once("exit", () => resolveDone()));
    }
  }, 30_000);
});