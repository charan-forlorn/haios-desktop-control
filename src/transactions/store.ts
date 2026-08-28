import type { TransactionRecord } from "./types.js";

export class TransactionStore {
  readonly #records = new Map<string, TransactionRecord>();

  add(record: TransactionRecord): void {
    if (this.#records.has(record.id)) throw new Error("DUPLICATE_TRANSACTION_ID");
    this.#records.set(record.id, record);
  }

  get(id: string): TransactionRecord | undefined {
    return this.#records.get(id);
  }

  require(id: string): TransactionRecord {
    const record = this.#records.get(id);
    if (record === undefined) throw new Error("TRANSACTION_NOT_FOUND");
    return record;
  }
}
