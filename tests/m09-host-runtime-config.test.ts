import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadHostApiKey,
  validateHostOperatorLaunchConfig,
} from "../src/operator/host-runtime-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

function validConfig(): Record<string, unknown> {
  return {
    apiKeyFile: "C:\\operator\\api-key.txt",
    worktreeRoot: "C:\\operator\\worktrees",
    allowedProjects: { demo: "C:\\projects\\demo" },
    port: 8773,
    mode: "READ_ONLY_EMERGENCY",
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "m09-host-config-"));
  roots.push(root);
  return root;
}

describe("M09 host launch config boundary", () => {
  it("accepts the exact READ_ONLY_EMERGENCY shape and clones and freezes authority", () => {
    const input = validConfig();
    const projects = input.allowedProjects as Record<string, string>;
    const result = validateHostOperatorLaunchConfig(input);

    projects.extra = "C:\\projects\\extra";
    input.port = 9999;

    expect(result).toEqual({
      apiKeyFile: "C:\\operator\\api-key.txt",
      worktreeRoot: "C:\\operator\\worktrees",
      allowedProjects: { demo: "C:\\projects\\demo" },
      port: 8773,
      mode: "READ_ONLY_EMERGENCY",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.allowedProjects)).toBe(true);
  });

  it("accepts ACTIVE only with the exact M09 test scope", () => {
    expect(validateHostOperatorLaunchConfig({
      ...validConfig(), mode: "ACTIVE", activationScope: "M09_TEST_ONLY",
    })).toMatchObject({ mode: "ACTIVE", activationScope: "M09_TEST_ONLY" });

    expect(() => validateHostOperatorLaunchConfig({ ...validConfig(), mode: "ACTIVE" }))
      .toThrow("M09_ACTIVE_SCOPE_REQUIRED");
    expect(() => validateHostOperatorLaunchConfig({
      ...validConfig(), mode: "ACTIVE", activationScope: "M10_TEST_ONLY",
    })).toThrow("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
    expect(() => validateHostOperatorLaunchConfig({
      ...validConfig(), activationScope: "M09_TEST_ONLY",
    })).toThrow("M09_ACTIVE_SCOPE_NOT_AUTHORIZED");
  });

  it("rejects non-plain, partial, extra-key, inherited, and unknown-mode config", () => {
    const inherited = Object.create({ port: 8773 }) as Record<string, unknown>;
    Object.assign(inherited, validConfig());
    delete inherited.port;
    const symbolKey = { ...validConfig(), [Symbol("extra")]: true };
    const hiddenKey = validConfig();
    Object.defineProperty(hiddenKey, "extra", { value: true });

    for (const value of [
      null,
      [],
      Object.assign(Object.create(null), validConfig()),
      { ...validConfig(), extra: true },
      symbolKey,
      hiddenKey,
      { ...validConfig(), apiKeyFile: undefined },
      inherited,
      { ...validConfig(), mode: "EMERGENCY" },
    ]) {
      expect(() => validateHostOperatorLaunchConfig(value)).toThrow("M09_HOST_CONFIG_INVALID");
    }
  });

  it("rejects non-absolute Windows paths and unsafe project maps", () => {
    const inheritedProjects = Object.create({ hidden: "C:\\projects\\hidden" }) as Record<string, string>;
    inheritedProjects.demo = "C:\\projects\\demo";
    const symbolProjects = { demo: "C:\\projects\\demo", [Symbol("hidden")]: "C:\\projects\\hidden" };

    for (const value of [
      { ...validConfig(), apiKeyFile: "api-key.txt" },
      { ...validConfig(), apiKeyFile: "\\operator\\api-key.txt" },
      { ...validConfig(), apiKeyFile: "/operator/api-key.txt" },
      { ...validConfig(), worktreeRoot: "worktrees" },
      { ...validConfig(), worktreeRoot: "\\operator\\worktrees" },
      { ...validConfig(), allowedProjects: { demo: "projects\\demo" } },
      { ...validConfig(), allowedProjects: { demo: "\\projects\\demo" } },
      { ...validConfig(), allowedProjects: { "": "C:\\projects\\demo" } },
      { ...validConfig(), allowedProjects: { ["x".repeat(129)]: "C:\\projects\\demo" } },
      { ...validConfig(), allowedProjects: inheritedProjects },
      { ...validConfig(), allowedProjects: symbolProjects },
      { ...validConfig(), allowedProjects: null },
    ]) {
      expect(() => validateHostOperatorLaunchConfig(value)).toThrow("M09_HOST_CONFIG_INVALID");
    }
  });

  it("rejects accessor-bearing config and project maps without invoking getters", () => {
    let configReads = 0;
    const accessorConfig = validConfig();
    Object.defineProperty(accessorConfig, "port", {
      enumerable: true,
      get() { configReads += 1; return 8773; },
    });
    expect(() => validateHostOperatorLaunchConfig(accessorConfig)).toThrow("M09_HOST_CONFIG_INVALID");
    expect(configReads).toBe(0);

    let projectReads = 0;
    const projects: Record<string, unknown> = {};
    Object.defineProperty(projects, "demo", {
      enumerable: true,
      get() { projectReads += 1; return "C:\\projects\\demo"; },
    });
    expect(() => validateHostOperatorLaunchConfig({ ...validConfig(), allowedProjects: projects }))
      .toThrow("M09_HOST_CONFIG_INVALID");
    expect(projectReads).toBe(0);

    const throwingProxy = new Proxy(validConfig(), {
      getPrototypeOf() { throw new Error("M09_ATTACKER_CONTROLLED_SECRET"); },
    });
    expect(() => validateHostOperatorLaunchConfig(throwingProxy)).toThrow("M09_HOST_CONFIG_INVALID");
    try {
      validateHostOperatorLaunchConfig(throwingProxy);
    } catch (error) {
      expect((error as Error).message).toBe("M09_HOST_CONFIG_INVALID");
    }
  });

  it("accepts only integer ports from 1024 through 65535", () => {
    expect(validateHostOperatorLaunchConfig({ ...validConfig(), port: 1024 }).port).toBe(1024);
    expect(validateHostOperatorLaunchConfig({ ...validConfig(), port: 65535 }).port).toBe(65535);
    for (const port of [1023, 65536, 8773.5, "8773", Number.NaN]) {
      expect(() => validateHostOperatorLaunchConfig({ ...validConfig(), port }))
        .toThrow("M09_PORT_INVALID");
    }
  });
});

describe("M09 host API key file boundary", () => {
  it("loads a valid key and removes at most one terminal LF or CRLF", async () => {
    const root = await tempRoot();
    const plain = join(root, "plain.key");
    const lf = join(root, "lf.key");
    const crlf = join(root, "crlf.key");
    await writeFile(plain, "a".repeat(16));
    await writeFile(lf, `${"b".repeat(16)}\n`);
    await writeFile(crlf, `${"c".repeat(16)}\r\n`);

    await expect(loadHostApiKey(plain)).resolves.toBe("a".repeat(16));
    await expect(loadHostApiKey(lf)).resolves.toBe("b".repeat(16));
    await expect(loadHostApiKey(crlf)).resolves.toBe("c".repeat(16));
  });

  it("rejects invalid paths, missing targets, directories, and symbolic links", async () => {
    const root = await tempRoot();
    const target = join(root, "target.key");
    const link = join(root, "link");
    const directory = join(root, "directory");
    await writeFile(target, "d".repeat(16));
    await mkdir(directory);
    await symlink(directory, link, "junction");

    await expect(loadHostApiKey("relative.key")).rejects.toThrow("M09_API_KEY_PATH_INVALID");
    await expect(loadHostApiKey(join(root, "missing.key"))).rejects.toThrow("M09_API_KEY_FILE_INVALID");
    await expect(loadHostApiKey(directory)).rejects.toThrow("M09_API_KEY_FILE_INVALID");
    await expect(loadHostApiKey(link)).rejects.toThrow("M09_API_KEY_FILE_INVALID");
  });

  it("enforces byte and character bounds plus content rules", async () => {
    const root = await tempRoot();
    const cases: Array<[string, string | Buffer]> = [
      ["short.key", "e".repeat(15)],
      ["large.key", "f".repeat(513)],
      ["short-after-newline.key", `${"g".repeat(15)}\n`],
      ["two-newlines.key", `${"h".repeat(16)}\n\n`],
      ["nul.key", `i${"j".repeat(15)}\0`],
      ["embedded-cr.key", `${"k".repeat(16)}\rmore`],
      ["leading-space.key", ` ${"l".repeat(16)}`],
      ["trailing-space.key", `${"m".repeat(16)} `],
      ["invalid-utf8.key", Buffer.from([0xff, ...Buffer.from("n".repeat(15))])],
      ["bom.key", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("o".repeat(16))])],
      ["too-many-chars.key", "Ã©".repeat(257)],
    ];

    for (const [name, bytes] of cases) {
      const path = join(root, name);
      await writeFile(path, bytes);
      await expect(loadHostApiKey(path)).rejects.toThrow("M09_API_KEY_FILE_INVALID");
    }
  });

  it("never includes secret bytes in an error", async () => {
    const root = await tempRoot();
    const secret = "SENSITIVE-KEY-BYTES";
    const path = join(root, "invalid.key");
    await writeFile(path, ` ${secret}`);

    const error = await loadHostApiKey(path).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("M09_API_KEY_FILE_INVALID");
    expect((error as Error).message).not.toContain(secret);
  });
});
