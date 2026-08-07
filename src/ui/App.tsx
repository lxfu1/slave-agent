/**
 * Root Ink application component.
 *
 * State machine:
 *   idle              — waiting for user input
 *   streaming         — model is generating a response
 *   tool_running      — a tool is executing
 *   awaiting_permission — permission dialog showing
 *   searching         — search mode active
 *
 * Input capabilities:
 *   ←/→ arrows       — cursor positioning within the current line
 *   ↑/↓ arrows       — navigate between lines (multi-line) or command history (single-line)
 *   Shift+Enter      — insert newline (requires Kitty Keyboard Protocol support;
 *                      \+Enter works as a universal fallback)
 *   Enter            — submit input
 *   Esc              — cancel multi-line input (merge to single line)
 *   Streaming state  — characters accepted and queued, shown in gray;
 *                      Enter is blocked until idle
 *
 * Ctrl+C behaviour:
 *   During streaming  — flush partial response as [interrupted], then abort
 *   During idle       — second press within 2 s exits the process
 *
 * Rendering strategy:
 *   Committed entries (previous turns) → Ink <Static> (rendered once, lives
 *     in terminal scroll buffer — no re-render on stream deltas)
 *   Active entries (current turn)      → normal dynamic region
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type Database from "better-sqlite3";
import type OpenAI from "openai";
import {
  ConversationEngine,
  type EngineEvent,
  type SessionUsage,
} from "../engine/conversationEngine.js";
import { MessageEntryItem } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import { PermissionDialog, handlePermissionInput } from "./PermissionDialog.js";
import { SearchBar, SearchResultsPanel } from "./Search.js";
import { StreamingIndicator, InputPanel } from "./components/index.js";
import {
  useStreamingBuffer,
  useSearch,
  useAppTimers,
  useEntries,
} from "./hooks/index.js";
import type { MemoAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import type { PermissionRequest } from "../permissions/guard.js";
import type { McpServerEntry } from "../mcp/mcpBridge.js";
import { watchConfig } from "../config/loader.js";
import type { AppState, MessageEntryData } from "./types.js";
import type { ChatMessage } from "../types/messages.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AppProps {
  config: MemoAgentConfig;
  profileDir: string;
  cwd: string;
  db: Database.Database;
  sessionId: string;
  modelClient: OpenAI;
  auxiliaryClient: OpenAI | null;
  recipes: Recipe[];
  initialMessages?: ChatMessage[];
  permissionMode?: "ask" | "auto";
  profileName?: string;
  /** Promise that resolves once MCP bootstrap completes. Used for status feedback. */
  mcpReady?: Promise<McpServerEntry[]>;
}

