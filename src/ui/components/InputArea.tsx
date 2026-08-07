/**
 * Input area component — renders multi-line input with cursor
 */

import React from "react";
import { Box, Text } from "ink";
import type { AppState } from "../types.js";

interface InputAreaProps {
  lines: string[];
  currentLineIdx: number;
  cursorPos: number;
  cursorVisible: boolean;
  appState: AppState;
}

export const InputArea = React.memo(function InputArea({
  lines,
  currentLineIdx,
  cursorPos,
  cursorVisible,
  appState,
}: InputAreaProps): React.ReactElement {
  const notIdle = appState !== "idle";
  const isMultiLine = lines.length > 1;

  // Limit visible lines to prevent overflow; ensure cursor is visible
  const MAX_VISIBLE = 10;
  let startIdx = 0;
  let endIdx = lines.length;
  if (lines.length > MAX_VISIBLE) {
    // Keep cursor visible: show lines around cursor
    const half = Math.floor(MAX_VISIBLE / 2);
    if (currentLineIdx < half) {
      endIdx = MAX_VISIBLE;
    } else if (currentLineIdx >= lines.length - half) {
      startIdx = lines.length - MAX_VISIBLE;
      endIdx = lines.length;
    } else {
      startIdx = currentLineIdx - half + 1;
      endIdx = startIdx + MAX_VISIBLE;
    }
  }
  const visibleLines = lines.slice(startIdx, endIdx);
  const visibleCurrentIdx = currentLineIdx - startIdx;

  return (
    <Box flexDirection="column" paddingX={0}>
      {startIdx > 0 && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>↑ {startIdx} lines above</Text>
        </Box>
      )}
      {visibleLines.map((line, idx) =>
        renderInputLine(
          line,
          startIdx + idx,
          idx === visibleCurrentIdx,
          isMultiLine,
          idx === visibleCurrentIdx ? cursorPos : 0,
          cursorVisible,
          notIdle
        )
      )}
      {endIdx < lines.length && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>↓ {lines.length - endIdx} lines below</Text>
        </Box>
      )}

      {/* Queued/hint indicator */}
      {notIdle && lines.join("\n").length > 0 && (
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
  );
});

function renderInputLine(
  line: string,
  lineIndex: number,
  isCurrentLine: boolean,
  isMultiLine: boolean,
  cursorPos: number,
  cursorVisible: boolean,
  notIdle: boolean
): React.ReactElement {
  const showCursor = !notIdle && cursorVisible && isCurrentLine;

  let before: string;
  let at: string | undefined;
  let after: string;

  if (isCurrentLine) {
    before = line.slice(0, cursorPos);
    const nextBoundary = nextGraphemeBoundary(line, cursorPos);
    at = cursorPos < line.length ? line.slice(cursorPos, nextBoundary) : undefined;
    after = line.slice(nextBoundary);
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
}

function nextGraphemeBoundary(text: string, position: number): number {
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (segment.index > position) return segment.index;
  }
  return text.length;
}
