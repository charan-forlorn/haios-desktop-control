import { authorizePath } from "../paths.js";
import { authorizeTool } from "../policy.js";
import {
  DESKTOP_COMMANDER_VERSION,
  type DesktopCommanderReadClient,
} from "../upstream.js";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_READ_LINES = 500;
const MAX_MULTI_READ_FILES = 10;
const MAX_SEARCH_RESULTS = 100;

export type GatewayReadResult =
  | {
      readonly decision: "ALLOW";
      readonly data: unknown;
      readonly truncated: boolean;
    }
  | { readonly decision: "DENY"; readonly reason: string };

export interface ReadDispatchContext {
  readonly upstream: DesktopCommanderReadClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deny(reason: string): GatewayReadResult {
  return { decision: "DENY", reason };
}

function allow(data: unknown): GatewayReadResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return deny("UNSERIALIZABLE_UPSTREAM_RESULT");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_RESULT_BYTES) {
    return {
      decision: "ALLOW",
      data: { resultClass: "TRUNCATED", originalBytes: bytes },
      truncated: true,
    };
  }
  return { decision: "ALLOW", data, truncated: false };
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  if (!Number.isInteger(value)) return null;
  const number = value as number;
  return number >= min && number <= max ? number : null;
}

function stringField(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function authorizedPath(value: unknown): Promise<string | null> {
  if (typeof value !== "string") return null;
  const decision = await authorizePath(value);
  return decision.decision === "ALLOW" ? decision.normalizedPath : null;
}

export async function dispatchReadTool(
  name: string,
  rawArgs: unknown,
  context: ReadDispatchContext,
): Promise<GatewayReadResult> {
  if (authorizeTool(name) !== "ALLOW") {
    return deny("TOOL_DENIED");
  }
  const args = isRecord(rawArgs) ? rawArgs : {};

  if (name === "gateway_status") {
    return allow({
      readCapability: "QUALIFIED_CANDIDATE",
      executeCapability: "LOCKED",
      mutateCapability: "LOCKED",
      destructiveCapability: "LOCKED",
    });
  }

  if (name === "desktop_status") {
    await context.upstream.getConfig();
    return allow({
      desktopCommanderVersion: DESKTOP_COMMANDER_VERSION,
      transport: "stdio",
      upstreamReachable: true,
    });
  }

  if (name === "filesystem_list") {
    const path = await authorizedPath(args.path);
    const depth = args.depth === undefined ? 2 : integerInRange(args.depth, 1, 4);
    if (path === null || depth === null) return deny("INVALID_ARGUMENTS");
    return allow(await context.upstream.listDirectory({ path, depth }));
  }

  if (name === "filesystem_read") {
    const path = await authorizedPath(args.path);
    if (path === null) return deny("INVALID_ARGUMENTS");
    const offset = args.offset === undefined ? undefined : integerInRange(args.offset, -1000000, 1000000);
    const length = args.length === undefined ? MAX_READ_LINES : integerInRange(args.length, 1, MAX_READ_LINES);
    if (args.offset !== undefined && offset === null) return deny("INVALID_ARGUMENTS");
    if (length === null) return deny("INVALID_ARGUMENTS");
    const request: { path: string; offset?: number; length?: number } = { path, length };
    if (offset !== undefined && offset !== null) request.offset = offset;
    return allow(await context.upstream.readFile(request));
  }

  if (name === "filesystem_read_multiple") {
    if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > MAX_MULTI_READ_FILES) {
      return deny("INVALID_ARGUMENTS");
    }
    const paths: string[] = [];
    for (const item of args.paths) {
      const path = await authorizedPath(item);
      if (path === null) return deny("PATH_DENIED");
      paths.push(path);
    }
    return allow(await context.upstream.readMultipleFiles({ paths }));
  }

  if (name === "filesystem_stat") {
    const path = await authorizedPath(args.path);
    if (path === null) return deny("INVALID_ARGUMENTS");
    return allow(await context.upstream.getFileInfo({ path }));
  }

  if (name === "search_start") {
    const path = await authorizedPath(args.path);
    const pattern = stringField(args, "pattern");
    const searchType = args.searchType;
    if (
      path === null ||
      pattern === null ||
      pattern.length > 512 ||
      (searchType !== "files" && searchType !== "content")
    ) {
      return deny("INVALID_ARGUMENTS");
    }
    const maxResults = args.maxResults === undefined ? 50 : integerInRange(args.maxResults, 1, MAX_SEARCH_RESULTS);
    const contextLines = args.contextLines === undefined ? 3 : integerInRange(args.contextLines, 0, 5);
    if (maxResults === null || contextLines === null) return deny("INVALID_ARGUMENTS");
    return allow(
      await context.upstream.startSearch({
        path,
        pattern,
        searchType,
        maxResults,
        contextLines,
      }),
    );
  }

  if (name === "search_results") {
    const sessionId = stringField(args, "sessionId");
    const offset = args.offset === undefined ? 0 : integerInRange(args.offset, -1000000, 1000000);
    const length = args.length === undefined ? 50 : integerInRange(args.length, 1, MAX_SEARCH_RESULTS);
    if (sessionId === null || sessionId.length > 200 || offset === null || length === null) {
      return deny("INVALID_ARGUMENTS");
    }
    return allow(await context.upstream.getMoreSearchResults({ sessionId, offset, length }));
  }

  if (name === "search_stop") {
    const sessionId = stringField(args, "sessionId");
    if (sessionId === null || sessionId.length > 200) return deny("INVALID_ARGUMENTS");
    return allow(await context.upstream.stopSearch({ sessionId }));
  }

  if (name === "search_list") {
    return allow(await context.upstream.listSearches());
  }

  if (name === "process_list") {
    return allow(await context.upstream.listProcesses());
  }

  if (name === "session_list") {
    return allow(await context.upstream.listSessions());
  }

  return deny("TOOL_DENIED");
}
