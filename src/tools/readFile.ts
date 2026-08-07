import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";
import { resolveSafePath } from "./pathUtils.js";

const MAX_RESULT_CHARS = 100_000;

const readFileTool: Tool = {
  name: "ReadFile",
  description:
    "Reads the contents of a file. Provide an absolute path or a path relative to the working directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed, optional)" },
      limit: { type: "number", description: "Maximum number of lines to read (optional)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  maxResultChars: MAX_RESULT_CHARS,

  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPath = input["path"] as string;
    const filePath = await resolveSafePath(inputPath, ctx.cwd, [ctx.cwd, ctx.profileDir]);
    const offset = typeof input["offset"] === "number" ? input["offset"] : 1;
    const limit = typeof input["limit"] === "number" ? input["limit"] : undefined;

    if (!filePath) {
      return {
        content: `Security error: path "${inputPath}" is outside the working directory`,
        isError: true,
      };
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return {
        content: `Error reading file: ${formatError(err)}`,
        isError: true,
      };
    }

    const lines = raw.split("\n");
    const startLine = Math.max(0, offset - 1);
    const sliced = limit !== undefined ? lines.slice(startLine, startLine + limit) : lines.slice(startLine);

    // Prefix lines with line numbers (cat -n style)
    const numbered = sliced
      .map((line, i) => `${String(startLine + i + 1).padStart(4)}\t${line}`)
      .join("\n");

    const truncated = numbered.length > MAX_RESULT_CHARS
      ? numbered.slice(0, MAX_RESULT_CHARS) + "\n...(truncated)"
      : numbered;

    return { content: truncated };
  },
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

registerTool(readFileTool);
