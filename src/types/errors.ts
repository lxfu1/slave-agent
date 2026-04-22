/**
 * Typed error system. All errors in memo-agent are instances of MemoAgentError
 * with a discriminating code, enabling structured error handling without
 * string matching on error messages.
 */

export type MemoAgentErrorCode =
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

export interface MemoAgentError {
  readonly code: MemoAgentErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export function makeError(
  code: MemoAgentErrorCode,
  message: string,
  cause?: unknown
): MemoAgentError {
  return { code, message, cause };
}

export function isMemoAgentError(err: unknown): err is MemoAgentError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    typeof (err as MemoAgentError).code === "string"
  );
}
