import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("S0 has no external or secret authority", async () => {
  let denied = false;
  try {
    await fetch("http://example.com", { signal: AbortSignal.timeout(1200) });
  } catch {
    denied = true;
  }
  assert.equal(denied, true);
  assert.equal(existsSync("/var/run/docker.sock"), false);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});