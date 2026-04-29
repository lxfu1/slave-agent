import path from "node:path";
import { minimatch } from "minimatch";
import type Database from "better-sqlite3";
import { getTool } from "../../tools/registry.js";
import { checkPermission } from "../../permissions/guard.js";
import { appendMessage } from "../../session/db.js";
import type { OpenAIToolCall } from "../../types/messages.js";
import type { MemoAgentConfig } from "../../types/config.js";
import type { Tool, ToolContext } from "../../types/tool.js";
import type { Recipe } from "../../recipes/recipeRegistry.js";
import type { EngineEvent, PermissionDecision } from "../conversationEngine.js";

export interface ToolExecutorDeps {
  cwd: string;
  profileDir: string;
  db: Database.Database;
  config: MemoAgentConfig;
  recipes: Recipe[];
  // Mutable state — passed by reference so executor always reads current values
  getSessionId: () => string;
  getPermissionMode: () => "ask" | "auto";
  getAbortController: () => AbortController | null;
  getRecipeAllowedTools: () => Set<string>;
  getSessionAlwaysAllowedTools: () => Set<string>;
  // Callbacks
  onMessageAppended: (toolCallId: string, toolName: string, content: string, isError: boolean) => void;
  onSessionAlwaysAllow: (toolName: string) => void;
  onWaitForPermission: (requestId: string) => Promise<PermissionDecision>;
  onInvalidateSystemPrompt: () => void;
}

type ParseOk = { ok: true; input: Record<string, unknown> };
type ParseErr = { ok: false; error: string };

/**
 * Handles all tool execution: input parsing, permission checks, parallel/serial
 * dispatch, result truncation, and message appending.
 */
