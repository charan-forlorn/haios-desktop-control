import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const harnessPath = join(process.cwd(), "scripts", "qualify-m12-disposable-b5.mjs");

describe("M12 disposable build isolation", () => {
  it("never mutates the repository shared dist while preparing fresh qualification bytes", async () => {
    const source = await readFile(harnessPath, "utf8");
    expect(source).toContain('mkdtemp(join(ROOT, "runtime", "m12-disposable-build-")');
    expect(source).toContain('mkdir(join(ROOT, "runtime"), { recursive: true })');
    expect(source).toContain('"--outDir", distRoot');
    expect(source).toContain("runtimeDistRoot");
    expect(source).not.toContain('const distRoot = join(ROOT, "dist")');
    expect(source).not.toContain('deterministicDirectoryDigest(join(ROOT, "dist"))');
  });
});
