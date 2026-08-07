import React from "react";
import { Box, Text, useStdout } from "ink";
import type { SessionUsage } from "../engine/conversationEngine.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

interface StatusBarProps {
  model: string;
  mode: "ask" | "auto";
  profile: string;
  usage: SessionUsage;
  isStreaming: boolean;
}

export const StatusBar = React.memo(function StatusBar({ model, mode, profile, usage, isStreaming }: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const { totalInputTokens, totalOutputTokens, currentRatio, contextWindowSize } = usage;

  // The bar represents the current context, not cumulative billed tokens.
  // Cumulative usage remains available through /cost.
  const actualTokens = totalInputTokens + totalOutputTokens;
  const estimatedTokens = contextWindowSize > 0 ? Math.round(currentRatio * contextWindowSize) : 0;
  const displayTokens = contextWindowSize > 0 ? estimatedTokens : actualTokens;

  // Determine color based on ratio
  const tokenColor = currentRatio >= 0.85 ? "red" : currentRatio >= 0.70 ? "yellow" : "green";

  const contextStr = contextWindowSize > 0
    ? `${displayTokens.toLocaleString()}/${(contextWindowSize / 1000).toFixed(0)}k`
    : `${displayTokens.toLocaleString()}`;

  const ratioStr = contextWindowSize > 0
    ? ` (${Math.round(currentRatio * 100)}%)`
    : "";

  const statusIndicator = isStreaming ? "●" : "○";
  const safeModel = sanitizeTerminalText(model);
  const safeProfile = sanitizeTerminalText(profile);

  if (columns < 110) {
    const compactModel = safeModel.length > 18 ? safeModel.slice(0, 17) + "…" : safeModel;
    const compactTokens = contextWindowSize > 0
      ? `${formatCompactNumber(displayTokens)}/${formatCompactNumber(contextWindowSize)} ${Math.round(currentRatio * 100)}%`
      : formatCompactNumber(displayTokens);

    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text color={isStreaming ? "cyan" : "gray"}>{statusIndicator}</Text>
          <Text color="gray">memo</Text>
          <Text color="white">{compactModel}</Text>
        </Box>
        <Box gap={1}>
          <Text color={tokenColor}>{compactTokens}</Text>
          {columns >= 64 && <Text color="gray">${usage.estimatedCostUsd.toFixed(4)}</Text>}
          <Text color={mode === "auto" ? "yellow" : "gray"}>{mode}</Text>
          {columns >= 88 && <Text color="gray">{safeProfile.slice(0, 18)}</Text>}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={1}>
        <Text color={isStreaming ? "cyan" : "gray"}>{statusIndicator}</Text>
        <Text color="gray">memo-agent</Text>
        <Text color="gray">│</Text>
        <Text color="white">{safeModel.length > 20 ? safeModel.slice(0, 20) + "…" : safeModel}</Text>
      </Box>

      <Box gap={1}>
        <Text color="gray">tokens:</Text>
        <Text color={tokenColor}>{contextStr}{ratioStr}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">${usage.estimatedCostUsd.toFixed(4)}</Text>
        <Text color="gray">│</Text>
        <Text color={mode === "auto" ? "yellow" : "gray"}>mode:{mode}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">profile:{safeProfile}</Text>
      </Box>
    </Box>
  );
});

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
