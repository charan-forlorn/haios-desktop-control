import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RecoveryLeaseManager,
  type ProcessIdentityProbe,
} from "../src/operator/recovery-lease.js";

const roots: string[] = [];
const REPO = "C:\\Workspace\\haios-operator-canary\\.git";
const START = "2026-08-30T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeProcessProbe implements ProcessIdentityProbe {
  state: { alive: boolean; startTime: string } | undefined = { alive: true, startTime: START };
  async inspect(_pid: number) { return this.state; }
}
async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "m12-recovery-lease-"));
  roots.push(stateRoot);
  const probe = new FakeProcessProbe();
  let now = Date.parse("2026-08-30T00:05:00.000Z");
  const manager = new RecoveryLeaseManager({ stateRoot, processProbe: probe, now: () => now });
  return { stateRoot, probe, manager, tick: (ms: number) => { now += ms; } };
}

const request = () => ({
  projectId: "operator-canary" as const,
  repositoryIdentity: REPO,
  transactionId: "txn_0123456789abcdef0123456789abcdef",
  ownerPid: 4242,
  ownerStartTime: START,
  ttlMs: 30_000,
});

describe("M12 ownership-aware recovery lease", () => {
  it("acquires exclusively under the leases root and binds exact identity", async () => {
    const { stateRoot, manager } = await fixture();
    const lease = await manager.acquire(request());
    expect(lease).toMatchObject({ schema: "HAIOS_M12_RECOVERY_LEASE_R1", runtimeIdentity: "HAIOS_M12_OPERATOR_RUNTIME_R1", ...request() });
    expect(JSON.parse(await readFile(join(stateRoot, "leases", `${request().transactionId}.json`), "utf8"))).toEqual(lease);
    await expect(manager.acquire(request())).rejects.toThrow("M12_RECOVERY_LEASE_CONFLICT");
  });

  it("refuses acquisition unless the owner PID and start identity are live-exact", async () => {
    const { manager, probe } = await fixture();
    probe.state = { alive: true, startTime: "2026-08-30T00:01:00.000Z" };
    await expect(manager.acquire(request())).rejects.toThrow("M12_RECOVERY_LEASE_DENIED");
    probe.state = { alive: false, startTime: START };
    await expect(manager.acquire(request())).rejects.toThrow("M12_RECOVERY_LEASE_DENIED");
  });

  it("detects PID reuse by comparing process start identity", async () => {
    const { manager, probe } = await fixture();
    await manager.acquire(request());
    probe.state = { alive: true, startTime: "2026-08-30T00:01:00.000Z" };
    await expect(manager.inspect(request().transactionId)).resolves.toMatchObject({ owner: "DEAD_OR_REUSED" });
  });

  it("treats an exact live owner as active and permits exact heartbeat", async () => {
    const { manager, tick } = await fixture();
    const first = await manager.acquire(request());
    tick(5_000);
    const beat = await manager.heartbeat(request().transactionId, { ownerPid: 4242, ownerStartTime: START });
    expect(beat.heartbeatAt).not.toBe(first.heartbeatAt);
    await expect(manager.inspect(request().transactionId)).resolves.toMatchObject({ owner: "LIVE", expired: false });
  });

  it("marks expired or dead exact leases without deleting them", async () => {
    const { stateRoot, manager, probe, tick } = await fixture();
    await manager.acquire(request());
    tick(31_000);
    probe.state = { alive: false, startTime: START };
    await expect(manager.inspect(request().transactionId)).resolves.toMatchObject({ owner: "DEAD_OR_REUSED", expired: true });
    await expect(readFile(join(stateRoot, "leases", `${request().transactionId}.json`), "utf8")).resolves.toContain(request().transactionId);
  });

  it("fails closed for schema corruption, repository mismatch, or wrong release owner", async () => {
    const { stateRoot, manager } = await fixture();
    await manager.acquire(request());
    const path = join(stateRoot, "leases", `${request().transactionId}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...stored, schema: "HAIOS_M12_RECOVERY_LEASE_R2" }), "utf8");
    await expect(manager.inspect(request().transactionId)).rejects.toThrow("M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED");

    await rm(stateRoot, { recursive: true, force: true });
    roots.splice(roots.indexOf(stateRoot), 1);
    const next = await fixture();
    await next.manager.acquire(request());
    await expect(next.manager.inspect(request().transactionId, "C:\\wrong\\.git"))
      .resolves.toMatchObject({ repositoryMatch: false });
    await expect(next.manager.release(request().transactionId, { ownerPid: 7, ownerStartTime: START }))
      .rejects.toThrow("M12_RECOVERY_LEASE_DENIED");
  });
  it("maps durable field corruption to reconciliation and refuses release by a dead owner", async () => {
    const { stateRoot, manager, probe } = await fixture();
    await manager.acquire(request());
    const path = join(stateRoot, "leases", `${request().transactionId}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...stored, ownerPid: -1 }), "utf8");
    await expect(manager.inspect(request().transactionId)).rejects.toThrow("M12_RECOVERY_LEASE_RECONCILIATION_REQUIRED");

    await rm(stateRoot, { recursive: true, force: true });
    roots.splice(roots.indexOf(stateRoot), 1);
    const next = await fixture();
    await next.manager.acquire(request());
    next.probe.state = { alive: false, startTime: START };
    await expect(next.manager.release(request().transactionId, { ownerPid: 4242, ownerStartTime: START }))
      .rejects.toThrow("M12_RECOVERY_LEASE_DENIED");
  });

});
