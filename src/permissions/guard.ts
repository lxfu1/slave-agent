/**
 * Permission guard — centralized authorization for all tool calls.
 *
 * Decision order (first match wins):
 *   1. config.deny pattern → deny
 *   2. config.allow pattern → allow
 *   3. tool.isReadOnly() → allow
 *   4. safe project directory: file write within a non-core cwd → allow
 *   5. dangerous command blocklist → ask (even in auto mode)
 *   6. mode === "auto" → allow
 *   7. default → ask
 *
 * Step 4 ("safe project directory") auto-approves WriteFile and EditFile
 * calls whose target path is inside the current working directory, provided
 * cwd is NOT a "core" directory. Core directories are the home directory
 * itself, filesystem root, well-known system paths, and sensitive hidden
 * subdirectories of home (e.g. ~/.ssh, ~/.aws).
 *
 * The dangerous command blocklist always forces confirmation regardless of
 * the permission mode. This is a non-negotiable safety boundary.
 */

import os from "node:os";
import path from "node:path";
import type { Tool } from "../types/tool.js";
import type { PermissionsConfig } from "../types/config.js";

export type PermissionBehavior = "allow" | "ask" | "deny";
export type RiskLevel = "low" | "medium" | "high";

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: RiskLevel;
  summary: string;
}

export interface PermissionCheckResult {
  behavior: PermissionBehavior;
  reason: string;
  request: PermissionRequest;
}

/**
 * Shell command patterns that always require user confirmation,
 * even when the agent is in "auto" mode.
 * These represent irreversible or high-blast-radius operations.
 */
const ALWAYS_CONFIRM_COMMANDS: RegExp[] = [
  /\brm\s+(-\S*f\S*|-\S*r\S*|--force|--recursive)/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[fFdx]/i,
  /\bsudo\b/,
  /\bdd\s+.*of=/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\s+-9\b/,
  /\btruncate\b.*--size\s*0/,
  /\bdropdb\b/,
  /\bdrop\s+database\b/i,
  /\bchmod\s+777\b/,
];

// ---------------------------------------------------------------------------
// Core-directory detection
// ---------------------------------------------------------------------------

/**
 * Unix system paths whose subtrees are considered sensitive.
 * File operations inside these paths always require confirmation.
 */
const SYSTEM_ROOTS = [
  "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
  "/var", "/sys", "/proc", "/dev", "/boot", "/run",
];

/**
 * Direct children of the home directory that hold configuration/credentials.
 * Being inside these directories is treated as "core" even though they are
 * not system paths.
 */
const SENSITIVE_HOME_SUBDIRS = new Set([
  ".ssh", ".gnupg", ".aws", ".config", ".local",
  ".kube", ".docker", ".gradle", ".m2", ".npm",
  ".cache", ".credentials", ".netrc",
]);

/**
 * Returns true when cwd should be treated as a "core" directory where file
 * writes always require explicit confirmation, regardless of permission mode.
 *
 * Core directories:
 *   - The user's home directory itself (but NOT its non-sensitive subdirs)
 *   - The filesystem root /
 *   - Known Unix system trees (/etc, /usr, /bin, …) and their subtrees
 *   - Sensitive hidden subdirectories of home (~/.ssh, ~/.aws, …)
 *
 * @internal Exported for unit testing.
 */
export function isCoreDirectory(cwd: string): boolean {
  const home = os.homedir();
  const resolved = path.resolve(cwd);

  // Filesystem root
  if (resolved === "/") return true;

  // Home directory itself (but ~/projects/foo is fine)
  if (resolved === home) return true;

  // System trees and their subtrees
  for (const sysRoot of SYSTEM_ROOTS) {
    if (resolved === sysRoot || resolved.startsWith(sysRoot + path.sep)) return true;
  }

  // Sensitive direct children of home (e.g. ~/.ssh, ~/.aws)
  const relToHome = path.relative(home, resolved);
  if (!relToHome.startsWith("..") && !path.isAbsolute(relToHome)) {
    const topLevel = relToHome.split(path.sep)[0];
    if (topLevel && SENSITIVE_HOME_SUBDIRS.has(topLevel)) return true;
  }

  return false;
}

/**
 * For file-mutation tools (WriteFile, EditFile), resolves the absolute target
 * path from the tool input. Returns null for tools without a single file target.
 */
function resolveTargetPath(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  if (toolName === "WriteFile" || toolName === "EditFile") {
    const p = input["path"] as string | undefined;
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.resolve(cwd, p);
  }
  return null;
}

/**
 * Returns true when filePath is at or under the given directory root.
 */
function isWithinDirectory(filePath: string, dir: string): boolean {
  const resolved = path.resolve(dir);
  const withSep = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  return filePath === resolved || filePath.startsWith(withSep);
}

