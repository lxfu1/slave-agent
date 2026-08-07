import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type OpenAI from "openai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConversationEngine, type EngineEvent } from "../src/engine/conversationEngine.js";
import { appendMessage, createSession, SCHEMA_SQL, updateSessionStats } from "../src/session/db.js";
import type { ChatMessage } from "../src/types/messages.js";
import { DEFAULT_CONFIG } from "../src/types/config.js";

beforeAll(async () => {
  await import("../src/tools/index.js");
});

const databases: Database.Database[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ConversationEngine", () => {
  it("does not report max rounds when the final answer completes on the limit", async () => {
    const engine = await createEngine({ maxToolCallRounds: 1 });
    const events = await collect(engine.submitMessage("hello"));
    expect(events.some(event => event.type === "error" && event.code === "MAX_ROUNDS_EXCEEDED")).toBe(false);
  });

  it("tracks usage and resets it with /clear", async () => {
    const engine = await createEngine();
    await collect(engine.submitMessage("hello"));
    expect(engine.getUsage()).toMatchObject({ totalInputTokens: 5, totalOutputTokens: 2 });

    const events = await collect(engine.submitMessage("/clear"));
    const usageEvent = events.find(event => event.type === "usage_updated");
    expect(usageEvent).toMatchObject({
      type: "usage_updated",
      sessionUsage: { totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0 },
    });
  });

  it("restores empty and non-empty sessions with their persisted usage", async () => {
    const db = createDb();
    const targetId = "target-session";
    createSession(db, {
      id: targetId,
      title: "target",
      model: "gpt-4o",
      parentSessionId: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });
    appendMessage(db, {
      sessionId: targetId,
      role: "user",
      content: "restored message",
      toolCallsJson: null,
      toolCallId: null,
      tokenCount: 0,
    });
    updateSessionStats(db, targetId, 20, 4, 0.01);
    const engine = await createEngine({}, db);

    const events = await collect(engine.submitMessage(`/resume ${targetId}`));
    const restored = events.find(event => event.type === "session_restored");
    expect(restored).toMatchObject({
      type: "session_restored",
      messages: [{ role: "user", content: "restored message" }],
      sessionUsage: { totalInputTokens: 20, totalOutputTokens: 4, estimatedCostUsd: 0.01 },
    });
  });

  it("aborts an in-flight automatic note update during shutdown", async () => {
    let requestSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const client = {
      chat: {
        completions: {
          create: async (_request: unknown, options?: { signal?: AbortSignal }) => {
            requestSignal = options?.signal;
            notifyStarted?.();
            return {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>(resolve => {
                  if (requestSignal?.aborted) {
                    resolve();
                    return;
                  }
                  requestSignal?.addEventListener("abort", () => resolve(), { once: true });
                });
                const error = new Error("aborted");
                error.name = "AbortError";
                throw error;
              },
            };
          },
        },
      },
    } as unknown as OpenAI;
    const engine = await createEngine({}, createDb(), client);
    const internals = engine as unknown as {
      autoUpdateNotes(messages: ChatMessage[]): Promise<void>;
      notesUpdateChain: Promise<void>;
    };

    internals.notesUpdateChain = internals.autoUpdateNotes([
      { role: "tool", content: "updated source", tool_call_id: "call-1", name: "EditFile" },
    ]);
    await started;
    await engine.shutdown();

    expect(requestSignal?.aborted).toBe(true);
  });
});

async function createEngine(
  limitOverrides: { maxToolCallRounds?: number } = {},
  db = createDb(),
  modelClient: OpenAI = mockClient(),
): Promise<ConversationEngine> {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "memo-agent-engine-"));
  tempDirs.push(profileDir);
  const config = structuredClone(DEFAULT_CONFIG);
  config.model.apiKey = "test";
  config.memory.autoUpdate = false;
  if (limitOverrides.maxToolCallRounds !== undefined) {
    config.limits.maxToolCallRounds = limitOverrides.maxToolCallRounds;
  }
  return new ConversationEngine({
    config,
    profileDir,
    cwd: process.cwd(),
    db,
    sessionId: crypto.randomUUID(),
    modelClient,
    auxiliaryClient: null,
    recipes: [],
  });
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  databases.push(db);
  return db;
}

function mockClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: "stop" }] };
            yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
          },
        }),
      },
    },
  } as unknown as OpenAI;
}

async function collect(generator: AsyncGenerator<EngineEvent, void, unknown>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}
