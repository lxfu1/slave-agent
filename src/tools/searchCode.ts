/**
 * SearchCode — content search tool.
 * Prefers ripgrep (rg) when available; falls back to grep -r.
 * Uses execFile (not exec) to avoid shell injection risks.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";
import { resolveSafePath } from "./pathUtils.js";

const execFileAsync = promisify(execFile);
const MAX_RESULT_CHARS = 50_000;

const searchCodeTool: Tool = {
  name: "SearchCode",
  description:
    "Searches file contents using a regex pattern. Returns matching lines with file paths and line numbers. " +
    "Uses ripgrep when available, falls back to grep.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: {
        type: "string",
        description: "Directory or file to search in (defaults to working directory)",
      },
      file_glob: {
        type: "string",
        description: 'File pattern filter, e.g. "*.ts"',
      },
      case_insensitive: { type: "boolean", description: "Case-insensitive matching" },
      max_results: { type: "number", description: "Maximum number of results (default: 100)" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  maxResultChars: MAX_RESULT_CHARS,

  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input["pattern"] as string;
    const requestedPath = input["path"]
      ? path.resolve(ctx.cwd, input["path"] as string)
      : ctx.cwd;
    const searchPath = await resolveSafePath(requestedPath, ctx.cwd, [ctx.cwd]);
    const fileGlob = input["file_glob"] as string | undefined;
    const caseInsensitive = input["case_insensitive"] === true;
    const maxResults = Math.max(
      1,
      Math.min(typeof input["max_results"] === "number" ? Math.floor(input["max_results"]) : 100, 1_000),
    );

    if (!searchPath) {
      return { content: "Security error: search path is outside the working directory", isError: true };
    }

    try {
      const output = await runRipgrep(pattern, searchPath, fileGlob, caseInsensitive, maxResults);
      if (!output.trim()) return { content: "No matches found." };
      const truncated = output.length > MAX_RESULT_CHARS
        ? output.slice(0, MAX_RESULT_CHARS) + "\n...(truncated)"
        : output;
      return { content: truncated };
    } catch (err) {
      if (isNoMatchError(err)) return { content: "No matches found." };
      // ripgrep not found — fall back to grep
      try {
        const output = await runGrep(pattern, searchPath, fileGlob, caseInsensitive, maxResults);
        if (!output.trim()) return { content: "No matches found." };
        const truncated = output.length > MAX_RESULT_CHARS
          ? output.slice(0, MAX_RESULT_CHARS) + "\n...(truncated)"
          : output;
        return { content: truncated };
      } catch (grepErr) {
        if (isNoMatchError(grepErr)) return { content: "No matches found." };
        return {
          content: `Search failed: ${grepErr instanceof Error ? grepErr.message : String(grepErr)}`,
          isError: true,
        };
      }
    }
  },
};

function isNoMatchError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: number }).code === 1;
}

async function runRipgrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  caseInsensitive: boolean,
  maxResults: number
): Promise<string> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
  ];
  if (caseInsensitive) args.push("--ignore-case");
  if (fileGlob) args.push("--glob", fileGlob);
  args.push(pattern, searchPath);

  // rg --max-count limits per-file; pipe through head for a true global cap.
  const { stdout } = await execFileAsync("rg", args, { timeout: 15_000 });
  // Slice to maxResults lines after the fact — avoids depending on rg version
  const lines = stdout.split("\n");
  return lines.slice(0, maxResults).join("\n");
}

async function runGrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  caseInsensitive: boolean,
  maxResults: number
): Promise<string> {
  // grep -m limits per-file just like rg --max-count; post-process for global cap.
  const args = ["-r", "-n"];
  if (caseInsensitive) args.push("-i");
  if (fileGlob) args.push("--include", fileGlob);
  args.push(pattern, searchPath);

  const { stdout } = await execFileAsync("grep", args, { timeout: 15_000 });
  const lines = stdout.split("\n");
  return lines.slice(0, maxResults).join("\n");
}

registerTool(searchCodeTool);
