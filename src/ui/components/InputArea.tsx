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

  return (
    <Box flexDirection="column" paddingX={0}>
      {lines.map((line, idx) =>
        renderInputLine(line, idx, idx === currentLineIdx, isMultiLine, cursorPos, cursorVisible, notIdle)
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
}
