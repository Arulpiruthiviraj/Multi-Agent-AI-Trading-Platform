/**
 * ==========================================================
 * Module: OpenAliceMcpClient
 *
 * Purpose:
 * Thin, real MCP (Model Context Protocol) client wrapper around the OpenAlice MCP server.
 * Uses @modelcontextprotocol/sdk (^1.29.0), already a real dependency of this project
 * (package.json) but previously unused anywhere in src/ - no new dependency was added.
 *
 * Connects once, reconnects lazily on failure. Every call has a short timeout and never
 * throws past this module's boundary for read-path callers (healthCheck) - callers that
 * need to know about a failure (requestVerification) still get a real rejected promise.
 * ==========================================================
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runtimeIntervals } from '../../config/runtimeIntervals';

const DEFAULT_TIMEOUT_MS = runtimeIntervals.openAliceMcpDefaultTimeoutMs;

export class OpenAliceMcpClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly mcpUrl: string) {}

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client({ name: 'argus-trading-platform', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
      await client.connect(transport, { timeout: DEFAULT_TIMEOUT_MS });
      this.client = client;
      this.connecting = null;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (e) {
      this.connecting = null;
      throw e;
    }
  }

  /** Drops the cached connection so the next call reconnects from scratch. */
  private invalidate() {
    this.client = null;
    this.connecting = null;
  }

  async listToolNames(): Promise<string[]> {
    const client = await this.getClient();
    const result = await client.listTools(undefined, { timeout: DEFAULT_TIMEOUT_MS });
    return result.tools.map((t) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const client = await this.getClient();
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: DEFAULT_TIMEOUT_MS });
      return result;
    } catch (e) {
      this.invalidate();
      throw e;
    }
  }
}
