/**
 * InputPanel — self-contained input component.
 *
 * Owns all input state, keyboard handling, cursor blink, and Shift+Enter
 * support. Keystroke re-renders are isolated to this subtree so that the
 * rest of the App (message list, StatusBar, streaming indicator) does not
 * re-render on every keypress.
 */

import { useEffect, useRef, useState } from "react";
import { useInput } from "ink";
import { useInputState, MAX_INPUT_LINES } from "../useInputState.js";
import { InputArea } from "./InputArea.js";
import type { AppState } from "../types.js";
import { sanitizeTerminalText } from "../sanitizeTerminalText.js";

export interface InputPanelProps {
  appState: AppState;
  onSubmit: (text: string) => void;
}

// ---------------------------------------------------------------
// Paste detection constants
// ---------------------------------------------------------------
// A short timeout replaces setImmediate so that paste data arriving
// across *multiple* stdin chunks is still caught (chunks may be
// delivered 0.5–5 ms apart).  10 ms is below human perception
// threshold while comfortably spanning chunk boundaries.
const PASTE_GAP_MS = 10;

export function InputPanel({ appState, onSubmit }: InputPanelProps) {
  const input = useInputState();
  const [cursorVisible, setCursorVisible] = useState(true);

  const appStateRef = useRef(appState);
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  // ---------------------------------------------------------------
  // Paste detection state
  // ---------------------------------------------------------------
  // When a plain Enter arrives we start a short timer instead of
  // submitting immediately.  If another key event arrives before the
  // timer fires we cancel it and treat the Enter as a paste newline.
  // Once inside a paste burst consecutive Enters are inserted as
  // newlines without further timers.

  const deferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inPasteBurstRef = useRef(false);
  const pasteBurstResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetPasteBurstSoon = () => {
    if (pasteBurstResetRef.current !== null) clearTimeout(pasteBurstResetRef.current);
    pasteBurstResetRef.current = setTimeout(() => {
      pasteBurstResetRef.current = null;
      inPasteBurstRef.current = false;
    }, PASTE_GAP_MS);
  };

  // Cursor blink — only when idle
  const isActive = appState !== "idle";
  useEffect(() => {
    if (isActive) return;
    const id = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(id);
  }, [isActive]);

  // -------------------------------------------------------------------
  // Helper — insert a literal newline at the current cursor position
  // -------------------------------------------------------------------

  const insertNewline = () => {
    const ls = input.linesRef.current;
    if (ls.length >= MAX_INPUT_LINES) return;

    const idx = input.currentLineIdxRef.current;
    const line = ls[idx] ?? "";
    const p = input.cursorPosRef.current;
    const before = line.slice(0, p);
    const after = line.slice(p);
    const newLines = [...ls];
    newLines[idx] = before;
    newLines.splice(idx + 1, 0, after);
    input.setLines(newLines, idx + 1, 0);
    input.historyIdxRef.current = -1;
  };

  // -------------------------------------------------------------------
  // Keyboard input — character editing, cursor, history, submit
  // -------------------------------------------------------------------

  useInput((char, key) => {
    if (appStateRef.current === "searching" || appStateRef.current === "awaiting_permission") return;
    if (inPasteBurstRef.current) resetPasteBurstSoon();
    // ---------------------------------------------------------------
    // 1.  Cancel any pending Enter timer — the fact that THIS event
    //     arrived means the previous Enter was from a paste burst.
    // ---------------------------------------------------------------
    if (deferTimerRef.current !== null) {
      clearTimeout(deferTimerRef.current);
      deferTimerRef.current = null;
      // The Enter we just cancelled was a paste newline → insert it now
      insertNewline();
      inPasteBurstRef.current = true;
      resetPasteBurstSoon();

      // Now handle the current event.  If it's ALSO an Enter, insert
      // a second newline and return.
      if (key.return) {
        insertNewline();
        // stay in paste burst for potential further Enters
        return;
      }

      // Character input: fall through to the normal handler below.
    }

    const currentLines = input.linesRef.current;
    const lineIdx = input.currentLineIdxRef.current;
    const currentLine = currentLines[lineIdx] ?? "";
    const pos = input.cursorPosRef.current;

    // Cursor horizontal movement
    if (key.leftArrow) {
      if (pos > 0) {
        input.updateCursorInLine(previousGraphemeBoundary(currentLine, pos));
      } else if (lineIdx > 0) {
        const prevLine = currentLines[lineIdx - 1] ?? "";
        input.updateCurrentLine(lineIdx - 1);
        input.updateCursorInLine(prevLine.length);
      }
      inPasteBurstRef.current = false;
      return;
    }
    if (key.rightArrow) {
      if (pos < currentLine.length) {
        input.updateCursorInLine(nextGraphemeBoundary(currentLine, pos));
      } else if (lineIdx < currentLines.length - 1) {
        input.updateCurrentLine(lineIdx + 1);
        input.updateCursorInLine(0);
      }
      inPasteBurstRef.current = false;
      return;
    }

    // Up/Down: line navigation or command history
    if (key.upArrow) {
      inPasteBurstRef.current = false;
      if (currentLines.length > 1 && lineIdx > 0) {
        const prevLine = currentLines[lineIdx - 1] ?? "";
        const newPos = graphemeBoundaryAtOrBefore(prevLine, Math.min(pos, prevLine.length));
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
    if (key.downArrow) {
      inPasteBurstRef.current = false;
      if (currentLines.length > 1 && lineIdx < currentLines.length - 1) {
        const nextLine = currentLines[lineIdx + 1] ?? "";
        const newPos = graphemeBoundaryAtOrBefore(nextLine, Math.min(pos, nextLine.length));
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

    // -------------------------------------------------------------
    // Enter / Return
    // -------------------------------------------------------------
    if (key.return) {
      if (appStateRef.current !== "idle") return;

      // Shift+Enter (Kitty Keyboard Protocol) — explicit newline
      if (key.shift) {
        insertNewline();
        return;
      }

      // Backslash-newline — explicit continuation
      if (currentLine.endsWith("\\")) {
        if (currentLines.length >= MAX_INPUT_LINES) return;
        const newLines = [...currentLines];
        newLines[lineIdx] = currentLine.slice(0, -1);
        newLines.splice(lineIdx + 1, 0, "");
        input.setLines(newLines, lineIdx + 1, 0);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
        inPasteBurstRef.current = false;
        return;
      }

      // Already inside a paste burst → immediate newline, no timer
      if (inPasteBurstRef.current) {
        insertNewline();
        return;
      }

      // Plain Enter — start a short timer.  If another key event
      // arrives before it fires the Enter was part of a paste and
      // will be cancelled + converted to a newline above.
      deferTimerRef.current = setTimeout(() => {
        deferTimerRef.current = null;
        inPasteBurstRef.current = false;

        // No follow-up input → genuine Enter → submit
        const text = input.getInputText();
        if (text.trim()) {
          input.pushHistory(text);
          input.setLines([""], 0, 0);
          onSubmit(text);
        }
      }, PASTE_GAP_MS);
      return;
    }

    // Esc: cancel multi-line (merge back to single line)
    if (key.escape) {
      const currentText = input.getInputText();
      if (input.linesRef.current.length > 1) {
        input.setLines([currentText], 0, currentText.length);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
      }
      inPasteBurstRef.current = false;
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      inPasteBurstRef.current = false;
      if (pos > 0) {
        const previousPos = previousGraphemeBoundary(currentLine, pos);
        const newLine = currentLine.slice(0, previousPos) + currentLine.slice(pos);
        const newLines = [...currentLines];
        newLines[lineIdx] = newLine;
        input.setLines(newLines, lineIdx, previousPos);
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

    // Character input (handles both single keystrokes AND multi-char pastes)
    if (char && !key.ctrl && !key.meta && !/^\[[\d;]*[A-Za-z~]$/.test(char)) {
      // Strip bracketed-paste markers (Ink may have already stripped
      // the leading \x1b, so match both forms).
      const clean = sanitizeTerminalText(
        char
          .replace(/\x1b\[200~/g, "")
          .replace(/\x1b\[201~/g, "")
          .replace(/\[200~/g, "")
          .replace(/\[201~/g, ""),
      );

      if (clean.includes("\n")) {
        // ── multi-line paste (bracketed-paste terminal) ──────────
        const normalized = clean.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const pasteLines = normalized.split("\n");

        // Split current line at cursor; the first paste line prepends
        // to "before", the last paste line appends to "after".
        const before = currentLine.slice(0, pos);
        const after = currentLine.slice(pos);
        pasteLines[0] = before + (pasteLines[0] ?? "");
        const lastIdx = pasteLines.length - 1;
        pasteLines[lastIdx] = (pasteLines[lastIdx] ?? "") + after;

        const newLines = [...currentLines];
        newLines.splice(lineIdx, 1, ...pasteLines);
        const capped = newLines.slice(0, MAX_INPUT_LINES);
        const finalIdx = Math.min(lineIdx + pasteLines.length - 1, MAX_INPUT_LINES - 1);
        const finalLine = capped[finalIdx] ?? "";
        const cursorCol =
          finalIdx === lineIdx + pasteLines.length - 1
            ? finalLine.length - after.length
            : finalLine.length;

        input.setLines(capped, finalIdx, cursorCol);
        input.historyIdxRef.current = -1;
      } else {
        // Single character (or single-line paste without newlines)
        const charLen = clean.length;
        const newLine = currentLine.slice(0, pos) + clean + currentLine.slice(pos);
        const newLines = [...currentLines];
        newLines[lineIdx] = newLine;
        input.setLines(newLines, lineIdx, pos + charLen);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
      }
    }
  });

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (deferTimerRef.current !== null) clearTimeout(deferTimerRef.current);
      if (pasteBurstResetRef.current !== null) clearTimeout(pasteBurstResetRef.current);
    };
  }, []);

  if (appState === "awaiting_permission" || appState === "searching") return null;

  return (
    <InputArea
      lines={input.linesDisplay}
      currentLineIdx={input.currentLineIdx}
      cursorPos={input.cursorPos}
      cursorVisible={cursorVisible}
      appState={appState}
    />
  );
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    segment => segment.index,
  );
  boundaries.push(text.length);
  return boundaries;
}

function previousGraphemeBoundary(text: string, position: number): number {
  const boundaries = graphemeBoundaries(text);
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const boundary = boundaries[i] as number;
    if (boundary < position) return boundary;
  }
  return 0;
}

function nextGraphemeBoundary(text: string, position: number): number {
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary > position) return boundary;
  }
  return text.length;
}

function graphemeBoundaryAtOrBefore(text: string, position: number): number {
  let result = 0;
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary > position) break;
    result = boundary;
  }
  return result;
}
