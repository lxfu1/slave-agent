/**
 * EditFile tool — exact string replacement in a file.
 *
 * Uses indexOf (not regex) to avoid special-character issues in the search
 * string. Returns an error if old_string is not found, preventing silent no-ops.
 * Set replace_all: true to replace every occurrence instead of just the first.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";
import { resolveSafePath } from "./pathUtils.js";

const editFileTool: Tool = {
  name: "EditFile",
  description:
    "Replaces occurrences of old_string with new_string in a file. " +
    "Replaces the first occurrence by default; set replace_all to true to replace all. " +
    "Returns an error if old_string is not found. Use ReadFile first to verify the exact text.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Exact string to find and replace" },
      new_string: { type: "string", description: "Replacement string" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences instead of just the first (default: false)",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  maxResultChars: 500,

  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPath = input["path"] as string;
    const oldString = input["old_string"] as string;
    const newString = input["new_string"] as string;
    const replaceAll = input["replace_all"] === true;
    const filePath = await resolveSafePath(inputPath, ctx.cwd, [ctx.cwd, ctx.profileDir]);

    if (!filePath) {
      return {
        content: `Security error: path "${inputPath}" is outside the working directory`,
        isError: true,
      };
    }

    if (oldString.length === 0) {
      return { content: "old_string must not be empty", isError: true };
    }

    let original: string;
    try {
      original = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return {
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const index = original.indexOf(oldString);
    if (index === -1) {
      return {
        content: `old_string not found in ${filePath}. Use ReadFile to verify the exact content before editing.`,
        isError: true,
      };
    }

    let updated: string;
    let count: number;

    if (replaceAll) {
      // Split on literal string and rejoin — no regex escaping needed
      const parts = original.split(oldString);
      count = parts.length - 1;
      updated = parts.join(newString);
    } else {
      updated = original.slice(0, index) + newString + original.slice(index + oldString.length);
      count = 1;
    }

    try {
      await fs.writeFile(filePath, updated, "utf-8");
      return { content: `Replaced ${count} occurrence(s) in ${path.relative(ctx.cwd, filePath)}` };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

registerTool(editFileTool);
