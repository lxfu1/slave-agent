/**
 * Streaming model communication layer.
 *
 * Converts OpenAI's streaming response into a typed async generator of
 * StreamEvents. The most critical detail: tool call arguments arrive as
 * fragmented JSON deltas. We accumulate them per call-id in a buffer Map
 * and emit tool_call_done only when the stream signals completion.
 *
 * Errors are yielded as { type: "error" } events rather than thrown,
 * so callers can render them without try-catch in their iteration loops.
 */

import type OpenAI from "openai";
import type { ChatMessage, StreamEvent, TokenUsage } from "../types/messages.js";
import { makeError } from "../types/errors.js";

export interface StreamRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: Record<string, unknown>[];
  systemPrompt?: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

interface ToolCallBuffer {
  name: string;
  argsBuffer: string;
}

/**
 * Streams a chat completion and yields typed StreamEvents.
 * The caller is responsible for assembling the final ChatMessage from events.
 */
export async function* streamChat(
  client: OpenAI,
  opts: StreamRequestOptions
): AsyncGenerator<StreamEvent, void, unknown> {
  const messages = buildMessages(opts.systemPrompt, opts.messages);
  const toolCallBuffers = new Map<string, ToolCallBuffer>();
  // Maps tool call index → id. OpenAI streaming omits the id on all chunks
  // except the first. A Map is used instead of a sparse array so that an
  // arbitrarily large index value doesn't allocate a huge array.
  const toolCallOrder = new Map<number, string>();

  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

  try {
    stream = await client.chat.completions.create(
      {
        model: opts.model,
        messages,
        ...(opts.tools !== undefined && { tools: opts.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[] }),
        stream: true,
        // OpenAI API uses null (not undefined) to indicate "no limit"
        max_tokens: opts.maxTokens ?? null,
      },
      { ...(opts.abortSignal && { signal: opts.abortSignal }) }
    );
  } catch (err) {
    yield {
      type: "error",
      error: makeError("API_ERROR", formatApiError(err), err),
    };
    return;
  }

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Text content delta
      if (delta.content) {
        yield { type: "text_delta", delta: delta.content };
      }

      // Tool call deltas — accumulate using tc.index for reliable fragment attribution.
      // The OpenAI streaming protocol identifies chunks by their index in the tool_calls
      // array, not by repeating the `id` field. Using index avoids misattribution when
      // multiple tool calls are streamed in parallel.
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;

          if (tc.id && !toolCallBuffers.has(tc.id)) {
            // First chunk for this tool call — initialize the buffer
            const name = tc.function?.name ?? "";
            toolCallBuffers.set(tc.id, { name, argsBuffer: "" });
            // Map index → id for subsequent chunks that omit the id
            toolCallOrder.set(idx, tc.id);
            yield { type: "tool_call_start", id: tc.id, name };
          }

          // Resolve the active ID from tc.id (first chunk) or the index map
          const activeId = tc.id ?? toolCallOrder.get(idx);
          if (activeId) {
            const argsDelta = tc.function?.arguments ?? "";
            if (argsDelta) {
              const buf = toolCallBuffers.get(activeId);
              if (buf) {
                buf.argsBuffer += argsDelta;
                yield { type: "tool_call_delta", id: activeId, argumentsDelta: argsDelta };
              }
            }
          }
        }
      }

      // Finish reason signals end of this choice
      const finishReason = choice.finish_reason;
      if (finishReason === "tool_calls" || finishReason === "stop" || finishReason === "length") {
        // Emit tool_call_done for all accumulated calls in index order
        for (const callId of [...toolCallOrder.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, id]) => id)) {
          const buf = toolCallBuffers.get(callId);
          if (buf) {
            yield {
              type: "tool_call_done",
              id: callId,
              name: buf.name,
              arguments: buf.argsBuffer,
            };
          }
        }

        const usage = chunk.usage;
        const tokenUsage: TokenUsage = {
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
        };

        yield {
          type: "message_done",
          stopReason: finishReason,
          usage: tokenUsage,
        };
        return;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      // Interrupted by user — yield a clean done event with zero usage
      yield {
        type: "message_done",
        stopReason: "aborted",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
      return;
    }
    yield {
      type: "error",
      error: makeError("API_ERROR", formatApiError(err), err),
    };
  }
}

/** Builds the messages array, prepending a system message when provided */
function buildMessages(
  systemPrompt: string | undefined,
  messages: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      result.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
      });
    } else if (msg.role === "tool") {
      result.push({
        role: "tool",
        content: msg.content ?? "",
        tool_call_id: msg.tool_call_id ?? "",
      });
    } else {
      result.push({
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content ?? "",
      });
    }
  }

  return result;
}

function formatApiError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
