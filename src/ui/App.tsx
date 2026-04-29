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
import { InputArea, StreamingIndicator } from "./components/index.js";
import {
  useStreamingBuffer,
  useSearch,
  useAppTimers,
  useEntries,
} from "./hooks/index.js";
import { useInputState } from "./useInputState.js";
import type { MemoAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import type { PermissionRequest } from "../permissions/guard.js";
import type { McpServerEntry } from "../mcp/mcpBridge.js";
import { getContextWindowSize } from "../context/tokenBudget.js";
import { watchConfig } from "../config/loader.js";
import type { AppState } from "./types.js";
import type { ChatMessage } from "../types/messages.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INPUT_LINES = 20;

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

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const streaming = useStreamingBuffer();
  const input = useInputState();
  const search = useSearch();
  const entries = useEntries();

  const [engine] = useState(() => new ConversationEngine(props));
  const [appState, setAppState] = useState<AppState>("idle");
  const appStateRef = useRef<AppState>("idle");
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  const [isWaiting, setIsWaiting] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [usage, setUsage] = useState<SessionUsage>({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    currentRatio: 0,
    contextWindowSize: getContextWindowSize(props.config.model.name),
  });

  const lastCtrlCAt = useRef(0);
  const { cursorVisible, spinnerFrame } = useAppTimers({ appState, isWaiting });

  // Exit after farewell renders
  useEffect(() => {
    if (pendingExit) exit();
  }, [pendingExit, exit]);

  // Config hot-reload
  useEffect(() => {
    return watchConfig(
      props.profileDir,
      (newConfig) => {
        engine.updateConfig(newConfig);
        entries.addEntry({ kind: "notice", content: "Config reloaded.", level: "info" });
      },
      (err) => {
        entries.addEntry({ kind: "notice", content: `Config reload failed: ${err.message}`, level: "error" });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shift+Enter — passive Kitty Keyboard Protocol listener
  useEffect(() => {
    const handleRawData = (chunk: Buffer) => {
      if (chunk.toString() !== "\x1b[13;2u") return;
      if (appStateRef.current !== "idle") return;

      const currentLines = input.linesRef.current;
      const lineIdx = input.currentLineIdxRef.current;
      const pos = input.cursorPosRef.current;
      const currentLine = currentLines[lineIdx] ?? "";

      if (currentLines.length >= MAX_INPUT_LINES) return;
      const before = currentLine.slice(0, pos);
      const after = currentLine.slice(pos);
      const newLines = [...currentLines];
      newLines[lineIdx] = before;
      newLines.splice(lineIdx + 1, 0, after);
      input.setLines(newLines, lineIdx + 1, 0);
      input.historyIdxRef.current = -1;
    };

    process.stdin.on("data", handleRawData);
    return () => { process.stdin.off("data", handleRawData); };
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
        setAppState("streaming");
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
    }
  }, [streaming, entries]);

  // Submit input
  const submitInput = useCallback(async () => {
    const userInput = input.getInputText();
    if (!userInput.trim()) return;

    input.pushHistory(userInput);
    input.setLines([""], 0, 0);
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
  }, [engine, handleEngineEvent, streaming, input, entries]);

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

  // Keyboard input
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
        const newQuery = search.queryRef.current.slice(0, -1);
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
        setAppState("idle");
        setIsWaiting(false);
        return;
      }
      if (now - lastCtrlCAt.current < 2_000) {
        exit();
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

    // Esc: cancel multi-line input
    if (key.escape && appState === "idle") {
      const currentText = input.getInputText();
      if (input.linesRef.current.length > 1) {
        input.setLines([currentText], 0, currentText.length);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
      }
      return;
    }

    const currentLines = input.linesRef.current;
    const lineIdx = input.currentLineIdxRef.current;
    const currentLine = currentLines[lineIdx] ?? "";
    const pos = input.cursorPosRef.current;

    // Cursor horizontal movement
    if (key.leftArrow) {
      if (pos > 0) {
        input.updateCursorInLine(pos - 1);
      } else if (lineIdx > 0) {
        const prevLine = currentLines[lineIdx - 1] ?? "";
        input.updateCurrentLine(lineIdx - 1);
        input.updateCursorInLine(prevLine.length);
      }
      return;
    }
    if (key.rightArrow) {
      if (pos < currentLine.length) {
        input.updateCursorInLine(pos + 1);
      } else if (lineIdx < currentLines.length - 1) {
        input.updateCurrentLine(lineIdx + 1);
        input.updateCursorInLine(0);
      }
      return;
    }

    // Up/Down: line navigation or history
    if (appState === "idle" && key.upArrow) {
      if (currentLines.length > 1 && lineIdx > 0) {
        const prevLine = currentLines[lineIdx - 1] ?? "";
        const newPos = Math.min(pos, prevLine.length);
        input.updateCurrentLine(lineIdx - 1);
        input.updateCursorInLine(newPos);
      } else if (currentLines.length === 1) {
        if (input.historyIdxRef.current === -1) input.savedInputRef.current = [...input.linesRef.current];
        const nextIdx = input.historyIdxRef.current + 1;
        const hist = input.inputHistoryRef.current;
        if (nextIdx < hist.length) {
          input.historyIdxRef.current = nextIdx;
          const item = hist[hist.length - 1 - nextIdx] as string;
          input.setInputFromHistory(item);
        }
      }
      return;
    }
    if (appState === "idle" && key.downArrow) {
      if (currentLines.length > 1 && lineIdx < currentLines.length - 1) {
        const nextLine = currentLines[lineIdx + 1] ?? "";
        const newPos = Math.min(pos, nextLine.length);
        input.updateCurrentLine(lineIdx + 1);
        input.updateCursorInLine(newPos);
      } else if (currentLines.length === 1 && input.historyIdxRef.current >= 0) {
        if (input.historyIdxRef.current > 0) {
          input.historyIdxRef.current--;
          const hist = input.inputHistoryRef.current;
          const item = hist[hist.length - 1 - input.historyIdxRef.current] as string;
          input.setInputFromHistory(item);
        } else if (input.historyIdxRef.current === 0) {
          input.historyIdxRef.current = -1;
          const saved = input.savedInputRef.current;
          input.setLines([...saved], 0, saved[0]?.length ?? 0);
        }
      }
      return;
    }

    // Return: submit or insert newline
    if (key.return) {
      if (appState !== "idle") return;

      if (currentLine.endsWith("\\")) {
        if (currentLines.length >= MAX_INPUT_LINES) return;
        const newLines = [...currentLines];
        newLines[lineIdx] = currentLine.slice(0, -1);
        newLines.splice(lineIdx + 1, 0, "");
        input.setLines(newLines, lineIdx + 1, 0);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
      } else {
        void submitInput();
      }
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      if (pos > 0) {
        const newLine = currentLine.slice(0, pos - 1) + currentLine.slice(pos);
        const newLines = [...currentLines];
        newLines[lineIdx] = newLine;
        input.setLines(newLines, lineIdx, pos - 1);
      } else if (lineIdx > 0) {
        const prevLine = currentLines[lineIdx - 1] ?? "";
        const newLines = [...currentLines];
        newLines[lineIdx - 1] = prevLine + currentLine;
        newLines.splice(lineIdx, 1);
        input.setLines(newLines, lineIdx - 1, prevLine.length);
      }
      if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
      return;
    }

    // Character input
    if (char && !key.ctrl && !key.meta && !/^\[[\d;]*[A-Za-z~]$/.test(char)) {
      const charLen = char.length;
      const newLine = currentLine.slice(0, pos) + char + currentLine.slice(pos);
      const newLines = [...currentLines];
      newLines[lineIdx] = newLine;
      input.setLines(newLines, lineIdx, pos + charLen);
      if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
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
            <Text color="white">{currentBuffer}</Text>
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

      {/* Input area */}
      {appState !== "awaiting_permission" && appState !== "searching" && (
        <InputArea
          lines={input.linesDisplay}
          currentLineIdx={input.currentLineIdx}
          cursorPos={input.cursorPos}
          cursorVisible={cursorVisible}
          appState={appState}
        />
      )}

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
