/**
 * SQLite session storage with WAL mode and FTS5 full-text search.
 *
 * SQLITE_BUSY / database-locked errors are handled at the database level via
 * PRAGMA busy_timeout, so no application-level retry is needed.
 */

import Database from "better-sqlite3";
import path from "node:path";
import type { MessageRow, SearchResultRow, SessionRow } from "../types/session.js";
import type { ChatMessage, OpenAIToolCall } from "../types/messages.js";

const DB_FILE = "sessions.db";
const MAX_SESSIONS = 50;

// ---------------------------------------------------------------------------
// Statement cache
// ---------------------------------------------------------------------------

interface PreparedStatements {
  insertSession: Database.Statement;
  updateSessionTitle: Database.Statement;
  updateSessionStats: Database.Statement;
  insertMessage: Database.Statement;
  loadMessages: Database.Statement;
}

// Keyed by db instance so the cache is automatically GC'd when the db closes
const stmtCache = new WeakMap<Database.Database, PreparedStatements>();

function getStmts(db: Database.Database): PreparedStatements {
  let stmts = stmtCache.get(db);
  if (!stmts) {
    stmts = {
      insertSession: db.prepare(`
        INSERT INTO sessions (id, title, model, parent_session_id, input_tokens, output_tokens, estimated_cost_usd, created_at, updated_at)
        VALUES (@id, @title, @model, @parentSessionId, @inputTokens, @outputTokens, @estimatedCostUsd, @createdAt, @updatedAt)
      `),
      updateSessionTitle: db.prepare(
        `UPDATE sessions SET title = @title, updated_at = @updatedAt WHERE id = @id`
      ),
      updateSessionStats: db.prepare(`
        UPDATE sessions
        SET input_tokens = input_tokens + @inputTokens,
            output_tokens = output_tokens + @outputTokens,
            estimated_cost_usd = estimated_cost_usd + @estimatedCostUsd,
            updated_at = @updatedAt
        WHERE id = @id
      `),
      insertMessage: db.prepare(`
        INSERT INTO messages (session_id, role, content, tool_calls_json, tool_call_id, token_count, created_at)
        VALUES (@sessionId, @role, @content, @toolCallsJson, @toolCallId, @tokenCount, @createdAt)
      `),
      loadMessages: db.prepare(`
        SELECT id, session_id AS sessionId, role, content,
               tool_calls_json AS toolCallsJson,
               tool_call_id AS toolCallId,
               token_count AS tokenCount,
               created_at AS createdAt
        FROM messages
        WHERE session_id = ?
        ORDER BY id ASC
      `),
    };
    stmtCache.set(db, stmts);
  }
  return stmts;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** @internal Exported for use in test helpers that need an in-memory database. */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT REFERENCES sessions(id),
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  content        TEXT,
  tool_calls_json TEXT,
  tool_call_id   TEXT,
  token_count    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai
AFTER INSERT ON messages
WHEN new.content IS NOT NULL
BEGIN
  INSERT INTO messages_fts(rowid, content, session_id)
  VALUES (new.id, new.content, new.session_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad
AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, session_id)
  VALUES ('delete', old.id, old.content, old.session_id);
END;
`;

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

/** Opens (or creates) the sessions database and runs schema migrations */
export function openDatabase(profileDir: string): Database.Database {
  const dbPath = path.join(profileDir, DB_FILE);
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export function createSession(
  db: Database.Database,
  session: Omit<SessionRow, "createdAt" | "updatedAt">
): void {
  const now = new Date().toISOString();
  getStmts(db).insertSession.run({ ...session, createdAt: now, updatedAt: now });
}

export function setSessionTitle(db: Database.Database, sessionId: string, title: string): void {
  getStmts(db).updateSessionTitle.run({
    title: title.slice(0, 120),
    updatedAt: new Date().toISOString(),
    id: sessionId,
  });
}

export function updateSessionStats(
  db: Database.Database,
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd: number
): void {
  getStmts(db).updateSessionStats.run({
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    updatedAt: new Date().toISOString(),
    id: sessionId,
  });
}

export function getSession(
  db: Database.Database,
  sessionId: string
): SessionRow | null {
  const row = db.prepare(`
    SELECT id, title, model,
           parent_session_id AS parentSessionId,
           input_tokens AS inputTokens,
           output_tokens AS outputTokens,
           estimated_cost_usd AS estimatedCostUsd,
           created_at AS createdAt,
           updated_at AS updatedAt
    FROM sessions WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;

  return row ?? null;
}

export function listSessions(
  db: Database.Database,
  limit = 20
): SessionRow[] {
  return db.prepare(`
    SELECT id, title, model,
           parent_session_id AS parentSessionId,
           input_tokens AS inputTokens,
           output_tokens AS outputTokens,
           estimated_cost_usd AS estimatedCostUsd,
           created_at AS createdAt,
           updated_at AS updatedAt
    FROM sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as SessionRow[];
}

/** Removes oldest sessions beyond the retention limit */
export function pruneOldSessions(
  db: Database.Database,
  maxSessions = MAX_SESSIONS
): void {
  db.prepare(`
    DELETE FROM sessions
    WHERE id NOT IN (
      SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?
    )
  `).run(maxSessions);
}

// ---------------------------------------------------------------------------
// Message operations
// ---------------------------------------------------------------------------

/** Appends a message row and returns its auto-incremented ID */
export function appendMessage(
  db: Database.Database,
  msg: Omit<MessageRow, "id" | "createdAt">
): number {
  const now = new Date().toISOString();
  const result = getStmts(db).insertMessage.run({ ...msg, createdAt: now });
  return result.lastInsertRowid as number;
}

/** Loads all messages for a session, ordered by insertion time */
export function loadMessagesForSession(
  db: Database.Database,
  sessionId: string
): MessageRow[] {
  return getStmts(db).loadMessages.all(sessionId) as MessageRow[];
}

/** Reconstructs ChatMessage[] from stored MessageRows */
export function rowsToChatMessages(rows: MessageRow[]): ChatMessage[] {
  return rows.map((row): ChatMessage => {
    const base: ChatMessage = {
      role: row.role as ChatMessage["role"],
      content: row.content,
    };
    if (row.toolCallsJson) {
      // Cast to the concrete array type (not ChatMessage["tool_calls"] which
      // includes undefined and would violate exactOptionalPropertyTypes)
      base.tool_calls = JSON.parse(row.toolCallsJson) as OpenAIToolCall[];
    }
    if (row.toolCallId) {
      base.tool_call_id = row.toolCallId;
    }
    return base;
  });
}

/** Full-text search across all message content using FTS5 */
export function searchMessages(
  db: Database.Database,
  query: string,
  limit = 20
): SearchResultRow[] {
  // Wrap query in double quotes to treat it as a phrase search, preventing
  // FTS5 operator injection and guarding against malformed FTS5 syntax errors.
  const safeQuery = `"${query.replace(/"/g, '""')}"`;
  try {
    return db.prepare(`
      SELECT m.id, m.session_id AS sessionId, m.role, m.content,
             m.tool_calls_json AS toolCallsJson,
             m.tool_call_id AS toolCallId,
             m.token_count AS tokenCount,
             m.created_at AS createdAt,
             s.title AS sessionTitle
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, limit) as SearchResultRow[];
  } catch {
    // FTS5 syntax error — return empty results rather than crashing
    return [];
  }
}
