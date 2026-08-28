import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createServer, type Server as HttpServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { NOOP_AUDIT_SINK, type AuditSink } from "./audit.js";
import { authenticateApiKey } from "./auth.js";
import {
  classifyGatewayTool,
  EXECUTE_TOOL_DEFINITIONS,
  MUTATE_TOOL_DEFINITIONS,
  READ_TOOL_DEFINITIONS,
} from "./capabilities.js";
import { dispatchExecuteTool } from "./execute.js";
import { TransactionMutationAdapter } from "./transactions/adapter.js";
import { createGitCurrentnessProvider, TRANSACTION_PROJECT_ROOT } from "./transactions/currentness.js";
import { TransactionService, dispatchTransactionTool, type TransactionServiceApi } from "./transactions/service.js";
import { dispatchReadTool } from "./tools/read-tools.js";
import type { DesktopCommanderExecuteClient, DesktopCommanderMutationClient, DesktopCommanderReadClient } from "./upstream.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8772;
const MAX_HTTP_BODY_BYTES = 128 * 1024;

export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface GatewayRuntime {
  listen(): Promise<GatewayAddress>;
  close(): Promise<void>;
}

export interface GatewayServerConfig {
  readonly apiKey: string;
  readonly upstream: DesktopCommanderReadClient;
  readonly auditSink?: AuditSink;
  readonly transactionService?: TransactionServiceApi;
  readonly host?: string;
  readonly port?: number;
}

function isExecuteClient(upstream: DesktopCommanderReadClient): upstream is DesktopCommanderExecuteClient {
  const candidate = upstream as Partial<DesktopCommanderExecuteClient>;
  return (
    typeof candidate.startProcess === "function" &&
    typeof candidate.readProcessOutput === "function" &&
    typeof candidate.killProcess === "function"
  );
}

function isMutationClient(upstream: DesktopCommanderReadClient): upstream is DesktopCommanderMutationClient {
  if (!isExecuteClient(upstream)) return false;
  const candidate = upstream as Partial<DesktopCommanderMutationClient>;
  return typeof candidate.writeFile === "function" && typeof candidate.moveFile === "function";
}

