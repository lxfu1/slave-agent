/**
 * ListSessions tool — lists recent sessions with their titles, dates, and token counts.
 *
 * Lets the model inspect what sessions exist so it can help the user resume
 * or reference prior work without needing the user to run /history manually.
 */

import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { listSessions } from "../session/db.js";
import { registerTool } from "./registry.js";

const listSessionsTool: Tool = {
  name: "ListSessions",
  description:
    "Lists recent conversation sessions with their titles, dates, and token usage. " +
    "Use this to help the user find and resume a previous session.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of sessions to list (default: 10, max: 50)",
      },
    },
    additionalProperties: false,
  },
  maxResultChars: 5_000,

  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const limit = typeof input["limit"] === "number" ? Math.max(1, Math.min(Math.floor(input["limit"]), 50)) : 10;
    const sessions = listSessions(ctx.db, limit);

    if (sessions.length === 0) {
      return { content: "No sessions found." };
    }

    const lines = sessions.map((s, i) => {
      const date = s.updatedAt.slice(0, 16).replace("T", " ");
      const title = (s.title || "(untitled)").slice(0, 60);
      const tokens = s.inputTokens + s.outputTokens;
      const chain = s.parentSessionId ? ` ↑${s.parentSessionId.slice(0, 8)}` : "";
      return `${String(i + 1).padStart(2)}. [${s.id.slice(0, 8)}] ${date}  ${title}  (${tokens} tokens)${chain}`;
    });

    return { content: `${sessions.length} recent session(s):\n\n${lines.join("\n")}` };
  },
};

registerTool(listSessionsTool);
