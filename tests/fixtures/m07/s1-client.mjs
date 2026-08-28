import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

const fixture = await fetch("http://127.0.0.1:8080", { signal: AbortSignal.timeout(2000) });
if ((await fixture.text()) !== "M07_FIXTURE_OK") throw new Error("S1_FIXTURE_RESPONSE_MISMATCH");
const nonLoopback = Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal);
if (nonLoopback.length !== 0) throw new Error("S1_NON_LOOPBACK_INTERFACE_PRESENT");
for (const url of ["http://example.com", "http://172.17.0.1:8768", "http://host.docker.internal:8768"]) {
  let denied = false;
  try { await fetch(url, { signal: AbortSignal.timeout(1200) }); } catch { denied = true; }
  if (!denied) throw new Error(`S1_UNAUTHORIZED_NETWORK:${url}`);
}
if (existsSync("/var/run/docker.sock")) throw new Error("S1_DOCKER_SOCKET_PRESENT");
if (process.env.GITHUB_TOKEN || process.env.OPENAI_API_KEY) throw new Error("S1_SECRET_ENV_PRESENT");
console.log("M07_S1_FIXTURE_ONLY_PASS");
