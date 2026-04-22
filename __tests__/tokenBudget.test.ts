import { describe, it, expect } from "vitest";
import {
  estimateStringTokens,
  estimateTokenCount,
  computeBudgetSnapshot,
  getContextWindowSize,
  estimateCostUsd,
} from "../src/context/tokenBudget.js";
import type { ChatMessage } from "../src/types/messages.js";

describe("getContextWindowSize", () => {
  it("returns correct sizes for known models", () => {
    expect(getContextWindowSize("gpt-4o")).toBe(128_000);
    expect(getContextWindowSize("gpt-4")).toBe(8_192);
    expect(getContextWindowSize("o1")).toBe(200_000);
    expect(getContextWindowSize("claude-3-5-sonnet")).toBe(200_000);
  });

  it("matches versioned names via prefix", () => {
    expect(getContextWindowSize("gpt-4o-2024-11-20")).toBe(128_000);
    expect(getContextWindowSize("gpt-4o-mini-2024-07-18")).toBe(128_000);
  });

  it("defaults to 128k for unknown models", () => {
    expect(getContextWindowSize("unknown-model-xyz")).toBe(128_000);
  });
});

describe("estimateStringTokens", () => {
  it("estimates text tokens at ~4 chars/token", () => {
    expect(estimateStringTokens("a".repeat(40))).toBe(10);
  });

  it("estimates JSON tokens at ~2 chars/token", () => {
    expect(estimateStringTokens("a".repeat(40), true)).toBe(20);
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
  });
});

describe("estimateTokenCount", () => {
  const sysPrompt = "You are a helpful assistant.";

  it("includes system prompt tokens", () => {
    const count = estimateTokenCount([], sysPrompt);
    expect(count).toBeGreaterThan(0);
  });

  it("increases with more messages", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there, how can I help you?" },
    ];
    const countWithMsgs = estimateTokenCount(msgs, sysPrompt);
    const countEmpty = estimateTokenCount([], sysPrompt);
    expect(countWithMsgs).toBeGreaterThan(countEmpty);
  });

  it("accounts for tool calls", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "ReadFile", arguments: '{"path":"x"}' } }],
      },
    ];
    const count = estimateTokenCount(msgs, "");
    expect(count).toBeGreaterThan(0);
  });
});

describe("computeBudgetSnapshot", () => {
  const config = { warnThreshold: 0.7, compressThreshold: 0.85, tailTokens: 20000 };

  it("returns usageRatio between 0 and 1 for a normal conversation", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const snap = computeBudgetSnapshot(msgs, "You are helpful.", config, "gpt-4o");
    expect(snap.usageRatio).toBeGreaterThan(0);
    expect(snap.usageRatio).toBeLessThan(1);
  });

  it("sets isAboveWarn when ratio >= warnThreshold", () => {
    const longContent = "word ".repeat(30000);
    const msgs: ChatMessage[] = [{ role: "user", content: longContent }];
    const snap = computeBudgetSnapshot(msgs, "", config, "gpt-4o");
    expect(snap.isAboveWarn).toBe(snap.usageRatio >= config.warnThreshold);
    expect(snap.isAboveCompress).toBe(snap.usageRatio >= config.compressThreshold);
  });

  it("exposes contextWindowSize", () => {
    const snap = computeBudgetSnapshot([], "", config, "gpt-4o");
    expect(snap.contextWindowSize).toBe(128_000);
  });
});

describe("estimateCostUsd", () => {
  it("calculates cost for gpt-4o", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    const cost = estimateCostUsd(usage, "gpt-4o");
    expect(cost).toBeCloseTo(12.5, 1);
  });

  it("returns a positive value for any usage", () => {
    const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    expect(estimateCostUsd(usage, "gpt-4o")).toBeGreaterThan(0);
  });

  it("returns 0 for zero usage", () => {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    expect(estimateCostUsd(usage, "gpt-4o")).toBe(0);
  });
});
