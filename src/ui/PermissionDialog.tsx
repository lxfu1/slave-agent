import React from "react";
import { Box, Text } from "ink";
import type { ConversationEngine, PermissionDecision } from "../engine/conversationEngine.js";
import type { PermissionRequest } from "../permissions/guard.js";
import type { AppState } from "./types.js";
import type { Key } from "ink";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

// ---------------------------------------------------------------------------
// PermissionDialog
// ---------------------------------------------------------------------------

export function PermissionDialog({ request }: { request: PermissionRequest }): React.ReactElement {
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
      <Text color="white">{sanitizeTerminalText(request.summary)}</Text>
      <Text color="gray">
        {request.riskLevel === "high"
          ? "  [y] Allow once  [n/Enter] Deny"
          : "  [y/Enter] Allow once  [a] Allow always  [n] Deny"}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Permission key handler
// ---------------------------------------------------------------------------

export function handlePermissionInput(
  char: string,
  key: Key,
  request: PermissionRequest,
  engine: ConversationEngine,
  setPendingPermission: (r: PermissionRequest | null) => void,
  setAppState: (s: AppState) => void,
): void {
  const c = char.toLowerCase();
  let decision: PermissionDecision | null = null;

  if (c === "y" || (key.return && request.riskLevel !== "high")) decision = "allow_once";
  else if (c === "a" && request.riskLevel !== "high") decision = "allow_always";
  else if (c === "n" || (key.return && request.riskLevel === "high")) decision = "deny";

  if (decision) {
    engine.resolvePermission(request.id, decision);
    setPendingPermission(null);
    setAppState("streaming");
  }
}
