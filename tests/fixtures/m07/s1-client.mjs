import { existsSync } from "node:fs";

const fixture = await fetch("http://m07-fixture:8080", { signal: AbortSignal.timeout(2000) });
if ((await fixture.text()) !== "M07_FIXTURE_OK") throw new Error("S1_FIXTURE_RESPONSE_MISMATCH");
for (const url of ["http://example.com", "http://host.docker.internal:8768"]) {
  let denied = false;
  try { await fetch(url, { signal: AbortSignal.timeout(1200) }); } catch { denied = true; }
  if (!denied) throw new Error(`S1_UNAUTHORIZED_NETWORK:${url}`);
}
if (existsSync("/var/run/docker.sock")) throw new Error("S1_DOCKER_SOCKET_PRESENT");
if (process.env.GITHUB_TOKEN || process.env.OPENAI_API_KEY) throw new Error("S1_SECRET_ENV_PRESENT");
console.log("M07_S1_FIXTURE_ONLY_PASS");