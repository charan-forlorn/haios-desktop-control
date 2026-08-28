import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TransactionMutationAdapter } from "../src/transactions/adapter.js";
import { RollbackBundleStore } from "../src/transactions/preimage.js";

const temp: string[] = [];
afterEach(async () => {
  for (const path of temp.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

function fakeUpstream() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const existing = new Map<string, string>();
  return {
    calls,
    existing,
    probe: {
      exists: async (path: string) => existing.has(path),
      read: async (path: string) => {
        const value = existing.get(path);
        if (value === undefined) throw new Error("NOT_FOUND");
        return Buffer.from(value, "utf8");
      },
    },
    async readFile(args: { path: string }) {
      calls.push({ name: "read_file", args });
      const value = existing.get(args.path);
      if (value === undefined) throw new Error("NOT_FOUND");
      return { content: [{ type: "text", text: value }] };
    },
    async getFileInfo(args: { path: string }) {
      calls.push({ name: "get_file_info", args });
      return existing.has(args.path) ? { exists: true } : { exists: false };
    },
    async writeFile(args: { path: string; content: string; mode: "rewrite" }) {
      calls.push({ name: "write_file", args });
      existing.set(args.path, args.content);
      return { ok: true };
    },
    async moveFile(args: { source: string; destination: string }) {
      calls.push({ name: "move_file", args });
      const value = existing.get(args.source);
      if (value === undefined) throw new Error("NOT_FOUND");
      existing.delete(args.source);
      existing.set(args.destination, value);
      return { ok: true };
    },
  };
}

describe("M03 internal mutation adapter", () => {
  it("creates only when the target is absent", async () => {
    const upstream = fakeUpstream();
    const adapter = new TransactionMutationAdapter(upstream, upstream.probe);
    await expect(adapter.create("C:\\Workspace\\haios-desktop-control\\tmp\\new.txt", "hello"))
      .resolves.toMatchObject({ decision: "ALLOW" });
    expect(upstream.calls.at(-1)).toEqual({
      name: "write_file",
      args: { path: "C:\\Workspace\\haios-desktop-control\\tmp\\new.txt", content: "hello", mode: "rewrite" },
    });
  });
  it("replaces only when the expected preimage hash matches", async () => {
    const upstream = fakeUpstream();
    const path = "C:\\Workspace\\haios-desktop-control\\tmp\\replace.txt";
    upstream.existing.set(path, "before");
    const adapter = new TransactionMutationAdapter(upstream, upstream.probe);
    await expect(adapter.replace(path, "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb", "after"))
      .resolves.toMatchObject({ decision: "ALLOW", preimage: "before" });
    expect(upstream.existing.get(path)).toBe("after");
  });

  it("denies replace on preimage mismatch before write", async () => {
    const upstream = fakeUpstream();
    const path = "C:\\Workspace\\haios-desktop-control\\tmp\\replace.txt";
    upstream.existing.set(path, "before");
    const adapter = new TransactionMutationAdapter(upstream, upstream.probe);
    await expect(adapter.replace(path, "0".repeat(64), "after"))
      .resolves.toEqual({ decision: "DENY", reason: "PREIMAGE_MISMATCH" });
    expect(upstream.calls.some((call) => call.name === "write_file")).toBe(false);
  });

  it("moves only to an absent destination", async () => {
    const upstream = fakeUpstream();
    const source = "C:\\Workspace\\haios-desktop-control\\tmp\\a.txt";
    const destination = "C:\\Workspace\\haios-desktop-control\\tmp\\b.txt";
    upstream.existing.set(source, "a");
    const adapter = new TransactionMutationAdapter(upstream, upstream.probe);
    await expect(adapter.move(source, destination)).resolves.toMatchObject({ decision: "ALLOW", preimage: "a" });
    expect(upstream.existing.get(destination)).toBe("a");
  });
  it("writes rollback bytes to a transaction-private runtime bundle", async () => {
    const root = await mkdtemp("C:\\Workspace\\haios-desktop-control\\runtime\\m03-preimage-");
    temp.push(root);
    const store = new RollbackBundleStore(root, "txn_" + "a".repeat(32));
    const record = await store.capture("C:\\Workspace\\haios-desktop-control\\src\\baseline.ts", Buffer.from("before"));
    expect(record.sha256).toBe("6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb");
    expect(await readFile(record.bundlePath, "utf8")).toBe("before");
    expect(record.bundlePath.toLowerCase()).toContain(root.toLowerCase());
  });
});

