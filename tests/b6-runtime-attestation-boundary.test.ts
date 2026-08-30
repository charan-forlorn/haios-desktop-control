import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("B6 private execution-root boundary", () => {
  it("accepts a real child and rejects a junction that escapes runtime-exec", async () => {
    const root = await mkdtemp(join(tmpdir(), "b6-exec-boundary-"));
    const localAppData = join(root, "local");
    const parent = join(localAppData, "HAIOS", "B6", "runtime-exec");
    const inside = join(parent, "b6-exec-inside");
    const outside = join(root, "outside");
    const junction = join(parent, "b6-exec-junction");
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, junction, "junction");
    try {
      const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "b6-runtime-attestation.mjs")).href;
      const script = `import { resolvePrivateExecutionRoot } from ${JSON.stringify(moduleUrl)};\n`
        + `const [localAppData, inside, junction] = process.argv.slice(1);\n`
        + `const accepted = await resolvePrivateExecutionRoot(localAppData, inside);\n`
        + `if (!accepted.endsWith('b6-exec-inside')) throw new Error('INSIDE_NOT_ACCEPTED');\n`
        + `let denied=false; try { await resolvePrivateExecutionRoot(localAppData, junction); } catch(e) { denied=String(e?.message)==='B6_RUNTIME_EXECUTION_ROOT_DENIED'; }\n`
        + `if (!denied) throw new Error('JUNCTION_ESCAPE_NOT_DENIED');\n`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, localAppData, inside, junction], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
