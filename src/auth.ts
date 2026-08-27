import { createHash, timingSafeEqual } from "node:crypto";

export type AuthDecision =
  | { readonly decision: "ALLOW" }
  | {
      readonly decision: "DENY";
      readonly reason:
        | "MISSING_API_KEY"
        | "INVALID_API_KEY"
        | "INVALID_CONFIGURATION"
        | "AMBIGUOUS_API_KEY";
    };

export type HeaderMap = Readonly<Record<string, string | readonly string[] | undefined>>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function authenticateApiKey(
  headers: HeaderMap,
  expectedKey: string,
): AuthDecision {
  if (!expectedKey) {
    return { decision: "DENY", reason: "INVALID_CONFIGURATION" };
  }

  const matching = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "x-api-key",
  );

  if (matching.length !== 1) {
    return {
      decision: "DENY",
      reason: matching.length === 0 ? "MISSING_API_KEY" : "AMBIGUOUS_API_KEY",
    };
  }

  const value = matching[0]?.[1];
  if (Array.isArray(value)) {
    return { decision: "DENY", reason: "AMBIGUOUS_API_KEY" };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { decision: "DENY", reason: "MISSING_API_KEY" };
  }

  return constantTimeEqual(value, expectedKey)
    ? { decision: "ALLOW" }
    : { decision: "DENY", reason: "INVALID_API_KEY" };
}
