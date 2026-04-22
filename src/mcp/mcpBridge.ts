/**
 * MCP (Model Context Protocol) bridge.
 *
 * Connects to configured MCP servers in parallel (non-blocking at startup).
 * Each server's tools are wrapped as standard Tool instances and registered
 * into the shared tool registry under namespaced names: mcp__<server>__<tool>.
 *
 * A slow or failed server never blocks the agent from starting.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import type { McpServerConfig } from "../types/config.js";
import type { Tool, ToolContext, ToolInputSchema, ToolResult } from "../types/tool.js";
import { registerTool } from "../tools/registry.js";

const _require = createRequire(import.meta.url);
const AGENT_VERSION: string = (_require("../../package.json") as { version: string }).version;

const MCP_CONNECT_TIMEOUT_MS = 30_000;

export type McpConnectionStatus =
  | { type: "pending"; startedAt: number }
  | { type: "connected"; toolCount: number }
  | { type: "failed"; error: string }
  | { type: "disabled" };

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  status: McpConnectionStatus;
}

// Tracks active stdio transports for cleanup on exit
const activeClients = new Map<string, Client>();

/**
 * Bootstraps all configured MCP servers.
 * Each server connects independently; failures are recorded but don't throw.
 * Returns entries with their final connection status.
 */
export async function bootstrapMcp(
  configs: Record<string, McpServerConfig>
): Promise<McpServerEntry[]> {
  const entries = Object.entries(configs);
  if (entries.length === 0) return [];

  const results = await Promise.allSettled(
    entries.map(([name, config]) => connectServer(name, config))
  );

  return results.map((result, i): McpServerEntry => {
    const [name, config] = entries[i]!;
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      name,
      config,
      status: { type: "failed", error: String(result.reason) },
    };
  });
}

async function connectServer(name: string, config: McpServerConfig): Promise<McpServerEntry> {
  if (config.type !== "stdio") {
    // HTTP/SSE transport support can be added later
    return {
      name,
      config,
      status: { type: "disabled" },
    };
  }

  if (!config.command) {
    return {
      name,
      config,
      status: { type: "failed", error: "Missing 'command' for stdio transport" },
    };
  }

  const client = new Client(
    { name: "memo-agent", version: AGENT_VERSION },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    ...(config.env && { env: { ...process.env, ...config.env } as Record<string, string> }),
  });

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Connection timeout after ${MCP_CONNECT_TIMEOUT_MS}ms`)), MCP_CONNECT_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    return {
      name,
      config,
      status: { type: "failed", error: err instanceof Error ? err.message : String(err) },
    };
  }

  activeClients.set(name, client);

  // Discover and register all tools from this server
  let toolCount = 0;
  try {
    const toolsResult = await client.listTools();
    for (const mcpTool of toolsResult.tools) {
      const wrappedTool = wrapMcpTool(mcpTool, name, client);
      try {
        registerTool(wrappedTool);
        toolCount++;
      } catch {
        // Tool already registered (duplicate name) — skip
      }
    }
  } catch (err) {
    process.stderr.write(`[memo-agent] Failed to list tools from MCP server "${name}": ${String(err)}\n`);
  }

  return {
    name,
    config,
    status: { type: "connected", toolCount },
  };
}

interface McpToolDescriptor {
  name: string;
  // Allow explicit undefined from the MCP SDK's optional typing
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  /** MCP 2025-03-26 spec: annotations.readOnlyHint signals a side-effect-free tool */
  annotations?: { readOnlyHint?: boolean | undefined; [key: string]: unknown } | undefined;
}

function wrapMcpTool(
  mcpTool: McpToolDescriptor,
  serverName: string,
  client: Client
): Tool {
  const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;
  const readOnly = mcpTool.annotations?.readOnlyHint === true;

  return {
    name: qualifiedName,
    description: mcpTool.description ?? `MCP tool from ${serverName}`,
    inputSchema: (mcpTool.inputSchema as ToolInputSchema | undefined) ?? {
      type: "object",
      properties: {},
    },
    maxResultChars: 50_000,

    isReadOnly(): boolean { return readOnly; },
    isEnabled(): boolean { return true; },

    async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      try {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input,
        });

        const rawContent = result.content as unknown[];
        const content = rawContent
          .map((block: unknown) => {
            if (typeof block === "object" && block !== null && "type" in block) {
              const b = block as Record<string, unknown>;
              if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
            }
            return JSON.stringify(block);
          })
          .join("\n");

        return {
          content: content || "(empty result)",
          isError: result.isError === true,
        };
      } catch (err) {
        return {
          content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/** Closes all active MCP client connections. Call on process exit. */
export async function shutdownMcp(): Promise<void> {
  await Promise.allSettled(
    Array.from(activeClients.values()).map(client => client.close())
  );
  activeClients.clear();
}
