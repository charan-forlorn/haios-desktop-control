import type { TransactionCurrentness } from "./types.js";

export type CurrentnessProvider = () => Promise<TransactionCurrentness>;

export function sameCurrentness(a: TransactionCurrentness, b: TransactionCurrentness): boolean {
  return a.head === b.head && a.branch === b.branch && a.trackedStateDigest === b.trackedStateDigest;
}
