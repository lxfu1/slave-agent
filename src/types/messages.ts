/**
 * OpenAI-compatible message and streaming types.
 * All API communication uses these types; no Anthropic-specific formats.
 */

import type { MemoAgentError } from "./errors.js";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  /** Present when role === "tool" */
  tool_call_id?: string;
  name?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Discriminated union of all events emitted by the streaming layer.
 * Callers iterate with `for await` and switch on `event.type`.
 */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_done"; id: string; name: string; arguments: string }
  | { type: "message_done"; stopReason: string; usage: TokenUsage }
  | { type: "error"; error: MemoAgentError };

/** Accumulated state after a complete model response */
export interface StreamResult {
  message: ChatMessage;
  usage: TokenUsage;
  stopReason: string;
}
