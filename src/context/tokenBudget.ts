/**
 * Token budget tracking.
 *
 * Uses gpt-tokenizer (BPE, cl100k_base) for accurate per-string token counts.
 * cl100k_base is the encoding for GPT-3.5-turbo, GPT-4, GPT-4o, o1, o3-mini.
 * For other model families (Claude, Mistral, …) the same BPE gives a much
 * better approximation than the previous 4 chars/token heuristic.
 *
 * Message overhead follows the OpenAI chat-completion wire format:
 *   3 tokens  — per message (<|im_start|>role\n … <|im_end|>)
 *   3 tokens  — assistant-priming suffix added at the end of each request
 *   8 tokens  — per tool_call block (type, id, function wrapper)
 */

import { encode } from "gpt-tokenizer";
import type { ChatMessage, TokenUsage } from "../types/messages.js";
import type { ContextConfig } from "../types/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Overhead tokens per message in the OpenAI chat-completion format */
const MESSAGE_OVERHEAD_TOKENS = 3;
/** Tokens added at the end of every request to prime the assistant reply */
const ASSISTANT_PRIMING_TOKENS = 3;
/** Overhead tokens for each tool_call block (type + id + function wrapper) */
const TOOL_CALL_OVERHEAD_TOKENS = 8;

/** Fallback chars-per-token when the tokenizer throws (should not happen) */
const FALLBACK_CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Context window registry
// ---------------------------------------------------------------------------

/**
 * Known model context window sizes (tokens).
 * Models not in this table default to 128 k.
 */
const CONTEXT_WINDOW_SIZES: Record<string, number> = {
  "gpt-4o":              128_000,
  "gpt-4o-mini":         128_000,
  "gpt-4-turbo":         128_000,
  "gpt-4":                 8_192,
  "gpt-3.5-turbo":        16_385,
  "o1":                  200_000,
  "o1-mini":             128_000,
  "o3":                  200_000,
  "o3-mini":             200_000,
  "claude-3-5-sonnet":   200_000,
  "claude-3-opus":       200_000,
  "claude-3-haiku":      200_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

export function getContextWindowSize(modelName: string): number {
  if (CONTEXT_WINDOW_SIZES[modelName]) return CONTEXT_WINDOW_SIZES[modelName]!;
  // Prefix match for versioned names (e.g. "gpt-4o-2024-11-20")
  for (const [key, size] of Object.entries(CONTEXT_WINDOW_SIZES)) {
    if (modelName.startsWith(key)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// String tokenisation
// ---------------------------------------------------------------------------

/**
 * Returns the exact BPE token count for `text` using cl100k_base.
 *
 * The legacy `isJson` hint is kept for backwards compatibility but ignored —
 * the BPE tokenizer handles all text accurately without a content-type hint.
 */
export function estimateStringTokens(text: string, _isJson = false): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Shouldn't happen for well-formed UTF-8, but guard anyway.
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  }
}

// ---------------------------------------------------------------------------
// Full conversation token count
// ---------------------------------------------------------------------------

/**
 * Counts the tokens for the full conversation context that would be sent to
 * the model, mirroring the OpenAI chat-completion wire format:
 *
 *   system prompt (MESSAGE_OVERHEAD + content tokens)
 *   + each message (MESSAGE_OVERHEAD + content + tool_call tokens)
 *   + ASSISTANT_PRIMING_TOKENS
 */
export function estimateTokenCount(
  messages: ChatMessage[],
  systemPrompt: string,
): number {
  // Start with the assistant-priming suffix that OpenAI always adds.
  let total = ASSISTANT_PRIMING_TOKENS;

  if (systemPrompt) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateStringTokens(systemPrompt);
  }

  for (const msg of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;

    if (msg.content) {
      total += estimateStringTokens(msg.content);
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += TOOL_CALL_OVERHEAD_TOKENS;
        total += estimateStringTokens(tc.function.name);
        // Arguments are dense JSON — tokeniser handles it accurately.
        total += estimateStringTokens(tc.function.arguments);
      }
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Budget snapshot
// ---------------------------------------------------------------------------

export interface TokenBudgetSnapshot {
  estimatedTotal: number;
  contextWindowSize: number;
  /** 0–1 ratio of estimated usage to context window */
  usageRatio: number;
  warnThreshold: number;
  compressThreshold: number;
  isAboveWarn: boolean;
  isAboveCompress: boolean;
}

export function computeBudgetSnapshot(
  messages: ChatMessage[],
  systemPrompt: string,
  config: ContextConfig,
  modelName: string,
): TokenBudgetSnapshot {
  const contextWindowSize = getContextWindowSize(modelName);
  const estimatedTotal = estimateTokenCount(messages, systemPrompt);
  const usageRatio = estimatedTotal / contextWindowSize;

  return {
    estimatedTotal,
    contextWindowSize,
    usageRatio,
    warnThreshold: config.warnThreshold,
    compressThreshold: config.compressThreshold,
    isAboveWarn: usageRatio >= config.warnThreshold,
    isAboveCompress: usageRatio >= config.compressThreshold,
  };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** Estimates the USD cost for a completed model turn. */
export function estimateCostUsd(usage: TokenUsage, modelName: string): number {
  // Prices in USD per 1 M tokens (input / output), as of mid-2025.
  const costs: Record<string, { input: number; output: number }> = {
    "gpt-4o":          { input: 2.5,  output: 10  },
    "gpt-4o-mini":     { input: 0.15, output: 0.6 },
    "gpt-4-turbo":     { input: 10,   output: 30  },
    "gpt-3.5-turbo":   { input: 0.5,  output: 1.5 },
    "o1":              { input: 15,   output: 60  },
    "o3-mini":         { input: 1.1,  output: 4.4 },
  };

  // Sort by key length descending so "gpt-4o-mini" is tested before "gpt-4o".
  const costKey = Object.keys(costs)
    .sort((a, b) => b.length - a.length)
    .find(k => modelName.startsWith(k));
  const rate = costKey ? costs[costKey]! : { input: 2.5, output: 10 };

  return (usage.promptTokens * rate.input + usage.completionTokens * rate.output) / 1_000_000;
}
