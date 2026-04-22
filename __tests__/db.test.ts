import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  SCHEMA_SQL,
  createSession,
  setSessionTitle,
  updateSessionStats,
  getSession,
  listSessions,
  appendMessage,
  loadMessagesForSession,
  rowsToChatMessages,
  searchMessages,
  pruneOldSessions,
} from "../src/session/db.js";

// ────────────────────────────────────────────────────────────────────────────
// Test helper: in-memory database per test
// ────────────────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function makeSessionBase(id: string) {
  return {
    id,
    title: "Test session",
    model: "gpt-4o",
    parentSessionId: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  } as const;
}

// ────────────────────────────────────────────────────────────────────────────
// Sessions
// ────────────────────────────────────────────────────────────────────────────

describe("createSession / getSession", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("creates and retrieves a session by id", () => {
    createSession(db, makeSessionBase("sess-1"));
    const s = getSession(db, "sess-1");
    expect(s).not.toBeNull();
    expect(s!.id).toBe("sess-1");
    expect(s!.title).toBe("Test session");
  });

  it("returns null for unknown session id", () => {
    expect(getSession(db, "nonexistent")).toBeNull();
  });

  it("stores parentSessionId", () => {
    createSession(db, makeSessionBase("parent"));
    createSession(db, { ...makeSessionBase("child"), parentSessionId: "parent" });
    const child = getSession(db, "child");
    expect(child!.parentSessionId).toBe("parent");
  });
});

describe("setSessionTitle", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("updates the session title", () => {
    createSession(db, makeSessionBase("s1"));
    setSessionTitle(db, "s1", "New title");
    expect(getSession(db, "s1")!.title).toBe("New title");
  });

  it("truncates title to 120 characters", () => {
    createSession(db, makeSessionBase("s1"));
    setSessionTitle(db, "s1", "x".repeat(200));
    expect(getSession(db, "s1")!.title.length).toBe(120);
  });
});

describe("updateSessionStats", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("accumulates tokens and cost additively", () => {
    createSession(db, makeSessionBase("s1"));
    updateSessionStats(db, "s1", 100, 50, 0.001);
    updateSessionStats(db, "s1", 200, 100, 0.002);
    const s = getSession(db, "s1")!;
    expect(s.inputTokens).toBe(300);
    expect(s.outputTokens).toBe(150);
    expect(s.estimatedCostUsd).toBeCloseTo(0.003);
  });
});

describe("listSessions", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("returns sessions ordered by updatedAt descending", async () => {
    createSession(db, makeSessionBase("s1"));
    await new Promise(r => setTimeout(r, 5));
    createSession(db, makeSessionBase("s2"));
    const sessions = listSessions(db, 10);
    expect(sessions[0]!.id).toBe("s2");
    expect(sessions[1]!.id).toBe("s1");
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) createSession(db, makeSessionBase(`s${i}`));
    expect(listSessions(db, 3)).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────────────────────

describe("appendMessage / loadMessagesForSession", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    createSession(db, makeSessionBase("s1"));
  });

  it("appends and loads messages in order", () => {
    appendMessage(db, { sessionId: "s1", role: "user", content: "Hello", toolCallsJson: null, toolCallId: null, tokenCount: 10 });
    appendMessage(db, { sessionId: "s1", role: "assistant", content: "Hi!", toolCallsJson: null, toolCallId: null, tokenCount: 5 });

    const rows = loadMessagesForSession(db, "s1");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.role).toBe("user");
    expect(rows[1]!.role).toBe("assistant");
  });

  it("returns empty array for unknown session", () => {
    expect(loadMessagesForSession(db, "unknown")).toHaveLength(0);
  });

  it("returns auto-incremented rowid", () => {
    const id1 = appendMessage(db, { sessionId: "s1", role: "user", content: "a", toolCallsJson: null, toolCallId: null, tokenCount: 0 });
    const id2 = appendMessage(db, { sessionId: "s1", role: "user", content: "b", toolCallsJson: null, toolCallId: null, tokenCount: 0 });
    expect(id2).toBeGreaterThan(id1);
  });
});

describe("rowsToChatMessages", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    createSession(db, makeSessionBase("s1"));
  });

  it("reconstructs plain messages", () => {
    appendMessage(db, { sessionId: "s1", role: "user", content: "Hello", toolCallsJson: null, toolCallId: null, tokenCount: 0 });
    const [msg] = rowsToChatMessages(loadMessagesForSession(db, "s1"));
    expect(msg!.role).toBe("user");
    expect(msg!.content).toBe("Hello");
  });

  it("reconstructs tool_calls from JSON", () => {
    const toolCalls = [{ id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{"path":"x"}' } }];
    appendMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: null,
      toolCallsJson: JSON.stringify(toolCalls),
      toolCallId: null,
      tokenCount: 0,
    });
    const [msg] = rowsToChatMessages(loadMessagesForSession(db, "s1"));
    expect(msg!.tool_calls).toHaveLength(1);
    expect(msg!.tool_calls![0]!.function.name).toBe("ReadFile");
  });

  it("reconstructs tool result messages with tool_call_id", () => {
    appendMessage(db, { sessionId: "s1", role: "tool", content: "ok", toolCallsJson: null, toolCallId: "tc1", tokenCount: 0 });
    const [msg] = rowsToChatMessages(loadMessagesForSession(db, "s1"));
    expect(msg!.role).toBe("tool");
    expect(msg!.tool_call_id).toBe("tc1");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// FTS5 search
// ────────────────────────────────────────────────────────────────────────────

describe("searchMessages", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    createSession(db, { ...makeSessionBase("s1"), title: "My session" });
    appendMessage(db, { sessionId: "s1", role: "user", content: "How does SQLite WAL mode work?", toolCallsJson: null, toolCallId: null, tokenCount: 0 });
    appendMessage(db, { sessionId: "s1", role: "assistant", content: "WAL stands for Write-Ahead Logging.", toolCallsJson: null, toolCallId: null, tokenCount: 0 });
  });

  it("finds messages matching the query", () => {
    const results = searchMessages(db, "WAL mode", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toMatch(/WAL/i);
  });

  it("returns empty array for no matches", () => {
    expect(searchMessages(db, "xyzzy_nonexistent_query", 10)).toHaveLength(0);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      appendMessage(db, { sessionId: "s1", role: "user", content: `question about databases ${i}`, toolCallsJson: null, toolCallId: null, tokenCount: 0 });
    }
    const results = searchMessages(db, "databases", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("does not throw on special FTS5 characters (injection safety)", () => {
    expect(() => searchMessages(db, 'test "quoted" OR AND', 10)).not.toThrow();
    expect(() => searchMessages(db, "test*", 10)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pruneOldSessions
// ────────────────────────────────────────────────────────────────────────────

describe("pruneOldSessions", () => {
  it("removes sessions beyond the limit, keeping the most recent", async () => {
    const db = createTestDb();
    for (let i = 0; i < 55; i++) {
      createSession(db, makeSessionBase(`s${String(i).padStart(3, "0")}`));
      await new Promise(r => setTimeout(r, 2));
    }
    pruneOldSessions(db, 50);
    const sessions = listSessions(db, 100);
    expect(sessions.length).toBe(50);
    expect(sessions.some(s => s.id === "s054")).toBe(true);
    expect(sessions.some(s => s.id === "s000")).toBe(false);
  });
});
