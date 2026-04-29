/**
 * Streaming and waiting indicators
 */

import React from "react";
import { Box, Text } from "ink";

interface StreamingIndicatorProps {
  isWaiting: boolean;
  spinnerFrame: number;
  isToolRunning: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function StreamingIndicator({
  isWaiting,
  spinnerFrame,
  isToolRunning,
}: StreamingIndicatorProps): React.ReactElement | null {
  const spinnerChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] as string;

  if (isWaiting) {
    return (
      <Box paddingX={1}>
        <Text color="cyan">{spinnerChar} </Text>
        <Text color="gray">thinking…</Text>
      </Box>
    );
  }

  if (isToolRunning) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">{spinnerChar} </Text>
        <Text color="gray">running tool…</Text>
      </Box>
    );
  }

  return null;
}
