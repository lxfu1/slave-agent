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

export interface InputPanelProps {
  appState: AppState;
  onSubmit: (text: string) => void;
}

export function InputPanel({ appState, onSubmit }: InputPanelProps) {
  const input = useInputState();
  const [cursorVisible, setCursorVisible] = useState(true);

  const appStateRef = useRef(appState);
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  // Cursor blink — only when idle
  const isActive = appState !== "idle";
  useEffect(() => {
    if (isActive) return;
    const id = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(id);
  }, [isActive]);

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
    // Safe: input refs and setLines are stable (useCallback with [])
  }, [input]);

  // Keyboard input — character editing, cursor, history, submit
  useInput((char, key) => {
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

    // Up/Down: line navigation or command history
    if (key.upArrow) {
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
    if (key.downArrow) {
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

    // Enter: submit or insert newline (with trailing backslash)
    if (key.return) {
      if (appStateRef.current !== "idle") return;

      if (currentLine.endsWith("\\")) {
        if (currentLines.length >= MAX_INPUT_LINES) return;
        const newLines = [...currentLines];
        newLines[lineIdx] = currentLine.slice(0, -1);
        newLines.splice(lineIdx + 1, 0, "");
        input.setLines(newLines, lineIdx + 1, 0);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
      } else {
        const text = input.getInputText();
        if (text.trim()) {
          input.pushHistory(text);
          input.setLines([""], 0, 0);
          onSubmit(text);
        }
      }
      return;
    }

    // Esc: cancel multi-line (merge back to single line)
    if (key.escape) {
      const currentText = input.getInputText();
      if (input.linesRef.current.length > 1) {
        input.setLines([currentText], 0, currentText.length);
        if (input.historyIdxRef.current !== -1) input.historyIdxRef.current = -1;
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
