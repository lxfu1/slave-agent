/**
 * Root Ink application component.
 *
 * State machine:
 *   idle              — waiting for user input
 *   streaming         — model is generating a response
 *   tool_running      — a tool is executing
 *   awaiting_permission — permission dialog showing
 *
 * Input capabilities:
 *   ←/→ arrows       — cursor positioning within the current line
 *   ↑/↓ arrows       — navigate between lines (multi-line) or command history (single-line)
 *   Shift+Enter      — insert newline (start multi-line input)
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
  type PermissionDecision,
  type SessionUsage,
} from "../engine/conversationEngine.js";
import {
  MessageEntryItem,
  useStreamingBuffer,
  type MessageEntry,
  type MessageEntryData,
} from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import type { MemoAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import type { PermissionRequest } from "../permissions/guard.js";
import { getContextWindowSize } from "../context/tokenBudget.js";
import { watchConfig } from "../config/loader.js";

// ---------------------------------------------------------------------------
// Module-level constants (outside component — not recreated on each render)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_HISTORY = 50;
const MAX_INPUT_LINES = 20; // Prevent runaway multi-line input

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** "error" removed — errors surface as notice entries, not a UI mode */
type AppState = "idle" | "streaming" | "tool_running" | "awaiting_permission" | "searching";

export interface AppProps {
  config: MemoAgentConfig;
  profileDir: string;
  cwd: string;
  db: Database.Database;
  sessionId: string;
  modelClient: OpenAI;
  auxiliaryClient: OpenAI | null;
  recipes: Recipe[];
  initialMessages?: import("../types/messages.js").ChatMessage[];
  permissionMode?: "ask" | "auto";
  profileName?: string;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const streaming = useStreamingBuffer();

  // Standard lazy initialiser — ConversationEngine constructed once
  const [engine] = useState(() => new ConversationEngine(props));

  // ---------------------------------------------------------------------------
  // Core state
  // ---------------------------------------------------------------------------

  const [appState, setAppState] = useState<AppState>("idle");

  // All entries. Split by committedCount:
  //   entries[0..committedCount-1]  → rendered via <Static> (never re-render)
  //   entries[committedCount..]     → rendered dynamically (current turn)
  const [entries, setEntries] = useState<MessageEntry[]>([]);
  const entriesRef = useRef<MessageEntry[]>([]); // always-current mirror

  const [committedCount, setCommittedCount] = useState(0);

  // Incrementing this key remounts <Static> on /clear so each session starts fresh
  const [clearCount, setClearCount] = useState(0);

  // ---------------------------------------------------------------------------
  // Input state
  // ---------------------------------------------------------------------------

  // Multi-line input: lines array + current line index + cursor position in line.
  // Single-line is a special case: lines = ["content"], currentLineIdx = 0.
  const linesRef = useRef<string[]>([""]);
  const currentLineIdxRef = useRef(0);
  const cursorPosRef = useRef(0); // cursor position within current line

