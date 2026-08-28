import { rename, unlink, writeFile } from "node:fs/promises";

import { NODE_FILE_PROBE, sha256Bytes, type FileProbe } from "./adapter.js";
import type { RollbackBundleStore } from "./preimage.js";
import type { RollbackPlan } from "./types.js";

export type RollbackResult =
  | { readonly decision: "ALLOW" }
  | { readonly decision: "DENY"; readonly reason: "ROLLBACK_CONFLICT" | "ROLLBACK_FAILED" };

async function currentHash(probe: FileProbe, path: string): Promise<string | null> {
  if (!(await probe.exists(path))) return null;
  return sha256Bytes(await probe.read(path));
}

export async function rollbackPlans(
  plans: readonly RollbackPlan[],
  bundles: RollbackBundleStore,
  probe: FileProbe = NODE_FILE_PROBE,
): Promise<RollbackResult> {
  try {
    for (const plan of [...plans].reverse()) {
      if (plan.kind === "create") {
        const hash = await currentHash(probe, plan.path);
        if (hash === null) continue;
        if (hash !== plan.postSha256) return { decision: "DENY", reason: "ROLLBACK_CONFLICT" };
        await unlink(plan.path);
        continue;
      }
      if (plan.kind === "replace") {
        const hash = await currentHash(probe, plan.path);
        if (hash === plan.preSha256) continue;
        if (hash !== plan.postSha256) return { decision: "DENY", reason: "ROLLBACK_CONFLICT" };
        const bytes = await bundles.read(plan.bundlePath);
        if (sha256Bytes(bytes) !== plan.preSha256) return { decision: "DENY", reason: "ROLLBACK_CONFLICT" };
        await writeFile(plan.path, bytes);
        continue;
      }

      const sourceHash = await currentHash(probe, plan.sourcePath);
      const destinationHash = await currentHash(probe, plan.destinationPath);
      if (sourceHash === plan.preSha256 && destinationHash === null) continue;
      if (sourceHash !== null || destinationHash !== plan.postSha256) {
        return { decision: "DENY", reason: "ROLLBACK_CONFLICT" };
      }
      await rename(plan.destinationPath, plan.sourcePath);
    }
    return { decision: "ALLOW" };
  } catch {
    return { decision: "DENY", reason: "ROLLBACK_FAILED" };
  }
}
