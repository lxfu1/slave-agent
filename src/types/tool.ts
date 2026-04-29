/**
 * Tool interface and supporting types.
 *
 * Every tool in memo-agent implements this interface and self-registers
 * into the tool registry at module load time. No tool has knowledge of
 * other tools or the conversation engine — zero coupling.
 */

import type Database from "better-sqlite3";
import type { MemoAgentConfig } from "./config.js";

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  /** Absolute path to the current working directory */
  cwd: string;
  /** Absolute path to the active profile directory */
  profileDir: string;
  /** Current session ID */
  sessionId: string;
  /** Permission mode for this execution context */
  permissionMode: "ask" | "auto";
  /** SQLite database handle — used by history/session tools */
  db: Database.Database;
  /** Full agent configuration — used by tools that depend on config (sandbox, search) */
  config: MemoAgentConfig;
  /** Optional abort signal for long-running operations */
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  /** Text content to return to the model */
  content: string;
  /** When true, the result is treated as an error by the model */
  isError?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  /** Maximum characters in the result (default: 100_000) */
  readonly maxResultChars: number;

  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;

  /** Read-only tools are always permitted without user confirmation */
  isReadOnly(): boolean;

  /** Allows tools to be conditionally disabled via config or missing env vars */
  isEnabled(): boolean;
}

/** Converts a Tool to the OpenAI function-calling schema format */
export function toolToOpenAIFunction(tool: Tool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