function messagesToEntryData(messages: ChatMessage[]): MessageEntryData[] {
  const result: MessageEntryData[] = [];
  for (const message of messages) {
    const content = sanitizeTerminalText(message.content ?? "");
    if (message.role === "user" && content) {
      result.push({ kind: "user", content });
    } else if (message.role === "assistant" && content) {
      result.push({ kind: "assistant", content });
    } else if (message.role === "tool" && content) {
      result.push({
        kind: "notice",
        content: `${message.name ?? "tool"}: ${content}`,
        level: content.startsWith("Error:") ? "error" : "info",
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const streaming = useStreamingBuffer();
  const search = useSearch();
  const entries = useEntries(messagesToEntryData(props.initialMessages ?? []));

  const [engine] = useState(() => new ConversationEngine(props));
  const [appState, setAppState] = useState<AppState>("idle");
  const appStateRef = useRef<AppState>("idle");
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  const [isWaiting, setIsWaiting] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [usage, setUsage] = useState<SessionUsage>(() => engine.getUsage());

  const lastCtrlCAt = useRef(0);
  const { spinnerFrame } = useAppTimers({ appState, isWaiting });

  // Exit after farewell renders
  useEffect(() => {
    if (pendingExit) void engine.shutdown().finally(exit);
  }, [pendingExit, exit, engine]);

  // Config hot-reload
  useEffect(() => {
    return watchConfig(
      props.profileDir,
      (newConfig) => {
        engine.updateConfig(newConfig);
        setUsage(engine.getUsage());
        entries.addEntry({
          kind: "notice",
          content: "Config reloaded. MCP server changes require a restart.",
          level: "info",
        });
      },
      (err) => {
        entries.addEntry({ kind: "notice", content: `Config reload failed: ${err.message}`, level: "error" });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MCP ready notification
  useEffect(() => {
    if (!props.mcpReady) return;
    props.mcpReady.then((mcpEntries) => {
      const connected = mcpEntries.filter(e => e.status.type === "connected");
      const failed = mcpEntries.filter(e => e.status.type === "failed");
      if (connected.length > 0) {
        const toolCounts = connected
          .map(e => {
            const s = e.status as { type: "connected"; toolCount: number };
            return `${e.name}(${s.toolCount})`;
          })
          .join(", ");
        entries.addEntry({
          kind: "notice",
          content: `MCP ready: ${toolCounts}`,
          level: "info",
        });
      }
      for (const e of failed) {
        const s = e.status as { type: "failed"; error: string };
        entries.addEntry({
          kind: "notice",
          content: `MCP "${e.name}" failed: ${s.error}`,
          level: "error",
        });
      }
    }).catch(() => { /* bootstrap errors already logged to stderr */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Engine event handler
  const handleEngineEvent = useCallback((event: EngineEvent) => {
    switch (event.type) {
      case "stream_delta":
        streaming.append(event.delta);
        setIsWaiting(false);
        break;

      case "tool_call_start":
        setAppState("tool_running");
        setIsWaiting(false);
        entries.addEntry({ kind: "tool_call", name: event.name, toolId: event.id, status: "running" });
        break;

      case "tool_call_description":
        entries.setToolDescription(event.id, event.description);
        break;

      case "tool_result":
        entries.updateToolEntry(event.id, event.isError ? "error" : "done", event.content);
        if (appStateRef.current !== "interrupting") setAppState("streaming");
        break;

      case "messages_updated": {
        const buffered = streaming.buffer;
        if (buffered) {
          streaming.clear();
          entries.addEntry({ kind: "assistant", content: buffered });
        }
        break;
      }

      case "usage_updated":
        setUsage(event.sessionUsage);
        break;

      case "token_warning":
        entries.addEntry({
          kind: "notice",
          content: `Token usage at ${Math.round(event.ratio * 100)}% — ${
            event.level === "critical" ? "compression triggered" : "consider /compact"
          }`,
          level: event.level === "critical" ? "error" : "info",
        });
        break;

      case "compressed":
        entries.addEntry({
          kind: "separator",
          label: `Context compressed (${event.trigger}) — history in scroll buffer`,
        });
        break;

      case "command_output":
        entries.addEntry({
          kind: "notice",
          content: event.message,
          level: event.kind === "error" ? "error" : event.kind === "help" ? "help" : "info",
        });
        break;

      case "session_cleared":
        entries.clearEntries();
        streaming.clear();
        entries.addEntry({ kind: "notice", content: "Session cleared. Memory is preserved.", level: "info" });
        break;

      case "session_restored":
        streaming.clear();
        entries.replaceEntries(messagesToEntryData(event.messages));
        setUsage(event.sessionUsage);
        break;

      case "notes_shown":
        entries.addEntry({ kind: "notice", content: event.content, level: "info" });
        break;

      case "notes_cleared":
        entries.addEntry({ kind: "notice", content: "NOTES.md cleared.", level: "success" });
        break;

      case "permission_request":
        setPendingPermission(event.request);
        setAppState("awaiting_permission");
        break;

      case "injection_warning":
        entries.addEntry({
          kind: "notice",
          content: `Warning: potential prompt injection in ${event.source} — content skipped`,
          level: "error",
        });
        break;

      case "error":
        entries.addEntry({
          kind: "notice",
          content: `Error [${event.code}]: ${event.message}`,
          level: "error",
        });
        setAppState("idle");
        break;

      case "exit_requested":
        entries.addEntry({ kind: "notice", content: "Goodbye! Session saved.", level: "success" });
        setPendingExit(true);
        break;

      case "agent_plan_start":
        entries.addEntry({ kind: "notice", content: "Planning tasks...", level: "info" });
        break;

      case "agent_task_start":
        entries.addEntry({
          kind: "notice",
          content: `Task ${event.index}/${event.total}: ${event.subject}`,
          level: "info",
        });
        break;

      case "agent_task_done":
        entries.addEntry({
          kind: "notice",
          content: `✓ ${event.subject}`,
          level: event.status === "completed" ? "success" : "error",
        });
        break;

      case "agent_reflect_start":
        entries.addEntry({ kind: "notice", content: "Reflecting on results...", level: "info" });
        break;
    }
  }, [streaming, entries]);

  // Submit input — called by InputPanel when user presses Enter
  const submitInput = useCallback(async (userInput: string) => {
    entries.addEntry({ kind: "user", content: userInput });
    setAppState("streaming");
    setIsWaiting(true);
    streaming.clear();

    try {
      for await (const event of engine.submitMessage(userInput)) {
        handleEngineEvent(event);
      }
      const remaining = streaming.buffer;
      if (remaining) {
        streaming.clear();
        entries.addEntry({ kind: "assistant", content: remaining });
      }
    } catch (err) {
      entries.addEntry({
        kind: "notice",
        content: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        level: "error",
      });
    } finally {
      entries.commitEntries();
      setAppState("idle");
      setIsWaiting(false);
      setPendingPermission(null);
    }
  }, [engine, handleEngineEvent, streaming, entries]);

  // Search handlers
  const enterSearch = useCallback(() => {
    setAppState("searching");
    search.reset();
    search.performSearch(entries.entriesRef.current, "");
  }, [search, entries.entriesRef]);

  const exitSearch = useCallback(() => {
    setAppState("idle");
    search.reset();
  }, [search]);

  // Keyboard input — global hotkeys only (text editing is handled by InputPanel)
  useInput((char, key) => {
    // Search mode
    if (appState === "searching") {
      if (key.escape || (key.ctrl && char === "c")) {
        exitSearch();
        return;
      }
      if (key.return) {
        exitSearch();
        return;
      }
      if (key.upArrow || (key.ctrl && char === "p")) {
        search.prevResult();
        return;
      }
      if (key.downArrow || (key.ctrl && char === "n")) {
        search.nextResult();
        return;
      }
      if (key.backspace || key.delete) {
        const newQuery = removeLastGrapheme(search.queryRef.current);
        search.setQuery(newQuery);
        search.performSearch(entries.entriesRef.current, newQuery);
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        const newQuery = search.queryRef.current + char;
        search.setQuery(newQuery);
        search.performSearch(entries.entriesRef.current, newQuery);
      }
      return;
    }

    // Permission dialog
    if (appState === "awaiting_permission" && pendingPermission) {
      handlePermissionInput(char, key, pendingPermission, engine, setPendingPermission, setAppState);
      return;
    }

    // Ctrl+C
    if (key.ctrl && char === "c") {
      const now = Date.now();
      if (appState === "streaming" || appState === "tool_running") {
        const partial = streaming.buffer;
        streaming.clear();
        if (partial) entries.addEntry({ kind: "assistant", content: partial + " [interrupted]" });
        engine.interrupt();
        entries.commitEntries();
        setAppState("interrupting");
        setIsWaiting(false);
        return;
      }
      if (now - lastCtrlCAt.current < 2_000) {
        entries.addEntry({ kind: "notice", content: "Goodbye! Session saved.", level: "success" });
        setPendingExit(true);
        return;
      }
      lastCtrlCAt.current = now;
      entries.addEntry({ kind: "notice", content: "Press Ctrl+C again to exit", level: "info" });
      return;
    }

    // Ctrl+F: enter search mode
    if (key.ctrl && char === "f") {
      if (appState === "idle") {
        enterSearch();
      }
      return;
    }
  });

  // Render
  const isStreaming = appState === "streaming" || appState === "tool_running";
  const currentBuffer = isStreaming ? streaming.buffer : undefined;

  return (
    <Box flexDirection="column" height="100%">
      {/* Committed entries */}
      <Static key={entries.clearCount} items={entries.entries.slice(0, entries.committedCount)}>
        {(entry) => (
          <Box key={entry.id}>
            <MessageEntryItem entry={entry} />
          </Box>
        )}
      </Static>

      {/* Active entries */}
      <Box flexDirection="column">
        {entries.entries.slice(entries.committedCount).map((entry) => (
          <MessageEntryItem key={entry.id} entry={entry} />
        ))}

        {currentBuffer && (
          <Box paddingX={1}>
            <Text color="white">{sanitizeTerminalText(currentBuffer)}</Text>
            <Text color="cyan">▊</Text>
          </Box>
        )}
      </Box>

      {/* Status indicators */}
      <StreamingIndicator
        isWaiting={isWaiting}
        spinnerFrame={spinnerFrame}
        isToolRunning={appState === "tool_running" && !isWaiting}
      />

      {/* Permission dialog */}
      {appState === "awaiting_permission" && pendingPermission && (
        <PermissionDialog request={pendingPermission} />
      )}

      {/* Search results + bar */}
      {appState === "searching" && (
        <>
          <SearchResultsPanel
            entries={entries.entries}
            query={search.query}
            matchedIndices={search.results}
            currentIdx={search.currentIdx}
          />
          <SearchBar
            query={search.query}
            results={search.results}
            currentIdx={search.currentIdx}
          />
        </>
      )}

      {/* Input panel — self-contained, keystroke re-renders isolated */}
      <InputPanel appState={appState} onSubmit={submitInput} />

      {/* Status bar */}
      <StatusBar
        model={engine.getCurrentModel()}
        mode={engine.getCurrentMode()}
        profile={props.profileName ?? "default"}
        usage={usage}
        isStreaming={isStreaming}
      />
    </Box>
  );
}

function removeLastGrapheme(text: string): string {
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text));
  const last = segments.at(-1);
  return last ? text.slice(0, last.index) : "";
}
