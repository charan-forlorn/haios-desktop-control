import { describe, expect, it } from "vitest";

import { authenticateApiKey } from "../src/auth.js";

describe("authenticateApiKey", () => {
  it("allows an exact API key match", () => {
    expect(authenticateApiKey({ "x-api-key": "correct-key" }, "correct-key"))
      .toEqual({ decision: "ALLOW" });
  });

  it("accepts header names case-insensitively", () => {
    expect(authenticateApiKey({ "X-API-Key": "correct-key" }, "correct-key"))
      .toEqual({ decision: "ALLOW" });
  });

  it.each([
    [{}, "correct-key", "MISSING_API_KEY"],
    [{ "x-api-key": "" }, "correct-key", "MISSING_API_KEY"],
    [{ "x-api-key": "wrong-key" }, "correct-key", "INVALID_API_KEY"],
    [{ "x-api-key": "correct-key" }, "", "INVALID_CONFIGURATION"],
    [{ "x-api-key": ["correct-key", "second-key"] }, "correct-key", "AMBIGUOUS_API_KEY"],
  ] as const)("fails closed for invalid or ambiguous input", (headers, expectedKey, reason) => {
    expect(authenticateApiKey(headers, expectedKey)).toEqual({
      decision: "DENY",
      reason,
    });
  });
});