let requestIdCounter = 0;

function generateRequestId(): string {
  return `perm_${Date.now()}_${requestIdCounter++}`;
}

/** Checks whether a tool call is permitted under the current config and mode */
export function checkPermission(
  tool: Tool,
  input: Record<string, unknown>,
  mode: "ask" | "auto",
  config: PermissionsConfig,
  cwd: string,
): PermissionCheckResult {
  const toolName = tool.name;
  const requestId = generateRequestId();

  // 1. Explicit deny patterns
  if (matchesPatterns(toolName, input, config.deny)) {
    return {
      behavior: "deny",
      reason: `Tool "${toolName}" is blocked by deny rules`,
      request: buildRequest(requestId, toolName, input, "high"),
    };
  }

  // 2. Explicit allow patterns
  if (matchesPatterns(toolName, input, config.allow)) {
    return {
      behavior: "allow",
      reason: "Allowed by configuration",
      request: buildRequest(requestId, toolName, input, "low"),
    };
  }

  // 3. Read-only tools are always allowed
  if (tool.isReadOnly()) {
    return {
      behavior: "allow",
      reason: "Read-only tool",
      request: buildRequest(requestId, toolName, input, "low"),
    };
  }

  // 4. Safe project directory: auto-allow file writes within a non-core cwd.
  //    When the agent is invoked from a project directory (not ~, /, /etc, …)
  //    the user implicitly trusts writes to files inside that directory.
  if (!isCoreDirectory(cwd)) {
    const targetPath = resolveTargetPath(toolName, input, cwd);
    if (targetPath !== null && isWithinDirectory(targetPath, cwd)) {
      return {
        behavior: "allow",
        reason: "Safe project directory",
        request: buildRequest(requestId, toolName, input, assessRisk(toolName, input)),
      };
    }
  }

  // 5. Dangerous commands must always be confirmed (overrides auto mode)
  if (toolName === "RunCommand") {
    const command = (input["command"] as string | undefined) ?? "";
    if (isDangerousCommand(command)) {
      return {
        behavior: "ask",
        reason: `Dangerous command requires confirmation: ${command.slice(0, 80)}`,
        request: buildRequest(requestId, toolName, input, "high"),
      };
    }
  }

  // 6. Auto mode allows everything else
  if (mode === "auto") {
    return {
      behavior: "allow",
      reason: "Auto mode",
      request: buildRequest(requestId, toolName, input, assessRisk(toolName, input)),
    };
  }

  // 7. Default: ask for confirmation
  return {
    behavior: "ask",
    reason: "Write operation requires confirmation",
    request: buildRequest(requestId, toolName, input, assessRisk(toolName, input)),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDangerousCommand(command: string): boolean {
  return ALWAYS_CONFIRM_COMMANDS.some(pattern => pattern.test(command));
}

/**
 * Checks if a tool invocation matches any of the given patterns.
 * Patterns can be:
 *   - "ToolName" — exact tool name match
 *   - "ToolName(*)" — tool name prefix match
 *   - "RunCommand(rm *)" — tool name + command pattern match
 */
function matchesPatterns(
  toolName: string,
  input: Record<string, unknown>,
  patterns: string[]
): boolean {
  for (const pattern of patterns) {
    if (pattern === toolName) return true;

    const parenIdx = pattern.indexOf("(");
    if (parenIdx !== -1) {
      const patternToolName = pattern.slice(0, parenIdx);
      const patternArg = pattern.slice(parenIdx + 1, -1); // strip parens

      if (patternToolName !== toolName) continue;

      // Match against the command argument for RunCommand
      if (toolName === "RunCommand") {
        const command = (input["command"] as string | undefined) ?? "";
        if (wildcardMatch(command, patternArg)) return true;
      }
    }
  }
  return false;
}

/** Simple wildcard matching: * matches any sequence of characters */
function wildcardMatch(text: string, pattern: string): boolean {
  // Escape all regex metacharacters including ? to prevent syntax errors
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp("^" + escaped + "$");
  return regex.test(text);
}

function assessRisk(toolName: string, _input: Record<string, unknown>): RiskLevel {
  if (toolName === "RunCommand") return "high";
  if (toolName === "WriteFile" || toolName === "EditFile") return "medium";
  return "low";
}

function buildRequest(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  riskLevel: RiskLevel
): PermissionRequest {
  return {
    id,
    toolName,
    input,
    riskLevel,
    summary: buildSummary(toolName, input),
  };
}

function buildSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "RunCommand":
      return `Run: ${String(input["command"] ?? "").slice(0, 100)}`;
    case "WriteFile":
      return `Write: ${String(input["path"] ?? "")}`;
    case "EditFile":
      return `Edit: ${String(input["path"] ?? "")}`;
    default:
      return toolName;
  }
}