export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  async *executeAll(toolCalls: OpenAIToolCall[]): AsyncGenerator<EngineEvent, void, unknown> {
    const canParallelize =
      toolCalls.length > 1 &&
      toolCalls.every(tc => getTool(tc.function.name)?.isReadOnly() === true);

    if (canParallelize) {
      yield* this.executeParallel(toolCalls);
    } else {
      yield* this.executeSerial(toolCalls);
    }
  }

  // ---------------------------------------------------------------------------
  // Serial execution
  // ---------------------------------------------------------------------------

  private async *executeSerial(
    toolCalls: OpenAIToolCall[],
  ): AsyncGenerator<EngineEvent, void, unknown> {
    for (const toolCall of toolCalls) {
      yield* this.executeSingle(toolCall);
    }
  }

  private async *executeSingle(
    toolCall: OpenAIToolCall,
  ): AsyncGenerator<EngineEvent, void, unknown> {
    const toolName = toolCall.function.name;
    const tool = getTool(toolName);

    if (!tool) {
      const msg = `Tool "${toolName}" not found`;
      this.appendResult(toolCall.id, toolName, msg, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: msg, isError: true };
      return;
    }

    const parsed = this.parseInput(toolCall);
    if (!parsed.ok) {
      this.appendResult(toolCall.id, toolName, parsed.error, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: parsed.error, isError: true };
      return;
    }
    const { input } = parsed;

    // Permission check
    const effectiveMode = this.isPreApproved(toolName) ? "auto" : this.deps.getPermissionMode();
    const permResult = checkPermission(tool, input, effectiveMode, this.deps.config.permissions, this.deps.cwd);

    if (permResult.behavior === "deny") {
      const msg = `Permission denied: ${permResult.reason}`;
      this.appendResult(toolCall.id, toolName, msg, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: msg, isError: true };
      return;
    }

    if (permResult.behavior === "ask") {
      yield { type: "permission_request", request: permResult.request };

      const decision = await this.deps.onWaitForPermission(permResult.request.id);

      if (decision === "deny") {
        const msg = "User denied permission";
        this.appendResult(toolCall.id, toolName, msg, true);
        yield { type: "tool_result", name: toolName, id: toolCall.id, content: msg, isError: true };
        return;
      }

      if (decision === "allow_always") {
        this.deps.onSessionAlwaysAllow(toolName);
      }
    }

    yield { type: "tool_call_description", id: toolCall.id, description: buildToolDescription(toolName, input) };

    let result;
    try {
      result = await tool.call(input, this.buildContext());
    } catch (err) {
      const msg = `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
      this.appendResult(toolCall.id, toolName, msg, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: msg, isError: true };
      return;
    }

    const FILE_MUTATING_TOOLS = new Set(["WriteFile", "EditFile", "WriteNotes"]);
    if (FILE_MUTATING_TOOLS.has(toolName)) {
      this.deps.onInvalidateSystemPrompt();
    }

    if (!result.isError && (toolName === "WriteFile" || toolName === "EditFile")) {
      const writtenPath = input["path"] as string | undefined;
      if (writtenPath) {
        yield* this.checkWatchPaths(writtenPath);
      }
    }

    const content = truncate(result.content, tool.maxResultChars);
    this.appendResult(toolCall.id, toolName, content, result.isError ?? false);
    yield { type: "tool_result", name: toolName, id: toolCall.id, content, isError: result.isError ?? false };
  }

  // ---------------------------------------------------------------------------
  // Parallel execution (read-only tools only)
  // ---------------------------------------------------------------------------

  private async *executeParallel(
    toolCalls: OpenAIToolCall[],
  ): AsyncGenerator<EngineEvent, void, unknown> {
    type PreparedOk = { ok: true; toolCall: OpenAIToolCall; tool: Tool; input: Record<string, unknown> };
    type PreparedErr = { ok: false; toolCall: OpenAIToolCall; error: string };
    type Prepared = PreparedOk | PreparedErr;

    // Parse inputs and check permissions synchronously.
    // Read-only tools always receive "allow" so no async user interaction needed.
    const prepared: Prepared[] = toolCalls.map((toolCall): Prepared => {
      const tool = getTool(toolCall.function.name);
      if (!tool) {
        return { ok: false, toolCall, error: `Tool "${toolCall.function.name}" not found` };
      }

      const parsed = this.parseInput(toolCall);
      if (!parsed.ok) {
        return { ok: false, toolCall, error: parsed.error };
      }
      const { input } = parsed;

      const effectiveMode = this.isPreApproved(toolCall.function.name) ? "auto" : this.deps.getPermissionMode();
      const permResult = checkPermission(tool, input, effectiveMode, this.deps.config.permissions, this.deps.cwd);

      if (permResult.behavior === "deny") {
        return { ok: false, toolCall, error: `Permission denied: ${permResult.reason}` };
      }
      if (permResult.behavior === "ask") {
        return { ok: false, toolCall, error: `Unexpected permission prompt for read-only tool "${toolCall.function.name}"` };
      }

      return { ok: true, toolCall, tool, input };
    });

    // Emit description events up-front so UI shows all cards in "running" state.
    for (const p of prepared) {
      if (p.ok) {
        yield {
          type: "tool_call_description",
          id: p.toolCall.id,
          description: buildToolDescription(p.toolCall.function.name, p.input),
        };
      }
    }

    // Execute all prepared tools concurrently.
    const ctx = this.buildContext();
    const execResults = await Promise.allSettled(
      prepared.map(p =>
        p.ok
          ? p.tool.call(p.input, ctx)
          : Promise.resolve({ content: p.error, isError: true as const }),
      ),
    );

    // Emit results in original call order.
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i] as (typeof prepared)[number];
      const execResult = execResults[i] as (typeof execResults)[number];
      const toolName = p.toolCall.function.name;
      const toolId = p.toolCall.id;

      let content: string;
      let isError: boolean;

      if (execResult.status === "rejected") {
        content = `Tool execution error: ${execResult.reason instanceof Error ? execResult.reason.message : String(execResult.reason)}`;
        isError = true;
      } else {
        const raw = execResult.value;
        isError = raw.isError ?? false;
        const maxChars = p.ok ? p.tool.maxResultChars : raw.content.length;
        content = truncate(raw.content, maxChars);
      }

      this.appendResult(toolId, toolName, content, isError);
      yield { type: "tool_result", name: toolName, id: toolId, content, isError };
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseInput(toolCall: OpenAIToolCall): ParseOk | ParseErr {
    try {
      const input = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      return { ok: true, input };
    } catch {
      return { ok: false, error: `Invalid JSON arguments for tool "${toolCall.function.name}"` };
    }
  }

  private isPreApproved(toolName: string): boolean {
    return (
      this.deps.getRecipeAllowedTools().has(toolName) ||
      this.deps.getSessionAlwaysAllowedTools().has(toolName)
    );
  }

  private buildContext(): ToolContext {
    const ac = this.deps.getAbortController();
    return {
      cwd: this.deps.cwd,
      profileDir: this.deps.profileDir,
      sessionId: this.deps.getSessionId(),
      permissionMode: this.deps.getPermissionMode(),
      db: this.deps.db,
      ...(ac && { abortSignal: ac.signal }),
    };
  }

  private appendResult(
    toolCallId: string,
    toolName: string,
    content: string,
    isError: boolean,
  ): void {
    this.deps.onMessageAppended(toolCallId, toolName, content, isError);
    appendMessage(this.deps.db, {
      sessionId: this.deps.getSessionId(),
      role: "tool",
      content: isError ? `Error: ${content}` : content,
      toolCallsJson: null,
      toolCallId,
      tokenCount: 0,
    });
  }

  private *checkWatchPaths(writtenPath: string): Generator<EngineEvent> {
    const relPath = path.isAbsolute(writtenPath)
      ? path.relative(this.deps.cwd, writtenPath)
      : writtenPath;
    const normalised = relPath.split(path.sep).join("/");

    for (const recipe of this.deps.recipes) {
      const patterns = recipe.frontmatter.watchPaths ?? [];
      if (patterns.some(pattern => minimatch(normalised, pattern, { dot: true }))) {
        yield {
          type: "command_output",
          message: `Tip: /${recipe.name} may be relevant — ${recipe.description}`,
          kind: "info",
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function truncate(content: string, maxChars: number): string {
  return content.length > maxChars
    ? content.slice(0, maxChars) + "\n...(truncated)"
    : content;
}

function buildToolDescription(toolName: string, input: Record<string, unknown>): string {
  const filePath = typeof input["path"]    === "string" ? input["path"]    : null;
  const command  = typeof input["command"] === "string" ? input["command"] : null;
  const pattern  = typeof input["pattern"] === "string" ? input["pattern"] : null;
  const query    = typeof input["query"]   === "string" ? input["query"]   : null;
  const content  = typeof input["content"] === "string" ? input["content"] : null;

  if (filePath) return filePath;
  if (command)  return command.length > 60 ? command.slice(0, 59) + "…" : command;
  if (pattern)  return pattern.length > 60 ? pattern.slice(0, 59) + "…" : pattern;
  if (query)    return query.length   > 60 ? query.slice(0, 59)   + "…" : query;
  if (toolName === "WriteNotes" && content) return content.slice(0, 60) + (content.length > 60 ? "…" : "");
  if (toolName === "ReadNotes") return "NOTES.md";
  return toolName; // fallback: never show empty string in UI
}
