import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { authorizePath } from "../src/paths.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const path of temporaryPaths.splice(0).reverse()) {
    await rm(path, { force: true, recursive: true });
  }
});

describe("authorizePath", () => {
  it.each([
    "C:\\Workspace",
    "C:\\Workspace\\project\\src\\index.ts",
    "c:/workspace/project/src/index.ts",
    "C:\\Workspace\\project\\missing\\file.txt",
  ])("allows a normalized path under the workspace root: %s", async (inputPath) => {
    await expect(authorizePath(inputPath)).resolves.toMatchObject({
      decision: "ALLOW",
    });
  });

  it.each([
    ["D:\\Workspace\\file.txt", "OUTSIDE_WORKSPACE"],
    ["C:\\WorkspaceElsewhere\\file.txt", "OUTSIDE_WORKSPACE"],
    ["C:\\Workspace\\..\\Windows\\system.ini", "OUTSIDE_WORKSPACE"],
    ["relative\\file.txt", "AMBIGUOUS_PATH"],
    ["C:\\Workspace\\file.txt\u0000ignored", "AMBIGUOUS_PATH"],
    ["\\\\?\\C:\\Workspace\\file.txt", "AMBIGUOUS_PATH"],
  ])("denies outside, escaping, or ambiguous path %s", async (inputPath, reason) => {
    await expect(authorizePath(inputPath)).resolves.toEqual({
      decision: "DENY",
      reason,
    });
  });

  it.each([
    "C:\\Workspace\\.env",
    "C:\\Workspace\\.ENV.local",
    "C:\\Workspace\\project\\server.pem",
    "C:\\Workspace\\project\\SERVER.KEY",
    "C:\\Workspace\\project\\.GiT\\config",
    "C:\\Workspace\\project\\Credentials\\service.json",
    "C:\\Workspace\\project\\SECRETS\\token.txt",
  ])("denies sensitive paths case-insensitively: %s", async (inputPath) => {
    await expect(authorizePath(inputPath)).resolves.toEqual({
      decision: "DENY",
      reason: "SENSITIVE_PATH",
    });
  });

  it("denies an existing junction that escapes the workspace root", async () => {
    const inside = await mkdtemp("C:\\Workspace\\haios-path-policy-");
    const outside = await mkdtemp("C:\\tmp\\haios-path-policy-");
    temporaryPaths.push(inside, outside);

    const link = join(inside, "escape");
    await mkdir(join(outside, "target"));
    await symlink(await realpath(join(outside, "target")), link, "junction");

    await expect(authorizePath(join(link, "missing.txt"))).resolves.toEqual({
      decision: "DENY",
      reason: "REPARSE_ESCAPE",
    });
  });
});
