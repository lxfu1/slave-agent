/**
 * Typed error system. All errors in memo-agent are instances of SlaveAgentError
 * with a discriminating code, enabling structured error handling without
 * string matching on error messages.
 */

export type SlaveAgentErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_PARSE_ERROR"
  | "API_ERROR"
  | "API_TIMEOUT"
  | "API_RATE_LIMIT"
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_ERROR"
  | "PERMISSION_DENIED"
  | "DB_ERROR"
  | "RECIPE_PARSE_ERROR"
  | "RECIPE_NOT_FOUND"
  | "MCP_CONNECT_FAILED"
  | "COMPRESSION_FAILED"
  | "SESSION_NOT_FOUND"
  | "INJECTION_DETECTED";

export interface SlaveAgentError {
  readonly code: SlaveAgentErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export function makeError(
  code: SlaveAgentErrorCode,
  message: string,
  cause?: unknown
): SlaveAgentError {
  return { code, message, cause };
}

export function isSlaveAgentError(err: unknown): err is SlaveAgentError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    typeof (err as SlaveAgentError).code === "string"
  );
}
