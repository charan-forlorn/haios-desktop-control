import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RollbackBundleRecord {
  readonly sourcePath: string;
  readonly sha256: string;
  readonly bundlePath: string;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class RollbackBundleStore {
  readonly #root: string;
  readonly #transactionId: string;

  constructor(root: string, transactionId: string) {
    if (!/^txn_[a-f0-9]{32}$/.test(transactionId)) throw new Error("INVALID_TRANSACTION_ID");
    this.#root = root;
    this.#transactionId = transactionId;
  }

  #pathDigest(sourcePath: string): string {
    return createHash("sha256").update(sourcePath.toLowerCase(), "utf8").digest("hex");
  }

  async capture(sourcePath: string, bytes: Buffer): Promise<RollbackBundleRecord> {
    const directory = join(this.#root, this.#transactionId);
    await mkdir(directory, { recursive: true });
    const bundlePath = join(directory, `${this.#pathDigest(sourcePath)}.bin`);
    await writeFile(bundlePath, bytes, { flag: "wx" });
    return Object.freeze({
      sourcePath,
      sha256: digest(bytes),
      bundlePath,
    });
  }

  async prepareQuarantine(sourcePath: string): Promise<string> {
    const directory = join(this.#root, this.#transactionId, "quarantine");
    await mkdir(directory, { recursive: true });
    return join(directory, `${this.#pathDigest(sourcePath)}.bin`);
  }

  read(bundlePath: string): Promise<Buffer> {
    return readFile(bundlePath);
  }
}
