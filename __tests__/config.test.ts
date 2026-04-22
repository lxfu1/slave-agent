import { describe, it, expect } from "vitest";
import { convertKeysToCamelCase } from "../src/config/loader.js";

describe("convertKeysToCamelCase", () => {
  it("converts top-level snake_case keys", () => {
    expect(convertKeysToCamelCase({ base_url: "http://x", api_key: "k" })).toEqual({
      baseUrl: "http://x",
      apiKey: "k",
    });
  });

  it("converts nested keys recursively", () => {
    const input = {
      model: { base_url: "http://x", timeout_ms: 60000 },
      context: { warn_threshold: 0.7, compress_threshold: 0.85, tail_tokens: 20000 },
    };
    expect(convertKeysToCamelCase(input)).toEqual({
      model: { baseUrl: "http://x", timeoutMs: 60000 },
      context: { warnThreshold: 0.7, compressThreshold: 0.85, tailTokens: 20000 },
    });
  });

  it("converts array elements that are objects", () => {
    const input = { mcp_servers: [{ server_name: "github" }] };
    expect(convertKeysToCamelCase(input)).toEqual({
      mcpServers: [{ serverName: "github" }],
    });
  });

  it("does not convert SCREAMING_SNAKE env var names inside env objects", () => {
    // Env var keys use _ but not _[a-z] pattern, so they are untouched.
    const input = { env: { GITHUB_TOKEN: "abc", NODE_ENV: "production" } };
    const result = convertKeysToCamelCase(input) as Record<string, unknown>;
    const env = result["env"] as Record<string, unknown>;
    expect(env["GITHUB_TOKEN"]).toBe("abc");
    expect(env["NODE_ENV"]).toBe("production");
  });

  it("passes through primitive values unchanged", () => {
    expect(convertKeysToCamelCase("string")).toBe("string");
    expect(convertKeysToCamelCase(42)).toBe(42);
    expect(convertKeysToCamelCase(true)).toBe(true);
    expect(convertKeysToCamelCase(null)).toBe(null);
  });

  it("handles empty objects and arrays", () => {
    expect(convertKeysToCamelCase({})).toEqual({});
    expect(convertKeysToCamelCase([])).toEqual([]);
  });

  it("preserves already-camelCase keys unchanged", () => {
    const input = { baseUrl: "http://x", apiKey: "k" };
    expect(convertKeysToCamelCase(input)).toEqual({ baseUrl: "http://x", apiKey: "k" });
  });

  it("converts memory.auto_update and max_inject_tokens", () => {
    const input = { memory: { auto_update: true, max_inject_tokens: 4000 } };
    expect(convertKeysToCamelCase(input)).toEqual({
      memory: { autoUpdate: true, maxInjectTokens: 4000 },
    });
  });

  it("converts permissions.disabled_tools", () => {
    const input = { permissions: { disabled_tools: ["RunCommand"] } };
    expect(convertKeysToCamelCase(input)).toEqual({
      permissions: { disabledTools: ["RunCommand"] },
    });
  });
});
