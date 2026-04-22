import React from "react";
import { Box, Text } from "ink";
import type { SessionUsage } from "../engine/conversationEngine.js";

interface StatusBarProps {
  model: string;
  mode: "ask" | "auto";
  profile: string;
  usage: SessionUsage;
  isStreaming: boolean;
}

export function StatusBar({ model, mode, profile, usage, isStreaming }: StatusBarProps): React.ReactElement {
  const { totalInputTokens, totalOutputTokens, currentRatio, contextWindowSize } = usage;

  // Use actual API token counts when available (requires stream_options.include_usage).
  // Fall back to estimated tokens derived from the context-usage ratio so the
  // status bar always shows a meaningful number even with APIs that don't
  // return usage data in streaming responses.
  const actualTokens = totalInputTokens + totalOutputTokens;
  const estimatedTokens = contextWindowSize > 0 ? Math.round(currentRatio * contextWindowSize) : 0;
  const displayTokens = actualTokens > 0 ? actualTokens : estimatedTokens;

  // Determine color based on ratio
  const tokenColor = currentRatio >= 0.85 ? "red" : currentRatio >= 0.70 ? "yellow" : "green";

  const contextStr = contextWindowSize > 0
    ? `${displayTokens.toLocaleString()}/${(contextWindowSize / 1000).toFixed(0)}k`
    : `${displayTokens.toLocaleString()}`;

  const ratioStr = contextWindowSize > 0
    ? ` (${Math.round(currentRatio * 100)}%)`
    : "";

  const statusIndicator = isStreaming ? "●" : "○";

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
        <Text color="white">{model.length > 20 ? model.slice(0, 20) + "…" : model}</Text>
      </Box>

      <Box gap={1}>
        <Text color="gray">tokens:</Text>
        <Text color={tokenColor}>{contextStr}{ratioStr}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">${usage.estimatedCostUsd.toFixed(4)}</Text>
        <Text color="gray">│</Text>
        <Text color={mode === "auto" ? "yellow" : "gray"}>mode:{mode}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">profile:{profile}</Text>
      </Box>
    </Box>
  );
}
