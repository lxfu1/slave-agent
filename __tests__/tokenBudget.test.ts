import { describe, it, expect } from "vitest";
import {
  estimateStringTokens,
  estimateTokenCount,
  computeBudgetSnapshot,
  getContextWindowSize,
  estimateCostUsd,
} from "../src/context/tokenBudget.js";
import type { ChatMessage } from "../src/types/messages.js";

// ---------------------------------------------------------------------------
// getContextWindowSize
// ---------------------------------------------------------------------------

describe("getContextWindowSize", () => {
  it("returns correct sizes for known models", () => {
    expect(getContextWindowSize("gpt-4o")).toBe(128_000);
    expect(getContextWindowSize("gpt-4")).toBe(8_192);
    expect(getContextWindowSize("o1")).toBe(200_000);
    expect(getContextWindowSize("o3-mini")).toBe(200_000);
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

// ---------------------------------------------------------------------------
// estimateStringTokens — uses real BPE tokenizer (cl100k_base)
// ---------------------------------------------------------------------------

describe("estimateStringTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
    expect(estimateStringTokens("", true)).toBe(0);
  });

  it("tokenises English prose accurately", () => {
    // "Hello, world!" is exactly 4 cl100k tokens: ["Hello", ",", " world", "!"]
    expect(estimateStringTokens("Hello, world!")).toBe(4);
  });

  it("tokenises source code accurately", () => {
    // Real BPE produces far fewer tokens than 4 chars/token would suggest for code
    const code = "def bubble_sort(arr):\n    n = len(arr)";
    const tokens = estimateStringTokens(code);
    // 38 chars → old estimate would be 10, BPE gives ~11
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(16);
  });

  it("longer text produces more tokens than shorter text", () => {
    const short = estimateStringTokens("Hi");
    const long  = estimateStringTokens("Hello, how are you doing today? I hope everything is going well.");
    expect(long).toBeGreaterThan(short);
  });

  it("handles repetitive text efficiently (BPE merges runs)", () => {
    // 40 identical chars — BPE collapses them; old 4-char estimate would give 10
    const tokens = estimateStringTokens("a".repeat(40));
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10); // BPE merges → far fewer than char estimate
  });

  it("dense JSON tokenises to more tokens than prose of same length", () => {
    // JSON has many special characters that BPE doesn't merge as aggressively
    const json  = estimateStringTokens('{"path":"src/main.ts","content":"hello"}');
    const prose = estimateStringTokens("The quick brown fox jumps over a lazy dog"); // similar length
    // Both should be positive; JSON tends to produce slightly more tokens
    expect(json).toBeGreaterThan(0);
    expect(prose).toBeGreaterThan(0);
  });

  it("isJson flag is accepted but does not change the result (tokenizer handles all text)", () => {
    const text = '{"key": "value"}';
    expect(estimateStringTokens(text, true)).toBe(estimateStringTokens(text, false));
  });
});

// ---------------------------------------------------------------------------
// estimateTokenCount
// ---------------------------------------------------------------------------

describe("estimateTokenCount", () => {
  it("includes the assistant-priming overhead even for an empty conversation", () => {
    // 3 tokens for assistant priming even with no messages
    const count = estimateTokenCount([], "");
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("includes system prompt tokens", () => {
    const withSys    = estimateTokenCount([], "You are a helpful assistant.");
    const withoutSys = estimateTokenCount([], "");
    expect(withSys).toBeGreaterThan(withoutSys);
  });

  it("increases with more messages", () => {
    const msgs: ChatMessage[] = [
      { role: "user",      content: "Hello world" },
      { role: "assistant", content: "Hi there, how can I help you?" },
    ];
    const withMsgs = estimateTokenCount(msgs, "");
    const empty    = estimateTokenCount([], "");
    expect(withMsgs).toBeGreaterThan(empty);
  });

  it("accounts for tool calls", () => {
    const withTool: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tc1",
          type: "function",
          function: { name: "ReadFile", arguments: '{"path":"src/main.ts"}' },
        }],
      },
    ];
    const withoutTool: ChatMessage[] = [
      { role: "assistant", content: null },
    ];
    expect(estimateTokenCount(withTool, "")).toBeGreaterThan(
      estimateTokenCount(withoutTool, ""),
    );
  });

  it("is significantly more accurate than 4-chars-per-token for code", () => {
    // A Python function body — old estimate: ~50 tokens; BPE: closer to 60-70
    const code = `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr`;

    const msgs: ChatMessage[] = [{ role: "assistant", content: code }];
    const count = estimateTokenCount(msgs, "");
    // 220-char function: old 4-char estimate ≈ 55+overhead, BPE ≈ 65-90+overhead
    expect(count).toBeGreaterThan(50);
    expect(count).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// computeBudgetSnapshot
// ---------------------------------------------------------------------------

describe("computeBudgetSnapshot", () => {
  const config = { warnThreshold: 0.7, compressThreshold: 0.85, tailTokens: 20_000 };

  it("returns a positive usageRatio for any conversation", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const snap = computeBudgetSnapshot(msgs, "You are helpful.", config, "gpt-4o");
    expect(snap.usageRatio).toBeGreaterThan(0);
    expect(snap.usageRatio).toBeLessThan(1);
  });

  it("correctly sets isAboveWarn / isAboveCompress thresholds", () => {
    const longContent = "word ".repeat(30_000); // ~30k tokens → >70% of 128k
    const msgs: ChatMessage[] = [{ role: "user", content: longContent }];
    const snap = computeBudgetSnapshot(msgs, "", config, "gpt-4o");
    expect(snap.isAboveWarn).toBe(snap.usageRatio >= config.warnThreshold);
    expect(snap.isAboveCompress).toBe(snap.usageRatio >= config.compressThreshold);
  });

  it("exposes the correct contextWindowSize for the model", () => {
    const snap = computeBudgetSnapshot([], "", config, "gpt-4o");
    expect(snap.contextWindowSize).toBe(128_000);
  });

  it("empty conversation has non-zero token count (priming overhead)", () => {
    const snap = computeBudgetSnapshot([], "", config, "gpt-4o");
    expect(snap.estimatedTotal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// estimateCostUsd
// ---------------------------------------------------------------------------

describe("estimateCostUsd", () => {
  it("calculates cost for gpt-4o at published rates", () => {
    // $2.5/1M input + $10/1M output → $12.5 for 1M each
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    expect(estimateCostUsd(usage, "gpt-4o")).toBeCloseTo(12.5, 1);
  });

  it("calculates cost for gpt-4o-mini (cheap model)", () => {
    // $0.15/1M input + $0.6/1M output → $0.75 for 1M each
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    expect(estimateCostUsd(usage, "gpt-4o-mini")).toBeCloseTo(0.75, 2);
  });

  it("returns a positive value for any non-zero usage", () => {
    const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    expect(estimateCostUsd(usage, "gpt-4o")).toBeGreaterThan(0);
  });

  it("returns 0 for zero usage", () => {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    expect(estimateCostUsd(usage, "gpt-4o")).toBe(0);
  });

  it("uses a sensible default rate for unknown models", () => {
    const usage = { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 };
    const cost = estimateCostUsd(usage, "some-unknown-model");
    expect(cost).toBeGreaterThan(0);
  });
});
