import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";
import { isPathSafe } from "./pathUtils.js";

const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MB

const writeFileTool: Tool = {
  name: "WriteFile",
  description:
    "Creates or overwrites a file with the given content. Parent directories are created automatically. " +
    "Path must be within the current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path (must be within working directory)" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  maxResultChars: 500,

  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPath = input["path"] as string;
    const content = input["content"] as string;
    const filePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(ctx.cwd, inputPath);

    if (!isPathSafe(filePath, ctx.cwd, ctx.profileDir)) {
      return {
        content: `Security error: path "${inputPath}" is outside the working directory`,
        isError: true,
      };
    }

    const byteSize = Buffer.byteLength(content, "utf-8");
    if (byteSize > MAX_CONTENT_BYTES) {
      return {
        content: `Error: content too large (${(byteSize / 1024 / 1024).toFixed(1)} MB). Maximum allowed is 10 MB.`,
        isError: true,
      };
    }

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      return { content: `Written ${content.length} characters to ${path.relative(ctx.cwd, filePath)}` };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

registerTool(writeFileTool);
