import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type UpstreamResult = unknown;

export interface DesktopCommanderReadClient {
  listDirectory(args: { path: string; depth: number }): Promise<UpstreamResult>;
  readFile(args: { path: string; offset?: number; length?: number }): Promise<UpstreamResult>;
  readMultipleFiles(args: { paths: string[] }): Promise<UpstreamResult>;
  getFileInfo(args: { path: string }): Promise<UpstreamResult>;
  startSearch(args: Record<string, unknown>): Promise<UpstreamResult>;
  getMoreSearchResults(args: { sessionId: string; offset?: number; length?: number }): Promise<UpstreamResult>;
  stopSearch(args: { sessionId: string }): Promise<UpstreamResult>;
  listSearches(): Promise<UpstreamResult>;
  listProcesses(): Promise<UpstreamResult>;
  listSessions(): Promise<UpstreamResult>;
  getConfig(): Promise<UpstreamResult>;
  close(): Promise<void>;
}

export const DESKTOP_COMMANDER_VERSION = "0.2.47" as const;

export class DesktopCommanderClient implements DesktopCommanderReadClient {
  readonly #client: Client;
  readonly #transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.#client = client;
    this.#transport = transport;
  }

  static async connect(): Promise<DesktopCommanderClient> {
    const client = new Client({
      name: "haios-desktop-control",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `npx -y @wonderwhy-er/desktop-commander@${DESKTOP_COMMANDER_VERSION}`,
      ],
      stderr: "pipe",
    });
    await client.connect(transport);
    return new DesktopCommanderClient(client, transport);
  }

  async #call(name: string, args: Record<string, unknown> = {}): Promise<UpstreamResult> {
    return this.#client.callTool({ name, arguments: args });
  }

  listDirectory(args: { path: string; depth: number }) {
    return this.#call("list_directory", args);
  }

  readFile(args: { path: string; offset?: number; length?: number }) {
    return this.#call("read_file", args);
  }

  readMultipleFiles(args: { paths: string[] }) {
    return this.#call("read_multiple_files", args);
  }

  getFileInfo(args: { path: string }) {
    return this.#call("get_file_info", args);
  }

  startSearch(args: Record<string, unknown>) {
    return this.#call("start_search", args);
  }

  getMoreSearchResults(args: { sessionId: string; offset?: number; length?: number }) {
    return this.#call("get_more_search_results", args);
  }

  stopSearch(args: { sessionId: string }) {
    return this.#call("stop_search", args);
  }

  listSearches() {
    return this.#call("list_searches");
  }

  listProcesses() {
    return this.#call("list_processes");
  }

  listSessions() {
    return this.#call("list_sessions");
  }

  getConfig() {
    return this.#call("get_config");
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }
}
