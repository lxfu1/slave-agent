import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

const webSearchTool: Tool = {
  name: "WebSearch",
  description:
    "Search the web using Brave Search. Returns titles, URLs, and snippets for the query.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: { type: "number", description: "Number of results (default: 5, max: 10)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  maxResultChars: 8_000,

  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const searchCfg = ctx.config.search;
    if (!searchCfg?.apiKey) {
      return {
        content: "WebSearch not configured. Add search.provider and search.apiKey to config.yaml.",
        isError: true,
      };
    }

    const query = input["query"] as string;
    const count = Math.min(
      typeof input["count"] === "number" ? input["count"] : searchCfg.maxResults,
      10
    );
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "X-Subscription-Token": searchCfg.apiKey,
          "Accept": "application/json",
        },
        ...(ctx.abortSignal && { signal: ctx.abortSignal }),
      });
    } catch (err) {
      return {
        content: `WebSearch request failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if (!response.ok) {
      return {
        content: `Brave Search API error: ${response.status} ${response.statusText}`,
        isError: true,
      };
    }

    const data = await response.json() as BraveSearchResponse;
    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return { content: "No results found." };
    }

    const lines = results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ""}`
    );
    return { content: lines.join("\n\n") };
  },
};

registerTool(webSearchTool);