  // Display states (for render)
  const [linesDisplay, setLinesDisplay] = useState<string[]>([""]);
  const [currentLineIdx, setCurrentLineIdx] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);

  // Helper: get full input text (joined lines)
  const getInputText = useCallback((): string => {
    return linesRef.current.join("\n");
  }, []);

  // Helper: set input from history (single-line, flattens to first line)
  const setInputFromHistory = useCallback((text: string) => {
    const lines = text.split("\n");
    linesRef.current = lines;
    currentLineIdxRef.current = 0;
    cursorPosRef.current = lines[0]?.length ?? 0;
    setLinesDisplay([...lines]);
    setCurrentLineIdx(0);
    setCursorPos(cursorPosRef.current);
  }, []);

  /** Keeps lines state and display state in sync. */
  const setLines = useCallback((newLines: string[], newLineIdx?: number, newCursorPos?: number) => {
    linesRef.current = newLines;
    setLinesDisplay([...newLines]);
    if (newLineIdx !== undefined) {
      currentLineIdxRef.current = newLineIdx;
      setCurrentLineIdx(newLineIdx);
    }
    if (newCursorPos !== undefined) {
      cursorPosRef.current = newCursorPos;
      setCursorPos(newCursorPos);
    }
  }, []);

  /** Updates cursor position within current line. */
  const updateCursorInLine = useCallback((pos: number) => {
    cursorPosRef.current = pos;
    setCursorPos(pos);
  }, []);

  /** Updates current line index. */
  const updateCurrentLine = useCallback((idx: number) => {
    currentLineIdxRef.current = idx;
    setCurrentLineIdx(idx);
    // Clamp cursor to line length
    const line = linesRef.current[idx] ?? "";
    if (cursorPosRef.current > line.length) {
      cursorPosRef.current = line.length;
      setCursorPos(line.length);
    }
  }, []);

  // Command history (ref — doesn't need to drive renders)
  const inputHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);     // -1 = editing current input
  const savedInputRef = useRef<string[]>([""]); // input snapshot before ↑ navigation (as lines)

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  const [cursorVisible, setCursorVisible] = useState(true);
  const [isWaiting, setIsWaiting] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [usage, setUsage] = useState<SessionUsage>({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    currentRatio: 0,
    contextWindowSize: getContextWindowSize(props.config.model.name),
  });
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  // Search/filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[]>([]); // indices into entries
  const [currentSearchIdx, setCurrentSearchIdx] = useState(0);
  const searchQueryRef = useRef("");

  // When true, exit() is called after the current render (so the farewell
  // message is visible before the process terminates).
  const [pendingExit, setPendingExit] = useState(false);

  const lastCtrlCAt = useRef(0);
  const entryIdCounter = useRef(0);



  // ---------------------------------------------------------------------------
  // Config hot-reload
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return watchConfig(
      props.profileDir,
      (newConfig) => {
        engine.updateConfig(newConfig);
        addEntry({ kind: "notice", content: "Config reloaded.", level: "info" });
      },
      (err) => {
        addEntry({ kind: "notice", content: `Config reload failed: ${err.message}`, level: "error" });
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Exit after farewell renders
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (pendingExit) exit();
  }, [pendingExit, exit]);

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  // Cursor blinks only when idle — pausing during streaming eliminates ~2
  // extra Ink redraws per second that were caused by the timer firing even
  // though the cursor is not visible in that state.
  const isActive = appState === "streaming" || appState === "tool_running" || isWaiting || appState === "searching";
  useEffect(() => {
    if (isActive) return;
    const id = setInterval(() => setCursorVisible(v => !v), 530);
    return () => clearInterval(id);
  }, [isActive]);

  // ── Spinner: only animate during the "waiting for first token" phase ──────
  // Once text starts arriving the streaming text itself is the visual feedback;
  // animating the spinner at 100 ms adds 10 extra Ink redraws per second for
  // no user-visible benefit and is the primary cause of terminal flickering.
  useEffect(() => {
    if (!isWaiting) return;
    const id = setInterval(() => setSpinnerFrame(f => f + 1), 100);
    return () => clearInterval(id);
  }, [isWaiting]);

  // ── Buffer display tick: drives streaming-text updates ────────────────────
  // Fires only while text is actively streaming (not during tool_running where
  // the buffer is empty). 400 ms ≈ 2.5 redraws/s — still feels live but
  // dramatically reduces the Ink clear+rewrite cycles that cause flickering.
  const [, setBufferTick] = useState(0);
  useEffect(() => {
    if (appState !== "streaming" || isWaiting) return;
    const id = setInterval(() => setBufferTick(n => n + 1), 400);
    return () => clearInterval(id);
  }, [appState, isWaiting]);

  // ---------------------------------------------------------------------------
  // Entry management
  // ---------------------------------------------------------------------------

  const addEntry = useCallback((entry: MessageEntryData) => {
    entryIdCounter.current += 1;
    const withId: MessageEntry = { ...entry, id: String(entryIdCounter.current) };
    entriesRef.current = [...entriesRef.current, withId];
    setEntries(entriesRef.current);
  }, []);

  const updateToolEntry = useCallback((
    toolId: string,
    status: "done" | "error",
    result: string,
  ) => {
    entriesRef.current = entriesRef.current.map(e =>
      e.kind === "tool_call" && e.toolId === toolId
        ? { ...e, status, result }
        : e
    );
    setEntries(entriesRef.current);
  }, []);

  /** Patches the description of a running tool card (fired before execution). */
  const setToolDescription = useCallback((toolId: string, description: string) => {
    entriesRef.current = entriesRef.current.map(e =>
      e.kind === "tool_call" && e.toolId === toolId
        ? { ...e, description }
        : e
    );
    setEntries(entriesRef.current);
  }, []);

  /** Commits all active entries to the Static region after a turn completes. */
  const commitEntries = useCallback(() => {
    setCommittedCount(entriesRef.current.length);
  }, []);

  // ---------------------------------------------------------------------------
  // Engine event handler
  // ---------------------------------------------------------------------------

  const handleEngineEvent = useCallback((event: EngineEvent) => {
    switch (event.type) {
      case "stream_delta":
        streaming.append(event.delta);
        setIsWaiting(false); // first text delta — hide "thinking" spinner
        break;

      case "tool_call_start":
        setAppState("tool_running");
        setIsWaiting(false); // model went straight to a tool call
        addEntry({ kind: "tool_call", name: event.name, toolId: event.id, status: "running" });
        break;

      case "tool_call_description":
        // Fired right before execution with the input summary (e.g. "src/main.ts").
        // Updates the running card so the user sees "⟳ ReadFile  src/main.ts".
        setToolDescription(event.id, event.description);
        break;

      case "tool_result":
        updateToolEntry(event.id, event.isError ? "error" : "done", event.content);
        setAppState("streaming");
        break;

      case "messages_updated": {
        const buffered = streaming.buffer;
        if (buffered) {
          streaming.clear();
          addEntry({ kind: "assistant", content: buffered });
        }
        break;
      }

      case "usage_updated":
        setUsage(event.sessionUsage);
        break;

      case "token_warning":
        addEntry({
          kind: "notice",
          content: `Token usage at ${Math.round(event.ratio * 100)}% — ${
            event.level === "critical" ? "compression triggered" : "consider /compact"
          }`,
          level: event.level === "critical" ? "error" : "info",
        });
        break;

      case "compressed":
        addEntry({
          kind: "separator",
          label: `Context compressed (${event.trigger}) — history in scroll buffer`,
        });
        break;

      case "command_output":
        addEntry({
          kind: "notice",
          content: event.message,
          level: event.kind === "error" ? "error" : event.kind === "help" ? "help" : "info",
        });
        break;

      case "session_cleared":
        // Commit current entries so they enter the terminal scroll buffer,
        // then remount <Static> so the new session starts from a clean slate.
        commitEntries();
        setClearCount(c => c + 1);
        entriesRef.current = [];
        setEntries([]);
        setCommittedCount(0);
        streaming.clear();
        addEntry({ kind: "notice", content: "Session cleared. Memory is preserved.", level: "info" });
        break;

      case "notes_shown":
        addEntry({ kind: "notice", content: event.content, level: "info" });
        break;

      case "notes_cleared":
        addEntry({ kind: "notice", content: "NOTES.md cleared.", level: "success" });
        break;

      case "permission_request":
        setPendingPermission(event.request);
        setAppState("awaiting_permission");
        break;

      case "injection_warning":
        addEntry({
          kind: "notice",
          content: `Warning: potential prompt injection in ${event.source} — content skipped`,
          level: "error",
        });
        break;

      case "error":
        addEntry({
          kind: "notice",
          content: `Error [${event.code}]: ${event.message}`,
          level: "error",
        });
        setAppState("idle");
        break;

      case "exit_requested":
        addEntry({ kind: "notice", content: "Goodbye! Session saved.", level: "success" });
        setPendingExit(true);
        break;
    }
  }, [streaming, addEntry, updateToolEntry, setToolDescription, commitEntries]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const submitInput = useCallback(async () => {
    const userInput = getInputText();
    if (!userInput.trim()) return;

    // Push to history (as single joined string)
    inputHistoryRef.current.push(userInput);
    if (inputHistoryRef.current.length > MAX_HISTORY) inputHistoryRef.current.shift();
    historyIdxRef.current = -1;

    // Reset input state
    setLines([""], 0, 0);
    addEntry({ kind: "user", content: userInput });
    setAppState("streaming");
    setIsWaiting(true);
    streaming.clear();

    try {
      for await (const event of engine.submitMessage(userInput)) {
        handleEngineEvent(event);
      }
      // Flush any remaining streaming content
      const remaining = streaming.buffer;
      if (remaining) {
        streaming.clear();
        addEntry({ kind: "assistant", content: remaining });
      }
    } catch (err) {
      addEntry({
        kind: "notice",
        content: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        level: "error",
      });
    } finally {
      // Move this turn's entries into the Static region
      commitEntries();
      setAppState("idle");
      setIsWaiting(false);
      setPendingPermission(null);
    }
  }, [engine, handleEngineEvent, streaming, addEntry, setLines, updateCursorInLine, updateCurrentLine, getInputText, commitEntries]);

  // ---------------------------------------------------------------------------
  // Search functionality
  // ---------------------------------------------------------------------------

  const performSearch = useCallback((query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setCurrentSearchIdx(0);
      return;
    }
    
    const results: number[] = [];
    const lowerQuery = query.toLowerCase();
    
    entriesRef.current.forEach((entry, idx) => {
      let text = "";
      switch (entry.kind) {
        case "user":
        case "assistant":
          text = entry.content;
          break;
        case "tool_call":
          text = `${entry.name} ${entry.description ?? ""} ${entry.result ?? ""}`;
          break;
        case "notice":
          text = entry.content;
          break;
        case "separator":
          text = entry.label;
          break;
      }
      
      if (text.toLowerCase().includes(lowerQuery)) {
        results.push(idx);
      }
    });
    
    setSearchResults(results);
    setCurrentSearchIdx(results.length > 0 ? 0 : -1);
  }, []);

  const exitSearch = useCallback(() => {
    setAppState("idle");
    setSearchQuery("");
    searchQueryRef.current = "";
    setSearchResults([]);
    setCurrentSearchIdx(0);
  }, []);

  const nextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    setCurrentSearchIdx((prev) => (prev + 1) % searchResults.length);
  }, [searchResults.length]);

  const prevSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    setCurrentSearchIdx((prev) => (prev - 1 + searchResults.length) % searchResults.length);
  }, [searchResults.length]);

  // ---------------------------------------------------------------------------
  // Keyboard input
  // ---------------------------------------------------------------------------

  useInput((char, key) => {
    // ── Search mode ──
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
        prevSearchResult();
        return;
      }
      if (key.downArrow || (key.ctrl && char === "n")) {
        nextSearchResult();
        return;
      }
      if (key.backspace || key.delete) {
        const newQuery = searchQueryRef.current.slice(0, -1);
        searchQueryRef.current = newQuery;
        setSearchQuery(newQuery);
        performSearch(newQuery);
        return;
      }
      // Type search query
      if (char && !key.ctrl && !key.meta) {
        const newQuery = searchQueryRef.current + char;
        searchQueryRef.current = newQuery;
        setSearchQuery(newQuery);
        performSearch(newQuery);
      }
      return;
    }

    // ── Permission dialog ──
    if (appState === "awaiting_permission" && pendingPermission) {
      handlePermissionInput(char, key, pendingPermission, engine, setPendingPermission, setAppState);
      return;
    }

    // ── Ctrl+C ──
    if (key.ctrl && char === "c") {
      const now = Date.now();
      if (appState === "streaming" || appState === "tool_running") {
        // Flush partial response before aborting so it's not silently lost
        const partial = streaming.buffer;
        streaming.clear();
        if (partial) addEntry({ kind: "assistant", content: partial + " [interrupted]" });
        engine.interrupt();
        commitEntries();
        setAppState("idle");
        setIsWaiting(false);
        return;
      }
      if (now - lastCtrlCAt.current < 2_000) {
        exit();
        return;
      }
      lastCtrlCAt.current = now;
      addEntry({ kind: "notice", content: "Press Ctrl+C again to exit", level: "info" });
      return;
    }

    // ── Ctrl+F: enter search mode ──
    if (key.ctrl && char === "f") {
      if (appState === "idle") {
        setAppState("searching");
        searchQueryRef.current = "";
        setSearchQuery("");
        performSearch("");
      }
      return;
    }

    // ── Esc: cancel multi-line input (reset to single line) ──
    if (key.escape && appState === "idle") {
      const currentText = getInputText();
      if (linesRef.current.length > 1) {
        // Reset to single line with all content joined
        setLines([currentText], 0, currentText.length);
        if (historyIdxRef.current !== -1) historyIdxRef.current = -1;
      }
      return;
    }

    const currentLines = linesRef.current;
    const lineIdx = currentLineIdxRef.current;
    const currentLine = currentLines[lineIdx] ?? "";
    const pos = cursorPosRef.current;

    // ── Cursor horizontal movement ──
    if (key.leftArrow) {
      if (pos > 0) {
        updateCursorInLine(pos - 1);
      } else if (lineIdx > 0) {
        // Move to end of previous line
        const prevLine = currentLines[lineIdx - 1] ?? "";
        updateCurrentLine(lineIdx - 1);
        updateCursorInLine(prevLine.length);
      }
      return;
    }
    if (key.rightArrow) {
      if (pos < currentLine.length) {
        updateCursorInLine(pos + 1);
      } else if (lineIdx < currentLines.length - 1) {
        // Move to start of next line
        updateCurrentLine(lineIdx + 1);
        updateCursorInLine(0);
      }
      return;
    }

    // ── Up/Down: line navigation in multi-line, history in single-line ──
    if (appState === "idle" && key.upArrow) {
      if (currentLines.length > 1 && lineIdx > 0) {
        // Multi-line: move to previous line
        const prevLine = currentLines[lineIdx - 1] ?? "";
        const newPos = Math.min(pos, prevLine.length);
        updateCurrentLine(lineIdx - 1);
        updateCursorInLine(newPos);
      } else if (currentLines.length === 1) {
        // Single-line: history navigation
        if (historyIdxRef.current === -1) savedInputRef.current = [...linesRef.current];
        const nextIdx = historyIdxRef.current + 1;
        const hist = inputHistoryRef.current;
        if (nextIdx < hist.length) {
          historyIdxRef.current = nextIdx;
          const item = hist[hist.length - 1 - nextIdx]!;
          setInputFromHistory(item);
        }
      }
      return;
    }
    if (appState === "idle" && key.downArrow) {
      if (currentLines.length > 1 && lineIdx < currentLines.length - 1) {
        // Multi-line: move to next line
        const nextLine = currentLines[lineIdx + 1] ?? "";
        const newPos = Math.min(pos, nextLine.length);
        updateCurrentLine(lineIdx + 1);
        updateCursorInLine(newPos);
      } else if (currentLines.length === 1 && historyIdxRef.current >= 0) {
        // Single-line: history navigation
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const hist = inputHistoryRef.current;
          const item = hist[hist.length - 1 - historyIdxRef.current]!;
          setInputFromHistory(item);
        } else if (historyIdxRef.current === 0) {
          historyIdxRef.current = -1;
          const saved = savedInputRef.current;
          setLines([...saved], 0, saved[0]?.length ?? 0);
        }
      }
      return;
    }

    // ── Return: submit or insert newline ──
    if (key.return) {
      if (appState !== "idle") return; // ignore when streaming

      if (key.shift) {
        // Shift+Enter: insert newline (if under max lines)
        if (currentLines.length >= MAX_INPUT_LINES) return;

        const before = currentLine.slice(0, pos);
        const after = currentLine.slice(pos);
        const newLines = [...currentLines];
        newLines[lineIdx] = before;
        newLines.splice(lineIdx + 1, 0, after);
        setLines(newLines, lineIdx + 1, 0);
        if (historyIdxRef.current !== -1) historyIdxRef.current = -1;
      } else {
        // Normal Enter: submit
        void submitInput();
      }
      return;
    }

    // ── Backspace / Delete ──
    if (key.backspace || key.delete) {
      if (pos > 0) {
        // Delete character before cursor in current line
        const newLine = currentLine.slice(0, pos - 1) + currentLine.slice(pos);
        const newLines = [...currentLines];
        newLines[lineIdx] = newLine;
        setLines(newLines, lineIdx, pos - 1);
      } else if (lineIdx > 0) {
        // At start of line: merge with previous line
        const prevLine = currentLines[lineIdx - 1] ?? "";
        const newLines = [...currentLines];
        newLines[lineIdx - 1] = prevLine + currentLine;
        newLines.splice(lineIdx, 1);
        setLines(newLines, lineIdx - 1, prevLine.length);
      }
      if (historyIdxRef.current !== -1) historyIdxRef.current = -1;
      return;
    }

    // ── Character input ──
    if (char && !key.ctrl && !key.meta) {
      const charLen = char.length;
      const newLine = currentLine.slice(0, pos) + char + currentLine.slice(pos);
      const newLines = [...currentLines];
      newLines[lineIdx] = newLine;
      setLines(newLines, lineIdx, pos + charLen);
      if (historyIdxRef.current !== -1) historyIdxRef.current = -1;
    }
  });

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  // Render a single input line with cursor handling
  const renderInputLine = (
    line: string,
    lineIndex: number,
    isCurrentLine: boolean,
    isMultiLine: boolean
  ): React.ReactElement => {
    const showCursor = appState === "idle" && cursorVisible && isCurrentLine;
    const notIdle = appState !== "idle";

    let before: string;
    let at: string | undefined;
    let after: string;

    if (isCurrentLine) {
      before = line.slice(0, cursorPos);
      at = line[cursorPos];
      after = line.slice(cursorPos + 1);
    } else {
      before = line;
      at = undefined;
      after = "";
    }

    // For multi-line: show "│" prefix for continuation lines, "❯" for first line
    const prompt = isMultiLine
      ? lineIndex === 0
        ? "❯ "
        : "│ "
      : "❯ ";

    return (
      <Box key={lineIndex}>
        <Text color={notIdle ? "gray" : "cyan"}>{prompt}</Text>
        <Text color="white">{before}</Text>
        {showCursor ? (
          at !== undefined ? (
            <Text inverse>{at}</Text>
          ) : (
            <Text color="cyan">▊</Text>
          )
        ) : at !== undefined ? (
          <Text color={notIdle ? "gray" : "white"}>{at}</Text>
        ) : null}
        <Text color={notIdle ? "gray" : "white"}>{after}</Text>
      </Box>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isStreaming = appState === "streaming" || appState === "tool_running";
  const currentBuffer = isStreaming ? streaming.buffer : undefined;
  const spinnerChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
  const notIdle = appState !== "idle";
  const isMultiLine = linesDisplay.length > 1;

  return (
    <Box flexDirection="column" height="100%">
      {/* ── Committed entries — rendered once, live in terminal scroll buffer ── */}
      <Static key={clearCount} items={entries.slice(0, committedCount)}>
        {(entry) => (
          <Box key={entry.id}>
            <MessageEntryItem entry={entry} />
          </Box>
        )}
      </Static>

      {/* ── Active entries for the current turn ── */}
      <Box flexDirection="column">
        {entries.slice(committedCount).map(entry => (
          <MessageEntryItem key={entry.id} entry={entry} />
        ))}

        {/* Streaming buffer shown inline below active entries */}
        {currentBuffer && (
          <Box paddingX={1}>
            <Text color="white">{currentBuffer}</Text>
            <Text color="cyan">▊</Text>
          </Box>
        )}
      </Box>

      {/* ── Status indicators ── */}
      {isWaiting && (
        <Box paddingX={1}>
          <Text color="cyan">{spinnerChar} </Text>
          <Text color="gray">thinking…</Text>
        </Box>
      )}
      {appState === "tool_running" && !isWaiting && (
        <Box paddingX={1}>
          <Text color="yellow">{spinnerChar} </Text>
          <Text color="gray">running tool…</Text>
        </Box>
      )}

      {/* ── Permission dialog ── */}
      {appState === "awaiting_permission" && pendingPermission && (
        <PermissionDialog request={pendingPermission} />
      )}

      {/* ── Search results + bar ── */}
      {appState === "searching" && (
        <>
          <SearchResultsPanel
            entries={entries}
            query={searchQuery}
            matchedIndices={searchResults}
            currentIdx={currentSearchIdx}
          />
          <SearchBar
            query={searchQuery}
            results={searchResults}
            currentIdx={currentSearchIdx}
          />
        </>
      )}

      {/* ── Multi-line input area ── */}
      {appState !== "awaiting_permission" && appState !== "searching" && (
        <Box flexDirection="column" paddingX={0}>
          {linesDisplay.map((line, idx) =>
            renderInputLine(line, idx, idx === currentLineIdx, isMultiLine)
          )}

          {/* Queued/hint indicator */}
          {notIdle && getInputText().length > 0 && (
            <Box paddingX={1}>
              <Text color="gray" dimColor>
                {isMultiLine ? "(multi-line queued)" : "(queued)"}
              </Text>
            </Box>
          )}

          {/* Multi-line help hints (only in idle multi-line mode) */}
          {appState === "idle" && isMultiLine && (
            <Box paddingX={1}>
              <Text color="gray" dimColor>
                Shift+Enter newline • Enter submit • Esc cancel
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* ── Status bar ── */}
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

// ---------------------------------------------------------------------------
// Permission dialog
// ---------------------------------------------------------------------------

function PermissionDialog({ request }: { request: PermissionRequest }): React.ReactElement {
  const riskColor =
    request.riskLevel === "high" ? "red" :
    request.riskLevel === "medium" ? "yellow" : "gray";

  return (
    <Box
      paddingX={1}
      paddingY={0}
      borderStyle="round"
      borderColor={riskColor}
      flexDirection="column"
    >
      <Text color={riskColor} bold>Permission required [{request.riskLevel} risk]</Text>
      <Text color="white">{request.summary}</Text>
      <Text color="gray">  [y/Enter] Allow once  [a] Allow always  [n] Deny</Text>
    </Box>
  );
}

function handlePermissionInput(
  char: string,
  key: import("ink").Key,
  request: PermissionRequest,
  engine: ConversationEngine,
  setPendingPermission: (r: PermissionRequest | null) => void,
  setAppState: (s: AppState) => void,
): void {
  const c = char.toLowerCase();
  let decision: PermissionDecision | null = null;

  if (c === "y" || key.return) decision = "allow_once";
  else if (c === "a") decision = "allow_always";
  else if (c === "n") decision = "deny";

  if (decision) {
    engine.resolvePermission(request.id, decision);
    setPendingPermission(null);
    setAppState("streaming");
  }
}

// ---------------------------------------------------------------------------
// Search bar component
// ---------------------------------------------------------------------------

function SearchBar({
  query,
  results,
  currentIdx,
}: {
  query: string;
  results: number[];
  currentIdx: number;
}): React.ReactElement {
  const hasResults = results.length > 0;
  const statusColor = hasResults ? "green" : "gray";
  const statusText = hasResults
    ? `${currentIdx + 1}/${results.length}`
    : "no results";

  return (
    <Box paddingX={1} borderStyle="single" borderColor="cyan" flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>/filter </Text>
        <Text color="white">{query}</Text>
        <Text color="cyan">▊</Text>
      </Box>
      <Box flexDirection="row" gap={2}>
        <Text color={statusColor}>{statusText}</Text>
        <Text color="gray" dimColor>↑/↓ nav • Enter exit • Esc clear</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Search results panel
// ---------------------------------------------------------------------------

function getEntryDisplayText(entry: MessageEntry): string {
  switch (entry.kind) {
    case "user":
    case "assistant":
      return entry.content;
    case "tool_call":
      return `${entry.name} ${entry.description ?? ""} ${entry.result ?? ""}`.trim();
    case "notice":
      return entry.content;
    case "separator":
      return entry.label;
  }
}

function getSnippet(text: string, query: string, maxLen = 120): string {
  if (!query.trim()) return text.slice(0, maxLen);
  const lc = text.toLowerCase();
  const idx = lc.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function TextWithHighlight({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!query.trim()) return <Text color="white">{text}</Text>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} bold color="black" backgroundColor="yellow">{part}</Text>
        ) : (
          <Text key={i} color="white">{part}</Text>
        )
      )}
    </>
  );
}

function SearchResultsPanel({
  entries,
  query,
  matchedIndices,
  currentIdx,
}: {
  entries: MessageEntry[];
  query: string;
  matchedIndices: number[];
  currentIdx: number;
}): React.ReactElement {
  if (matchedIndices.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray" dimColor>No matches found</Text>
      </Box>
    );
  }

  const VISIBLE = 5;
  const start = Math.max(0, currentIdx - 2);
  const end = Math.min(matchedIndices.length, start + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      {matchedIndices.slice(start, end).map((entryIdx, slicePos) => {
        const absPos = start + slicePos;
        const isCurrent = absPos === currentIdx;
        const entry = entries[entryIdx]!;
        const fullText = getEntryDisplayText(entry);
        const snippet = getSnippet(fullText, query);
        const kindLabel = entry.kind === "tool_call" ? entry.name : entry.kind;

        return (
          <Box key={entryIdx} flexDirection="row" gap={1}>
            <Text color={isCurrent ? "cyan" : "gray"}>{isCurrent ? "▶" : " "}</Text>
            <Text color="gray" dimColor>{`[${kindLabel}]`}</Text>
            {isCurrent ? (
              <TextWithHighlight text={snippet} query={query} />
            ) : (
              <Text color="gray">{snippet}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
