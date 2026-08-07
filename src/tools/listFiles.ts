import { glob } from "glob";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";
import { resolveSafePath } from "./pathUtils.js";

const listFilesTool: Tool = {
  name: "ListFiles",
  description:
    "Lists files matching a glob pattern in alphabetical order. " +
    "Excludes node_modules and .git by default.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.{ts,tsx}"',
      },
      cwd: {
        type: "string",
        description: "Search directory (defaults to working directory)",
      },
      ignore_gitignore: {
        type: "boolean",
        description: "Set to true to include files ignored by .gitignore",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  maxResultChars: 50_000,

  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input["pattern"] as string;
    const requestedDir = input["cwd"] ? path.resolve(ctx.cwd, input["cwd"] as string) : ctx.cwd;
    const searchDir = await resolveSafePath(requestedDir, ctx.cwd, [ctx.cwd]);
    const ignoreGitignore = input["ignore_gitignore"] === true;

    if (!searchDir) {
      return { content: "Security error: search directory is outside the working directory", isError: true };
    }

    try {
      const files = await glob(pattern, {
        cwd: searchDir,
        ignore: ignoreGitignore ? [] : ["**/node_modules/**", "**/.git/**"],
        dot: false,
        withFileTypes: false,
      });

      if (files.length === 0) {
        return { content: "No files matched the pattern." };
      }

      const sorted = files.sort();
      const output = sorted.join("\n");
      const truncated = output.length > 50_000
        ? output.slice(0, 50_000) + "\n...(truncated)"
        : output;

      return { content: `${files.length} files:\n${truncated}` };
    } catch (err) {
      return {
        content: `Error listing files: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

registerTool(listFilesTool);
