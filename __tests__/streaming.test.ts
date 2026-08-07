import { describe, expect, it } from "vitest";
import { streamChat } from "../src/model/streaming.js";

describe("streamChat", () => {
  it("waits for the final usage-only chunk", async () => {
    const chunks = [
      { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ];
    const client = mockClient(chunks);
    const events = [];

    for await (const event of streamChat(client, { model: "test", messages: [] })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "message_done",
      stopReason: "stop",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });

  it("accepts a premature transport close after an explicit finish reason", async () => {
    const client = mockClient([
      { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], new Error("Premature close"));
    const events = [];

    for await (const event of streamChat(client, { model: "test", messages: [] })) {
      events.push(event);
    }

    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "message_done",
      stopReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });

  it("still reports a premature close before the response is complete", async () => {
    const client = mockClient(
      [{ choices: [{ delta: { content: "partial" }, finish_reason: null }] }],
      new Error("Premature close"),
    );
    const events = [];

    for await (const event of streamChat(client, { model: "test", messages: [] })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "API_ERROR", message: "Premature close" },
    });
  });
});

function mockClient(chunks: unknown[], terminalError?: Error) {
  return {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
            if (terminalError) throw terminalError;
          },
        }),
      },
    },
  } as never;
}
