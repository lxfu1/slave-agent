/**
 * SearchHistory tool — full-text search across all stored message history.
 *
 * Wraps the FTS5-backed searchMessages DB function so the model can
 * proactively look up what was discussed in previous sessions.
 */

import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { searchMessages } from "../session/db.js";
import { registerTool } from "./registry.js";

const searchHistoryTool: Tool = {
  name: "SearchHistory",
  description:
    "Full-text searches across all past session messages. " +
    "Use this to recall what was discussed, decided, or implemented in previous sessions.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (phrase or keywords)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 15)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  maxResultChars: 10_000,

  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = (input["query"] as string).trim();
    if (!query) {
      return { content: "query must not be empty", isError: true };
    }

    const limit = typeof input["limit"] === "number" ? Math.max(1, Math.min(Math.floor(input["limit"]), 50)) : 15;
    const results = searchMessages(ctx.db, query, limit);

    if (results.length === 0) {
      return { content: `No history matches for: ${query}` };
    }

    const lines = results.map(r => {
      const date = r.createdAt.slice(0, 10);
      const session = r.sessionTitle ? `[${r.sessionTitle.slice(0, 30)}]` : `[${r.sessionId.slice(0, 8)}]`;
      const preview = (r.content ?? "").slice(0, 200).replace(/\n/g, " ");
      return `${date} ${session} ${r.role}: ${preview}`;
    });

    return { content: `${results.length} result(s):\n\n${lines.join("\n")}` };
  },
};

registerTool(searchHistoryTool);
