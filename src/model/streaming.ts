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
        // Request usage statistics in the final streaming chunk so token
        // counts are available without a separate non-streaming call.
        // Ignored silently by APIs that don't support this option.
        stream_options: { include_usage: true },
      },
      { ...(opts.abortSignal && { signal: opts.abortSignal }) }
    );
  } catch (err) {
    if (isAbortError(err)) {
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
    return;
  }

  let finishReason: string | null = null;
  const tokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        tokenUsage.promptTokens = chunk.usage.prompt_tokens;
        tokenUsage.completionTokens = chunk.usage.completion_tokens;
        tokenUsage.totalTokens = chunk.usage.total_tokens;
      }

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

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (err) {
    if (isAbortError(err)) {
      // Interrupted by user — yield a clean done event with zero usage
      yield {
        type: "message_done",
        stopReason: "aborted",
        usage: tokenUsage,
      };
      return;
    }

    // Some OpenAI-compatible gateways close the HTTP body immediately after
    // sending the final finish_reason chunk instead of terminating the SSE
    // stream cleanly. The response is already semantically complete in that
    // case, so do not surface a false API error. A close before finish_reason
    // remains fatal because the content may be truncated.
    if (!finishReason || !isPrematureCloseError(err)) {
      yield {
        type: "error",
        error: makeError("API_ERROR", formatApiError(err), err),
      };
      return;
    }
  }

  if (!finishReason) {
    yield {
      type: "error",
      error: makeError("API_ERROR", "Streaming response ended without a finish reason"),
    };
    return;
  }

  // Usage commonly arrives in a final chunk with an empty choices array, so
  // tool completion and message_done are emitted only after the stream ends.
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

  yield { type: "message_done", stopReason: finishReason, usage: tokenUsage };
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

function isPrematureCloseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ERR_STREAM_PREMATURE_CLOSE" || /premature close/i.test(err.message);
}
