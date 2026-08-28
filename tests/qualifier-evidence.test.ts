import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("M02 qualification evidence integrity", () => {
  it("derives tunnel_modified from pre/post tunnel digests", async () => {
    const script = await readFile("scripts/qualify-m02.ps1", "utf8");
    expect(script).toContain("function Get-TunnelIntegrityDigest");
    expect(script).toContain("$TunnelPreDigests");
    expect(script).toContain("$TunnelPostDigests");
    expect(script).toContain("$TunnelModified =");
    expect(script).toContain("tunnel_integrity = @(");
    expect(script).toContain("tunnel_modified = $TunnelModified");
    expect(script).not.toContain("tunnel_modified = $false");
  });
});
