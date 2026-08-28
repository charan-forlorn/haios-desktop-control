import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface MutationUpstream {
  writeFile(args: { path: string; content: string; mode: "rewrite" }): Promise<unknown>;
  moveFile(args: { source: string; destination: string }): Promise<unknown>;
}

export interface FileProbe {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Buffer>;
}

export const NODE_FILE_PROBE: FileProbe = Object.freeze({
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  read: (path: string) => readFile(path),
});

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export type MutationAdapterResult =
  | { readonly decision: "ALLOW"; readonly preimage?: string }
  | { readonly decision: "DENY"; readonly reason: string };

export class TransactionMutationAdapter {
  readonly #upstream: MutationUpstream;
  readonly #probe: FileProbe;

  constructor(upstream: MutationUpstream, probe: FileProbe = NODE_FILE_PROBE) {
    this.#upstream = upstream;
    this.#probe = probe;
  }

  async create(path: string, content: string): Promise<MutationAdapterResult> {
    if (await this.#probe.exists(path)) return { decision: "DENY", reason: "TARGET_EXISTS" };
    await this.#upstream.writeFile({ path, content, mode: "rewrite" });
    return { decision: "ALLOW" };
  }

  async replace(path: string, expectedSha256: string, content: string): Promise<MutationAdapterResult> {
    if (!(await this.#probe.exists(path))) return { decision: "DENY", reason: "TARGET_MISSING" };
    const bytes = await this.#probe.read(path);
    if (sha256Bytes(bytes) !== expectedSha256) return { decision: "DENY", reason: "PREIMAGE_MISMATCH" };
    await this.#upstream.writeFile({ path, content, mode: "rewrite" });
    return { decision: "ALLOW", preimage: bytes.toString("utf8") };
  }
  async removeToQuarantine(source: string, destination: string, expectedSha256: string): Promise<MutationAdapterResult> {
    if (!(await this.#probe.exists(source))) return { decision: "DENY", reason: "SOURCE_MISSING" };
    if (await this.#probe.exists(destination)) return { decision: "DENY", reason: "DESTINATION_EXISTS" };
    const bytes = await this.#probe.read(source);
    if (sha256Bytes(bytes) !== expectedSha256) return { decision: "DENY", reason: "PREIMAGE_MISMATCH" };
    await this.#upstream.moveFile({ source, destination });
    return { decision: "ALLOW", preimage: bytes.toString("utf8") };
  }

  async move(source: string, destination: string): Promise<MutationAdapterResult> {
    if (!(await this.#probe.exists(source))) return { decision: "DENY", reason: "SOURCE_MISSING" };
    if (await this.#probe.exists(destination)) return { decision: "DENY", reason: "DESTINATION_EXISTS" };
    const bytes = await this.#probe.read(source);
    await this.#upstream.moveFile({ source, destination });
    return { decision: "ALLOW", preimage: bytes.toString("utf8") };
  }
}