function objectSchema(
  properties: Record<string, object> = {},
  required: string[] = [],
): Tool["inputSchema"] {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;

const INPUT_SCHEMAS: Record<string, Tool["inputSchema"]> = {
  desktop_status: objectSchema(),
  gateway_status: objectSchema(),
  filesystem_list: objectSchema(
    { path: STRING, depth: { ...INTEGER, minimum: 1, maximum: 4 } },
    ["path"],
  ),
  filesystem_read: objectSchema(
    {
      path: STRING,
      offset: INTEGER,
      length: { ...INTEGER, minimum: 1, maximum: 500 },
    },
    ["path"],
  ),
  filesystem_read_multiple: objectSchema(
    { paths: { type: "array", items: STRING, minItems: 1, maxItems: 10 } },
    ["paths"],
  ),
  filesystem_stat: objectSchema({ path: STRING }, ["path"]),
};

Object.assign(INPUT_SCHEMAS, {
  search_start: objectSchema(
    {
      path: STRING,
      pattern: STRING,
      searchType: { type: "string", enum: ["files", "content"] },
      maxResults: { ...INTEGER, minimum: 1, maximum: 100 },
      contextLines: { ...INTEGER, minimum: 0, maximum: 5 },
    },
    ["path", "pattern", "searchType"],
  ),
  search_results: objectSchema(
    {
      sessionId: STRING,
      offset: INTEGER,
      length: { ...INTEGER, minimum: 1, maximum: 100 },
    },
    ["sessionId"],
  ),
  search_stop: objectSchema({ sessionId: STRING }, ["sessionId"]),
  search_list: objectSchema(),
  process_list: objectSchema(),
  session_list: objectSchema(),
  project_test: objectSchema(),
  project_typecheck: objectSchema(),
  project_build: objectSchema(),
  git_status: objectSchema(),
  git_diff: objectSchema({ mode: { type: "string", enum: ["working", "staged"] } }),
  git_log: objectSchema({ maxCount: { ...INTEGER, minimum: 1, maximum: 20 } }),
  transaction_begin: objectSchema(),
  transaction_stage_create: objectSchema({ transactionId: STRING, path: STRING, content: STRING }, ["transactionId", "path", "content"]),
  transaction_stage_replace: objectSchema({ transactionId: STRING, path: STRING, expectedSha256: STRING, content: STRING }, ["transactionId", "path", "expectedSha256", "content"]),
  transaction_stage_move: objectSchema({ transactionId: STRING, sourcePath: STRING, destinationPath: STRING }, ["transactionId", "sourcePath", "destinationPath"]),
  transaction_validate: objectSchema({ transactionId: STRING }, ["transactionId"]),
  transaction_apply: objectSchema({ transactionId: STRING }, ["transactionId"]),
  transaction_rollback: objectSchema({ transactionId: STRING }, ["transactionId"]),
  transaction_status: objectSchema({ transactionId: STRING }, ["transactionId"]),
});

function publicTools(): Tool[] {
  return [...READ_TOOL_DEFINITIONS, ...EXECUTE_TOOL_DEFINITIONS, ...MUTATE_TOOL_DEFINITIONS].map(
    ({ name, capabilityClass }) => ({
      name,
      description: `HAIOS ${capabilityClass} wrapper: ${name}`,
      inputSchema: INPUT_SCHEMAS[name] ?? objectSchema(),
      annotations: {
        readOnlyHint: capabilityClass === "READ",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }),
  );
}

export async function createGatewayServer(
  config: GatewayServerConfig,
): Promise<GatewayRuntime> {
  const host = config.host ?? DEFAULT_HOST;
  const port = config.port ?? DEFAULT_PORT;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("M01_GATEWAY_NON_LOOPBACK_BIND_DENIED");
  }
  if (!config.apiKey) {
    throw new Error("M01_GATEWAY_API_KEY_REQUIRED");
  }

  const auditSink = config.auditSink ?? NOOP_AUDIT_SINK;
  const mutationUpstream = isMutationClient(config.upstream) ? config.upstream : undefined;
  const transactionService = config.transactionService ?? (mutationUpstream === undefined ? undefined : new TransactionService({
    currentness: createGitCurrentnessProvider(),
    adapter: new TransactionMutationAdapter(mutationUpstream),
    rollbackRoot: join(TRANSACTION_PROJECT_ROOT, "runtime"),
    verifier: async () => {
      const result = await dispatchExecuteTool("project_test", {}, { upstream: mutationUpstream });
      return result.decision === "ALLOW" && result.preStateDigest === result.postStateDigest;
    },
    verificationProfile: "project_test",
  }));
  const createMcpServerForRequest = () => {
    const mcp = new Server(
      { name: "haios-desktop-control-m01", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: publicTools(),
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const startedAt = Date.now();
      const requestId = randomUUID();
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const capabilityClass = classifyGatewayTool(name);
      let resultClass: "SUCCESS" | "DENIED" | "ERROR" | "TRUNCATED" = "ERROR";
      let decision: "ALLOW" | "DENY" = "DENY";

      try {
        const result =
          capabilityClass === "MUTATE"
            ? transactionService === undefined
              ? { decision: "DENY" as const, reason: "MUTATE_SERVICE_UNAVAILABLE" }
              : await dispatchTransactionTool(transactionService, name, args)
            : capabilityClass === "EXECUTE"
              ? isExecuteClient(config.upstream)
                ? await dispatchExecuteTool(name, args, { upstream: config.upstream })
                : { decision: "DENY" as const, reason: "EXECUTE_UPSTREAM_UNAVAILABLE" }
              : await dispatchReadTool(name, args, { upstream: config.upstream });
        decision = result.decision;
        resultClass =
          result.decision === "DENY"
            ? "DENIED"
            : "truncated" in result && result.truncated
              ? "TRUNCATED"
              : "SUCCESS";

        await auditSink.write({
          timestamp: new Date().toISOString(),
          requestId,
          tool: name,
          capabilityClass,
          decision,
          resultClass,
          durationMs: Date.now() - startedAt,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: result.decision === "DENY",
        };
      } catch {
        await auditSink.write({
          timestamp: new Date().toISOString(),
          requestId,
          tool: name,
          capabilityClass,
          decision: "DENY",
          resultClass: "ERROR",
          durationMs: Date.now() - startedAt,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "DENY",
                reason: "UPSTREAM_ERROR",
              }),
            },
          ],
          isError: true,
        };
      }
    });

    return mcp;
  };

  const httpServer: HttpServer = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/mcp") {
        res.statusCode = 404;
        res.end();
        return;
      }

      const auth = authenticateApiKey(req.headers, config.apiKey);
      if (auth.decision !== "ALLOW") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
        return;
      }

      const contentLength = Number(req.headers["content-length"] ?? 0);
      if (!Number.isFinite(contentLength) || contentLength > MAX_HTTP_BODY_BYTES) {
        res.statusCode = 413;
        res.end();
        return;
      }

      const mcp = createMcpServerForRequest();
      const transport = new StreamableHTTPServerTransport();
      await mcp.connect(transport);
      res.once("close", () => {
        void transport.close();
        void mcp.close();
      });
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "MCP_REQUEST_FAILED" }));
      }
    }
  });

  let listening = false;

  return {
    async listen(): Promise<GatewayAddress> {
      if (!listening) {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          httpServer.once("error", onError);
          httpServer.listen(port, host, () => {
            httpServer.off("error", onError);
            listening = true;
            resolve();
          });
        });
      }

      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("M01_GATEWAY_ADDRESS_UNAVAILABLE");
      }
      const urlHost = address.address.includes(":")
        ? `[${address.address}]`
        : address.address;
      return {
        host: address.address,
        port: address.port,
        url: `http://${urlHost}:${address.port}/mcp`,
      };
    },

    async close(): Promise<void> {
      if (listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        listening = false;
      }
      await config.upstream.close().catch(() => undefined);
    },
  };
}
