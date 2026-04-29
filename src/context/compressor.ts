/**
 * Three-zone context compressor.
 *
 * Zones:
 *   HEAD  — system prompt anchor + first exchange. Never compressed.
 *   MIDDLE — older messages beyond the HEAD. Summarized via LLM.
 *   TAIL  — most recent ~tailTokens. Always preserved in full.
 *
 * The TAIL boundary is token-budget-based (not message-count), so it
 * adapts to message density automatically.
 *
 * The summary is injected as a "user" role message to avoid role-alternation
 * violations in strict OpenAI-compatible APIs.
 */

import type OpenAI from "openai";
import type { ChatMessage, TokenUsage } from "../types/messages.js";
import type { ContextConfig } from "../types/config.js";
import { streamChat } from "../model/streaming.js";
import { estimateTokenCount, estimateStringTokens } from "./tokenBudget.js";
import { makeError } from "../types/errors.js";

export interface CompressorDeps {
  primaryClient: OpenAI;
  primaryModel: string;
  auxiliaryClient: OpenAI | null;
  auxiliaryModel: string | null;
  config: ContextConfig;
}

export interface CompressionResult {
  messages: ChatMessage[];
  summary: string;
  usage: TokenUsage;
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarizer. Your job is to create a concise, accurate summary of a conversation segment.

Rules:
- Focus on: decisions made, key facts learned, files modified, problems encountered and their solutions, current task state
- Omit: pleasantries, repeated information, tool call details unless they produced important facts
- Output plain text, no headers, 100-300 words maximum
- Write in past tense`;

const SUMMARIZATION_USER_PREFIX = "Summarize the following conversation segment, retaining all technically important details:\n\n---\n\n";

/**
 * Compresses the MIDDLE zone of the message history.
 * Returns a new message array with the MIDDLE replaced by a summary message.
 */
export async function compressContext(
  messages: ChatMessage[],
  systemPrompt: string,
  focusHint: string | undefined,
  deps: CompressorDeps
): Promise<CompressionResult> {
  if (messages.length < 4) {
    // Not enough messages to compress meaningfully
    return {
      messages,
      summary: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  const { headEnd, tailStart } = computeZoneBoundaries(
    messages,
    systemPrompt,
    deps.config
  );

  if (tailStart <= headEnd) {
    // MIDDLE zone is empty — nothing to compress
    return {
      messages,
      summary: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  const headMessages = messages.slice(0, headEnd);
  const middleMessages = messages.slice(headEnd, tailStart);
  const tailMessages = messages.slice(tailStart);

  const summary = await summarizeMessages(middleMessages, focusHint, deps);

  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Previous conversation summary — ${new Date().toISOString().slice(0, 10)}]\n\n${summary.text}`,
  };

  const compressed: ChatMessage[] = [...headMessages, summaryMessage, ...tailMessages];

  return {
    messages: compressed,
    summary: summary.text,
    usage: summary.usage,
  };
}

// ---------------------------------------------------------------------------
// Zone boundary computation
// ---------------------------------------------------------------------------

interface ZoneBoundaries {
  /** Exclusive end index of the HEAD zone (messages 0..headEnd are protected) */
  headEnd: number;
  /** Inclusive start index of the TAIL zone */
  tailStart: number;
}

function computeZoneBoundaries(
  messages: ChatMessage[],
  systemPrompt: string,
  config: ContextConfig
): ZoneBoundaries {
  // HEAD: protect the entire first turn, including any tool call chains.
  // Walk forward until we've seen the first user message AND all subsequent
  // tool/assistant exchanges that belong to that turn (i.e. stop when we hit
  // a second user message or run out of messages).
  let headEnd = 0;
  let seenFirstUser = false;
  for (let i = 0; i < messages.length; i++) {
    headEnd = i + 1;
    if (messages[i]?.role === "user") {
      if (seenFirstUser) {
        // This is the second user message — HEAD ends just before it.
        headEnd = i;
        break;
      }
      seenFirstUser = true;
    }
  }

  // TAIL: walk backwards until we've accumulated tailTokens worth of messages.
  // Use Math.max(0, ...) so a large system prompt doesn't produce a negative budget.
  const systemTokens = estimateStringTokens(systemPrompt);
  const budgetForTail = Math.max(0, config.tailTokens - systemTokens);

  // Always preserve at least the last 2 messages in the tail to avoid compressing
  // the most recent exchange when the system prompt is very large.
  const MIN_TAIL_MESSAGES = 2;

  let tailTokens = 0;
  let tailStart = messages.length;

  for (let i = messages.length - 1; i >= headEnd; i--) {
    const msgTokens = estimateTokenCount([messages[i] as ChatMessage], "");
    if (tailTokens + msgTokens > budgetForTail && messages.length - i > MIN_TAIL_MESSAGES) {
      tailStart = i + 1;
      break;
    }
    tailTokens += msgTokens;
    tailStart = i;
  }

  // Snap tailStart forward to the nearest user message so that the summary
  // (injected as a user message) maintains valid role-alternation with the
  // TAIL. If tailStart lands mid-tool-loop (e.g. on a tool result message),
  // the API would reject the sequence: user(summary) → tool → ...
  let snapped = tailStart;
  while (snapped < messages.length && (messages[snapped] as ChatMessage).role !== "user") {
    snapped++;
  }
  // If no user message found beyond tailStart, fall back to the original
  // boundary (the MIDDLE will be slightly larger but the sequence stays valid).
  const resolvedTailStart = snapped < messages.length ? snapped : tailStart;

  return { headEnd, tailStart: Math.max(headEnd, resolvedTailStart) };
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

interface SummaryResult {
  text: string;
  usage: TokenUsage;
}

async function summarizeMessages(
  messages: ChatMessage[],
  focusHint: string | undefined,
  deps: CompressorDeps
): Promise<SummaryResult> {
  const client = deps.auxiliaryClient ?? deps.primaryClient;
  const model = deps.auxiliaryModel ?? deps.primaryModel;

  // Build a text representation of the messages to summarize
  const messageText = messages
    .map(m => {
      if (m.role === "tool") return `[tool result]: ${m.content ?? ""}`;
      if (m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls.map(tc => `${tc.function.name}(...)`).join(", ");
        return `[assistant called]: ${calls}`;
      }
      return `[${m.role}]: ${m.content ?? ""}`;
    })
    .join("\n");

  const focusLine = focusHint ? `\nFocus especially on: ${focusHint}\n` : "";
  const userContent = `${SUMMARIZATION_USER_PREFIX}${messageText}${focusLine}\n---`;

  const summaryMessages: ChatMessage[] = [
    { role: "user", content: userContent },
  ];

  let summaryText = "";
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const event of streamChat(client, {
    model,
    messages: summaryMessages,
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    maxTokens: 1_024, // Summaries are short by design; cap to avoid cost blowout
  })) {
    if (event.type === "text_delta") {
      summaryText += event.delta;
    } else if (event.type === "message_done") {
      usage.promptTokens = event.usage.promptTokens;
      usage.completionTokens = event.usage.completionTokens;
      usage.totalTokens = event.usage.totalTokens;
    } else if (event.type === "error") {
      throw makeError(
        "COMPRESSION_FAILED",
        `Summarization failed: ${event.error.message}`,
        event.error
      );
    }
  }

  return { text: summaryText.trim(), usage };
}
