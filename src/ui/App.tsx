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
 *   ←/→ arrows       — cursor positioning within the input line
 *   ↑/↓ arrows       — command history (up to 50 entries, idle only)
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
import type { SlaveAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import type { PermissionRequest } from "../permissions/guard.js";
import { getContextWindowSize } from "../context/tokenBudget.js";

// ---------------------------------------------------------------------------
// Module-level constants (outside component — not recreated on each render)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** "error" removed — errors surface as notice entries, not a UI mode */
type AppState = "idle" | "streaming" | "tool_running" | "awaiting_permission";

export interface AppProps {
  config: SlaveAgentConfig;
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

  // Both a ref (for useInput callbacks) and a display state (for render).
  const inputRef = useRef("");
  const [inputDisplay, setInputDisplay] = useState("");

  // Same pattern for cursor position.
  const cursorPosRef = useRef(0);
  const [cursorPos, setCursorPos] = useState(0);

  // Command history (ref — doesn't need to drive renders)
  const inputHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);     // -1 = editing current input
  const savedInputRef = useRef("");     // input snapshot before ↑ navigation

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

  // When true, exit() is called after the current render (so the farewell
  // message is visible before the process terminates).
  const [pendingExit, setPendingExit] = useState(false);

  const lastCtrlCAt = useRef(0);
  const entryIdCounter = useRef(0);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Keeps inputRef and display state in sync. */
  const setInput = useCallback((val: string | ((prev: string) => string)) => {
    const next = typeof val === "function" ? val(inputRef.current) : val;
    inputRef.current = next;
    setInputDisplay(next);
  }, []);

  /** Keeps cursorPosRef and display state in sync. */
  const updateCursor = useCallback((pos: number) => {
    cursorPosRef.current = pos;
    setCursorPos(pos);
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
  const isActive = appState === "streaming" || appState === "tool_running" || isWaiting;
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
  // the buffer is empty). 180 ms gives ~5-6 redraws/s — smooth but half the
  // rate of the previous 100 ms spinner approach.
  const [, setBufferTick] = useState(0);
  useEffect(() => {
    if (appState !== "streaming" || isWaiting) return;
    const id = setInterval(() => setBufferTick(n => n + 1), 180);
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

  const submitInput = useCallback(async (userInput: string) => {
    if (!userInput.trim()) return;

    // Push to history
    inputHistoryRef.current.push(userInput);
    if (inputHistoryRef.current.length > MAX_HISTORY) inputHistoryRef.current.shift();
    historyIdxRef.current = -1;

    setInput("");
    updateCursor(0);
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
  }, [engine, handleEngineEvent, streaming, addEntry, setInput, updateCursor, commitEntries]);

  // ---------------------------------------------------------------------------
  // Keyboard input
  // ---------------------------------------------------------------------------

  useInput((char, key) => {
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

    // ── Cursor movement (available in all non-permission states) ──
    if (key.leftArrow) {
      updateCursor(Math.max(0, cursorPosRef.current - 1));
      return;
    }
    if (key.rightArrow) {
      updateCursor(Math.min(inputRef.current.length, cursorPosRef.current + 1));
      return;
    }

    // ── History navigation (idle only) ──
    if (appState === "idle") {
      if (key.upArrow) {
        // Save current input before first history jump
        if (historyIdxRef.current === -1) savedInputRef.current = inputRef.current;
        const nextIdx = historyIdxRef.current + 1;
        const hist = inputHistoryRef.current;
        if (nextIdx < hist.length) {
          historyIdxRef.current = nextIdx;
          const item = hist[hist.length - 1 - nextIdx]!;
          setInput(item);
          updateCursor(item.length);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const hist = inputHistoryRef.current;
          const item = hist[hist.length - 1 - historyIdxRef.current]!;
          setInput(item);
          updateCursor(item.length);
        } else if (historyIdxRef.current === 0) {
          historyIdxRef.current = -1;
          setInput(savedInputRef.current);
          updateCursor(savedInputRef.current.length);
        }
        return;
      }
    }

    // ── Return: submit when idle, ignored when streaming ──
    if (key.return) {
      if (appState === "idle") void submitInput(inputRef.current);
      return;
    }

    // ── Backspace / Delete ──
    //
    // Root cause of the "delete key sometimes doesn't work" bug:
    // Many terminals (macOS Terminal.app, iTerm2) emit key.delete=true for the
    // physical Backspace key depending on TERM / stty settings. The previous
    // implementation treated key.delete as "forward delete" (remove char to the
    // RIGHT of the cursor), which does nothing when the cursor is at the end of
    // the input — the most common position while typing normally.
    //
    // Fix: both key.backspace and key.delete mean "delete the character to the
    // LEFT of the cursor" (backward delete). The distinction between physical
    // Backspace and forward-Delete is not reliably detectable across terminals,
    // so we unify them to the universally expected behaviour.
    if (key.backspace || key.delete) {
      const pos = cursorPosRef.current;
      if (pos > 0) {
        setInput(prev => prev.slice(0, pos - 1) + prev.slice(pos));
        updateCursor(pos - 1);
        if (historyIdxRef.current !== -1) historyIdxRef.current = -1;
      }
      return;
    }

    // ── Character input: accepted during streaming too (queued, not submitted) ──
    if (char && !key.ctrl && !key.meta) {
      const pos = cursorPosRef.current;
      setInput(prev => prev.slice(0, pos) + char + prev.slice(pos));
      // Advance by char.length, not 1: char can be multi-character when the
      // user pastes text or an IME commits a composition in a single event.
      updateCursor(pos + char.length);
      if (historyIdxRef.current !== -1) historyIdxRef.current = -1;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isStreaming = appState === "streaming" || appState === "tool_running";
  const currentBuffer = isStreaming ? streaming.buffer : undefined;
  const spinnerChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
  const notIdle = appState !== "idle";

  // Split input at cursor for rendering
  const inputBefore = inputDisplay.slice(0, cursorPos);
  const inputAt = inputDisplay[cursorPos];      // char under cursor (may be undefined at end)
  const inputAfter = inputDisplay.slice(cursorPos + 1);
  const showCursor = appState === "idle" && cursorVisible;

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

      {/* ── Input line ── */}
      {appState !== "awaiting_permission" && (
        <Box paddingX={1}>
          {/* Prompt glyph dims when not idle to signal queuing mode */}
          <Text color={notIdle ? "gray" : "cyan"}>❯ </Text>

          {/* Text before cursor */}
          <Text color="white">{inputBefore}</Text>

          {/* Character at cursor position (or block cursor at end) */}
          {showCursor ? (
            inputAt !== undefined
              ? <Text inverse>{inputAt}</Text>   // highlight char under cursor
              : <Text color="cyan">▊</Text>       // block at end of input
          ) : (
            inputAt !== undefined
              ? <Text color={notIdle ? "gray" : "white"}>{inputAt}</Text>
              : null
          )}

          {/* Text after cursor */}
          <Text color={notIdle ? "gray" : "white"}>{inputAfter}</Text>

          {/* Queued indicator shown while streaming if input is non-empty */}
          {notIdle && inputRef.current.length > 0 && (
            <Text color="gray" dimColor> (queued)</Text>
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
