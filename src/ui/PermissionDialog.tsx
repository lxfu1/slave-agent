import React from "react";
import { Box, Text } from "ink";
import type { ConversationEngine, PermissionDecision } from "../engine/conversationEngine.js";
import type { PermissionRequest } from "../permissions/guard.js";
import type { AppState } from "./types.js";
import type { Key } from "ink";

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
      <Text color="white">{request.summary}</Text>
      <Text color="gray">  [y/Enter] Allow once  [a] Allow always  [n] Deny</Text>
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

  if (c === "y" || key.return) decision = "allow_once";
  else if (c === "a") decision = "allow_always";
  else if (c === "n") decision = "deny";

  if (decision) {
    engine.resolvePermission(request.id, decision);
    setPendingPermission(null);
    setAppState("streaming");
  }
}
