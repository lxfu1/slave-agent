/**
 * ConversationEngine — the core of memo-agent.
 *
 * Owns the mutable conversation state and emits a typed stream of EngineEvents
 * via an async generator. The UI layer consumes these events to render output.
 *
 * Key behaviors:
 * - Tool call loop with MAX_TOOL_CALL_ROUNDS safety limit
 * - Token budget monitoring with automatic context compression
 * - Centralized permission checks before every tool execution
 * - Append-only message history (never mutated in place)
 * - Session persistence after every model turn
 */

import type Database from "better-sqlite3";
import type OpenAI from "openai";
import path from "node:path";
import { minimatch } from "minimatch";
import {
  appendMessage,
  createSession,
  loadMessagesForSession,
  pruneOldSessions,
  rowsToChatMessages,
  setSessionTitle,
  updateSessionStats,
} from "../session/db.js";
import { streamChat } from "../model/streaming.js";
import {
  buildSystemPrompt,
  type RecipeDescriptor,
} from "../context/promptBuilder.js";
import {
  computeBudgetSnapshot,
  estimateCostUsd,
} from "../context/tokenBudget.js";
import { compressContext, type CompressorDeps } from "../context/compressor.js";
import { createNotesManager } from "../memory/notesManager.js";
import { getTool, getToolsAsOpenAIFunctions } from "../tools/registry.js";
import { checkPermission, type PermissionRequest } from "../permissions/guard.js";
import { routeCommand, type CommandContext } from "./commandRouter.js";
import { expandRecipe } from "../recipes/recipeRegistry.js";
import { clearSessionTasks } from "../tools/tasks.js";
import type { ChatMessage, OpenAIToolCall, TokenUsage } from "../types/messages.js";
import type { MemoAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import type { ToolContext } from "../types/tool.js";

const MAX_TOOL_CALL_ROUNDS = 20;

// ---------------------------------------------------------------------------
// Event types emitted by the engine
// ---------------------------------------------------------------------------

export type EngineEvent =
  | { type: "stream_delta"; delta: string }
  | { type: "tool_call_start"; name: string; id: string }
  /**
   * Emitted right before a tool is called — after permission is granted but
   * before execution starts.  Carries a human-readable description so the UI
   * can show "⟳ ReadFile  src/main.ts" instead of just the bare tool name.
   */
  | { type: "tool_call_description"; id: string; description: string }
  | { type: "tool_result"; name: string; id: string; content: string; isError: boolean }
  | { type: "messages_updated"; messages: ChatMessage[] }
  | { type: "usage_updated"; sessionUsage: SessionUsage }
  | { type: "token_warning"; ratio: number; level: "warn" | "critical" }
  | { type: "compressed"; summary: string; trigger: "auto" | "manual" }
  | { type: "command_output"; message: string; kind: "info" | "error" | "help" }
  | { type: "session_cleared" }
  | { type: "notes_shown"; content: string }
  | { type: "notes_cleared" }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string; decision: PermissionDecision }
  | { type: "exit_requested" }
  | { type: "injection_warning"; source: string }
  | { type: "error"; message: string; code: string };

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  currentRatio: number;
  contextWindowSize: number;
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

export interface EngineOptions {
  config: MemoAgentConfig;
  profileDir: string;
  cwd: string;
  db: Database.Database;
  sessionId: string;
  modelClient: OpenAI;
  auxiliaryClient: OpenAI | null;
  recipes: Recipe[];
  initialMessages?: ChatMessage[];
  permissionMode?: "ask" | "auto";
  profileName?: string;
}

export class ConversationEngine {
  private messages: ChatMessage[];
  private sessionId: string;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private estimatedCostUsd = 0;
  // Tracks what has already been flushed to DB to compute per-flush deltas
  private flushedInputTokens = 0;
  private flushedOutputTokens = 0;
  private flushedCostUsd = 0;
  private currentRatio = 0;
  private currentContextWindowSize = 0;
  private permissionMode: "ask" | "auto";
  private currentModel: string;
  private abortController: AbortController | null = null;
  private isFirstMessage: boolean;
  private cachedSystemPrompt: string | null = null;
  private pendingInjectionWarnings: string[] = [];

  // Pending permission resolutions (request id → resolve callback)
  private pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >();

  // Tools pre-approved by the current recipe invocation
  private recipeAllowedTools: Set<string> = new Set();

  // Tools the user has approved for the rest of this session via "allow always"
  private sessionAlwaysAllowedTools: Set<string> = new Set();

  constructor(private readonly opts: EngineOptions) {
    this.messages = opts.initialMessages ?? [];
    this.sessionId = opts.sessionId;
    this.permissionMode = opts.permissionMode ?? opts.config.permissions.mode;
    this.currentModel = opts.config.model.name;
    this.isFirstMessage = this.messages.length === 0;

    if (this.messages.length === 0) {
      createSession(opts.db, {
        id: this.sessionId,
        title: "",
        model: this.currentModel,
        parentSessionId: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
    }
  }

  /** Interrupts the current streaming operation and resolves all pending permissions as denied */
  interrupt(): void {
    this.abortController?.abort();
    // Drain pending permissions so their promises don't leak
    for (const [id, resolve] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      resolve("deny");
    }
  }

  /** Returns a snapshot of the current engine state for UI rendering */
  getUsage(): SessionUsage {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      estimatedCostUsd: this.estimatedCostUsd,
      currentRatio: this.currentRatio,
      contextWindowSize: this.currentContextWindowSize,
    };
  }

  getCurrentMode(): "ask" | "auto" { return this.permissionMode; }
  getCurrentModel(): string { return this.currentModel; }
  getMessages(): ChatMessage[] { return this.messages; }

  /** Resolves a pending permission request */
  /** Clears the cached system prompt so it is rebuilt on the next turn */
  private invalidateSystemPrompt(): void {
    this.cachedSystemPrompt = null;
  }

  /** Returns the cached system prompt, building it if necessary */
  private async getOrBuildSystemPrompt(): Promise<string> {
    if (!this.cachedSystemPrompt) {
      const recipeDescriptors: RecipeDescriptor[] = this.opts.recipes.map(r => ({
        name: r.name,
        description: r.description,
        scope: r.scope,
      }));
      const result = await buildSystemPrompt({
        cwd: this.opts.cwd,
        profileDir: this.opts.profileDir,
        config: this.opts.config,
        recipes: recipeDescriptors,
      });
      this.cachedSystemPrompt = result.prompt;
      // Emit injection warnings via the event stream on the next turn
      this.pendingInjectionWarnings = result.injectionWarnings;
    }
    return this.cachedSystemPrompt;
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve(decision);
    }
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async *submitMessage(userInput: string): AsyncGenerator<EngineEvent, void, unknown> {
    const trimmed = userInput.trim();
    if (!trimmed) return;

    // Determine actual message body: recipe expansion, command, or plain text.
    // Recipe check must come BEFORE the slash-command branch so that
    // recipe-invoked tools get their allowedTools pre-approval.
    let messageBody = trimmed;
    let markerText: string | null = null;
    this.recipeAllowedTools = new Set();

    if (trimmed.startsWith("/")) {
      // Try recipe expansion first
      const expansion = expandRecipe(this.opts.recipes, trimmed);
      if (expansion) {
        messageBody = expansion.bodyText;
        markerText = expansion.markerText;
        this.recipeAllowedTools = new Set(expansion.allowedTools);
      } else if (this.isBuiltinCommand(trimmed)) {
        // Known slash command — delegate to command handler and return
        yield* this.handleCommand(trimmed);
        return;
      } else {
        // Unknown /command — let the command handler emit an error
        yield* this.handleCommand(trimmed);
        return;
      }
    }

    // Build (or retrieve cached) system prompt
    const systemPrompt = await this.getOrBuildSystemPrompt();

    // Flush any injection warnings produced during prompt build
    for (const source of this.pendingInjectionWarnings) {
      yield { type: "injection_warning", source };
    }
    this.pendingInjectionWarnings = [];

    // Check token budget and maybe compress
    const snapshot = computeBudgetSnapshot(
      this.messages,
      systemPrompt,
      this.opts.config.context,
      this.currentModel
    );

    if (snapshot.isAboveCompress) {
      yield* this.performCompression(systemPrompt, "auto");
    } else if (snapshot.isAboveWarn) {
      yield {
        type: "token_warning",
        ratio: snapshot.usageRatio,
        level: "warn",
      };
    }

    // Append user message (immutable pattern)
    const userMessage: ChatMessage = {
      role: "user",
      content: markerText ? `${markerText}\n\n${messageBody}` : messageBody,
    };

    this.messages = [...this.messages, userMessage];

    appendMessage(this.opts.db, {
      sessionId: this.sessionId,
      role: "user",
      content: userMessage.content,
      toolCallsJson: null,
      toolCallId: null,
      tokenCount: 0,
    });

    // Set session title from first message
    if (this.isFirstMessage) {
      this.isFirstMessage = false;
      const title = trimmed.slice(0, 80);
      setSessionTitle(this.opts.db, this.sessionId, title);
    }

    // Notify UI of updated messages and initial token ratio
    yield { type: "messages_updated", messages: this.messages };
    yield this.buildUsageEvent(systemPrompt);

    // Run the tool call loop
    yield* this.runToolCallLoop(systemPrompt);

    // Auto-update NOTES.md after every complete turn
    if (this.opts.config.memory.autoUpdate) {
      yield* this.autoUpdateNotes();
    }

    // Prune old sessions on every turn (cheap SQL, prevents unbounded DB growth)
    pruneOldSessions(this.opts.db);
  }

  // ---------------------------------------------------------------------------
  // Tool call loop
  // ---------------------------------------------------------------------------

  private async *runToolCallLoop(systemPrompt: string): AsyncGenerator<EngineEvent, void, unknown> {
    this.abortController = new AbortController();
    let rounds = 0;

    // Tool definitions don't change within a single conversation turn.
    const toolDefs = getToolsAsOpenAIFunctions();

    while (rounds < MAX_TOOL_CALL_ROUNDS) {
      rounds++;

      let streamDone = false;
      let stopReason = "stop";
      const accumulatedToolCalls: OpenAIToolCall[] = [];
      let assistantContent = "";
      const turnUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      for await (const event of streamChat(this.opts.modelClient, {
        model: this.currentModel,
        messages: this.messages,
        ...(toolDefs.length > 0 && { tools: toolDefs }),
        systemPrompt,
        maxTokens: this.opts.config.model.maxTokens,
        abortSignal: this.abortController!.signal,
      })) {
        switch (event.type) {
          case "text_delta":
            assistantContent += event.delta;
            yield { type: "stream_delta", delta: event.delta };
            break;

          case "tool_call_start":
            yield { type: "tool_call_start", name: event.name, id: event.id };
            break;

          case "tool_call_delta":
            // No event emitted — accumulation is internal to streaming layer
            break;

          case "tool_call_done":
            accumulatedToolCalls.push({
              id: event.id,
              type: "function",
              function: { name: event.name, arguments: event.arguments },
            });
            break;

          case "message_done":
            stopReason = event.stopReason;
            turnUsage.promptTokens = event.usage.promptTokens;
            turnUsage.completionTokens = event.usage.completionTokens;
            turnUsage.totalTokens = event.usage.totalTokens;
            streamDone = true;
            break;

          case "error":
            yield {
              type: "error",
              message: event.error.message,
              code: event.error.code,
            };
            return;
        }
      }

      if (!streamDone) break;

      // Update cumulative totals with per-turn deltas
      const turnCost = estimateCostUsd(turnUsage, this.currentModel);
      this.totalInputTokens += turnUsage.promptTokens;
      this.totalOutputTokens += turnUsage.completionTokens;
      this.estimatedCostUsd += turnCost;

      // Persist assistant message
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: assistantContent || null,
        ...(accumulatedToolCalls.length > 0 && { tool_calls: accumulatedToolCalls }),
      };

      this.messages = [...this.messages, assistantMessage];

      appendMessage(this.opts.db, {
        sessionId: this.sessionId,
        role: "assistant",
        content: assistantContent || null,
        toolCallsJson: accumulatedToolCalls.length > 0 ? JSON.stringify(accumulatedToolCalls) : null,
        toolCallId: null,
        tokenCount: turnUsage.completionTokens,
      });

      yield { type: "messages_updated", messages: this.messages };
      yield this.buildUsageEvent(systemPrompt);

      // Handle tool calls
      if (stopReason === "tool_calls" && accumulatedToolCalls.length > 0) {
        for (const toolCall of accumulatedToolCalls) {
          yield* this.executeToolCall(toolCall);
        }
        continue; // Continue loop to send tool results back to model
      }

      // Normal stop
      break;
    }

    if (rounds >= MAX_TOOL_CALL_ROUNDS) {
      yield {
        type: "error",
        message: `Reached maximum tool call rounds (${MAX_TOOL_CALL_ROUNDS}). Use /clear to reset context.`,
        code: "MAX_ROUNDS_EXCEEDED",
      };
    }

    // Persist session stats: the engine tracks cumulative totals, but the DB uses additive
    // increments. We track what was already flushed to avoid double-counting.
    const newInput = this.totalInputTokens - this.flushedInputTokens;
    const newOutput = this.totalOutputTokens - this.flushedOutputTokens;
    const newCost = this.estimatedCostUsd - this.flushedCostUsd;

    if (newInput > 0 || newOutput > 0) {
      updateSessionStats(this.opts.db, this.sessionId, newInput, newOutput, newCost);
    }

    this.flushedInputTokens = this.totalInputTokens;
    this.flushedOutputTokens = this.totalOutputTokens;
    this.flushedCostUsd = this.estimatedCostUsd;

    // Final token budget check
    const finalSystemPrompt = systemPrompt;
    const finalSnapshot = computeBudgetSnapshot(
      this.messages,
      finalSystemPrompt,
      this.opts.config.context,
      this.currentModel
    );

    if (finalSnapshot.isAboveWarn) {
      yield {
        type: "token_warning",
        ratio: finalSnapshot.usageRatio,
        level: finalSnapshot.isAboveCompress ? "critical" : "warn",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  private async *executeToolCall(
    toolCall: OpenAIToolCall
  ): AsyncGenerator<EngineEvent, void, unknown> {
    const toolName = toolCall.function.name;
    const tool = getTool(toolName);

    if (!tool) {
      const errorResult = `Tool "${toolName}" not found`;
      this.appendToolResult(toolCall.id, toolName, errorResult, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: errorResult, isError: true };
      return;
    }

    let input: Record<string, unknown>;
    try {
      input = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      const errorResult = `Invalid JSON arguments for tool "${toolName}"`;
      this.appendToolResult(toolCall.id, toolName, errorResult, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: errorResult, isError: true };
      return;
    }

    // Permission check
    const isPreApproved = this.recipeAllowedTools.has(toolName) || this.sessionAlwaysAllowedTools.has(toolName);
    const effectiveMode = isPreApproved ? "auto" : this.permissionMode;

    const permResult = checkPermission(tool, input, effectiveMode, this.opts.config.permissions, this.opts.cwd);

    if (permResult.behavior === "deny") {
      const errorResult = `Permission denied: ${permResult.reason}`;
      this.appendToolResult(toolCall.id, toolName, errorResult, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: errorResult, isError: true };
      return;
    }

    if (permResult.behavior === "ask") {
      yield { type: "permission_request", request: permResult.request };

      const decision = await this.waitForPermission(permResult.request.id);

      if (decision === "deny") {
        const errorResult = "User denied permission";
        this.appendToolResult(toolCall.id, toolName, errorResult, true);
        yield { type: "tool_result", name: toolName, id: toolCall.id, content: errorResult, isError: true };
        return;
      }

      if (decision === "allow_always") {
        this.sessionAlwaysAllowedTools.add(toolName);
      }
    }

    // Execute tool
    const toolCtx: ToolContext = {
      cwd: this.opts.cwd,
      profileDir: this.opts.profileDir,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      db: this.opts.db,
      ...(this.abortController && { abortSignal: this.abortController.signal }),
    };

    // Emit a description so the UI can show "⟳ ReadFile src/main.ts" while
    // the tool is running, instead of just the bare tool name.
    yield { type: "tool_call_description", id: toolCall.id, description: buildToolDescription(toolName, input) };

    let result;
    try {
      result = await tool.call(input, toolCtx);
    } catch (err) {
      const errorResult = `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
      this.appendToolResult(toolCall.id, toolName, errorResult, true);
      yield { type: "tool_result", name: toolName, id: toolCall.id, content: errorResult, isError: true };
      return;
    }

    // Writing to NOTES.md or project files changes what the system prompt injects
    const FILE_MUTATING_TOOLS = new Set(["WriteFile", "EditFile", "WriteNotes"]);
    if (FILE_MUTATING_TOOLS.has(toolName)) {
      this.invalidateSystemPrompt();
    }

    // After a successful file write, check recipe watchPaths and suggest matches
    if (!result.isError && (toolName === "WriteFile" || toolName === "EditFile")) {
      const writtenPath = input["path"] as string | undefined;
      if (writtenPath) {
        yield* this.checkWatchPaths(writtenPath);
      }
    }

    // Truncate oversized results
    const maxChars = tool.maxResultChars;
    const content = result.content.length > maxChars
      ? result.content.slice(0, maxChars) + "\n...(truncated)"
      : result.content;

    this.appendToolResult(toolCall.id, toolName, content, result.isError ?? false);
    yield {
      type: "tool_result",
      name: toolName,
      id: toolCall.id,
      content,
      isError: result.isError ?? false,
    };
  }

  private appendToolResult(
    toolCallId: string,
    toolName: string,
    content: string,
    isError: boolean
  ): void {
    const toolMsg: ChatMessage = {
      role: "tool",
      content: isError ? `Error: ${content}` : content,
      tool_call_id: toolCallId,
      name: toolName,
    };
    this.messages = [...this.messages, toolMsg];

    appendMessage(this.opts.db, {
      sessionId: this.sessionId,
      role: "tool",
      content: toolMsg.content,
      toolCallsJson: null,
      toolCallId,
      tokenCount: 0,
    });
  }

  private waitForPermission(requestId: string): Promise<PermissionDecision> {
    return new Promise(resolve => {
      // Auto-deny after 30 s so a missed UI event never hangs the tool loop.
      const timeout = setTimeout(() => {
        if (this.pendingPermissions.delete(requestId)) {
          resolve("deny");
        }
      }, 30_000);

      this.pendingPermissions.set(requestId, (decision: PermissionDecision) => {
        clearTimeout(timeout);
        resolve(decision);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Compression
  // ---------------------------------------------------------------------------

  private async *performCompression(
    systemPrompt: string,
    trigger: "auto" | "manual",
    focus?: string
  ): AsyncGenerator<EngineEvent, void, unknown> {
    const compressorDeps: CompressorDeps = {
      primaryClient: this.opts.modelClient,
      primaryModel: this.currentModel,
      auxiliaryClient: this.opts.auxiliaryClient,
      auxiliaryModel: this.opts.config.auxiliary?.name ?? null,
      config: this.opts.config.context,
    };

    try {
      const result = await compressContext(
        this.messages,
        systemPrompt,
        focus,
        compressorDeps
      );

      if (result.summary) {
        // Create a new session that chains from the current one so the full
        // pre-compression history is permanently retrievable via parent_session_id.
        const archivedSessionId = this.sessionId;
        const newSessionId = crypto.randomUUID();

        createSession(this.opts.db, {
          id: newSessionId,
          title: `[compressed] ${new Date().toISOString().slice(0, 10)}`,
          model: this.currentModel,
          parentSessionId: archivedSessionId,
          // Carry forward accumulated token stats so /cost and history
          // reflect the true lifetime cost of this conversation chain.
          inputTokens: this.totalInputTokens,
          outputTokens: this.totalOutputTokens,
          estimatedCostUsd: this.estimatedCostUsd,
        });

        // Persist the compressed messages under the new session
        for (const msg of result.messages) {
          appendMessage(this.opts.db, {
            sessionId: newSessionId,
            role: msg.role,
            content: msg.content ?? null,
            toolCallsJson: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
            toolCallId: msg.tool_call_id ?? null,
            tokenCount: 0,
          });
        }

        this.sessionId = newSessionId;
        // Sync flushed counters so the next updateSessionStats call does not
        // double-count tokens that were already written to the new session row.
        this.flushedInputTokens = this.totalInputTokens;
        this.flushedOutputTokens = this.totalOutputTokens;
        this.flushedCostUsd = this.estimatedCostUsd;
        this.messages = result.messages;
        yield { type: "compressed", summary: result.summary, trigger };
        yield { type: "messages_updated", messages: this.messages };
      }
    } catch (err) {
      yield {
        type: "error",
        message: `Context compression failed: ${err instanceof Error ? err.message : String(err)}`,
        code: "COMPRESSION_FAILED",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Command handling
  // ---------------------------------------------------------------------------

  private async *handleCommand(input: string): AsyncGenerator<EngineEvent, void, unknown> {
    const cmdCtx: CommandContext = {
      db: this.opts.db,
      currentMode: this.permissionMode,
      currentModel: this.currentModel,
      currentProfile: this.opts.profileName ?? "default",
      recipes: this.opts.recipes.map(r => ({
        name: r.name,
        description: r.description,
        scope: r.scope,
      })),
      sessionId: this.sessionId,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      estimatedCostUsd: this.estimatedCostUsd,
    };

    const result = routeCommand(input, cmdCtx);

    switch (result.type) {
      case "output":
        yield { type: "command_output", message: result.message, kind: result.kind };
        break;

      case "clear_session":
        clearSessionTasks(this.sessionId);
        this.messages = [];
        this.isFirstMessage = true;
        this.sessionId = crypto.randomUUID();
        this.invalidateSystemPrompt();
        createSession(this.opts.db, {
          id: this.sessionId,
          title: "",
          model: this.currentModel,
          parentSessionId: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        });
        yield { type: "session_cleared" };
        break;

      case "compact": {
        const systemPrompt = await this.getOrBuildSystemPrompt();
        yield* this.performCompression(systemPrompt, "manual", result.focus);
        break;
      }

      case "show_notes": {
        const manager = createNotesManager(this.opts.profileDir);
        const content = await manager.read();
        yield { type: "notes_shown", content: content || "NOTES.md is empty." };
        break;
      }

      case "clear_notes": {
        const manager = createNotesManager(this.opts.profileDir);
        await manager.clear();
        yield { type: "notes_cleared" };
        break;
      }

      case "switch_mode":
        this.permissionMode = result.mode;
        yield {
          type: "command_output",
          message: `Permission mode switched to: ${result.mode}`,
          kind: "info",
        };
        break;

      case "switch_model":
        this.currentModel = result.name;
        yield {
          type: "command_output",
          message: `Model switched to: ${result.name}`,
          kind: "info",
        };
        break;

      case "resume": {
        const targetId = result.sessionId;
        if (!targetId) {
          yield { type: "command_output", message: "Usage: /resume <session-id>", kind: "error" };
          break;
        }
        const rows = loadMessagesForSession(this.opts.db, targetId);
        if (rows.length === 0) {
          yield {
            type: "command_output",
            message: `Session ${targetId} not found. Use /history to list available sessions.`,
            kind: "error",
          };
          break;
        }
        clearSessionTasks(this.sessionId);
        this.messages = rowsToChatMessages(rows);
        this.sessionId = targetId;
        this.isFirstMessage = false;
        this.invalidateSystemPrompt();
        yield { type: "messages_updated", messages: this.messages };
        yield {
          type: "command_output",
          message: `Restored session ${targetId.slice(0, 8)} (${rows.length} messages)`,
          kind: "info",
        };
        break;
      }

      case "switch_profile":
        yield {
          type: "command_output",
          message: `To switch profile, restart with: memo --profile ${result.name}`,
          kind: "info",
        };
        break;

      case "exit":
        yield { type: "exit_requested" };
        break;

      case "unknown":
        yield {
          type: "command_output",
          message: `Unknown command: ${result.command}. Type /help for available commands.`,
          kind: "error",
        };
        break;
    }
  }

  private isBuiltinCommand(input: string): boolean {
    const BUILTIN_COMMANDS = new Set([
      "help", "notes", "history", "search", "compact",
      "model", "cost", "clear", "resume", "profile", "recipes", "mode",
      "exit", "quit",
    ]);
    const name = input.slice(1).split(" ")[0]?.toLowerCase() ?? "";
    return BUILTIN_COMMANDS.has(name);
  }

  // ---------------------------------------------------------------------------
  // Recipe watchPaths
  // ---------------------------------------------------------------------------

  /**
   * After a file is written, check whether any recipe declares a watchPaths
   * pattern that matches. Emit a suggestion notice for each matching recipe.
   * The path is normalised to a relative form for glob matching.
   */
  private *checkWatchPaths(writtenPath: string): Generator<EngineEvent> {
    const relPath = path.isAbsolute(writtenPath)
      ? path.relative(this.opts.cwd, writtenPath)
      : writtenPath;

    // Normalise Windows-style separators just in case
    const normalised = relPath.split(path.sep).join("/");

    for (const recipe of this.opts.recipes) {
      const patterns = recipe.frontmatter.watchPaths ?? [];
      const matches = patterns.some(pattern => minimatch(normalised, pattern, { dot: true }));
      if (matches) {
        yield {
          type: "command_output",
          message: `Tip: /${recipe.name} may be relevant — ${recipe.description}`,
          kind: "info",
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // NOTES.md auto-update
  // ---------------------------------------------------------------------------

  /**
   * After each complete turn, asks a lightweight model to identify any facts
   * worth persisting to NOTES.md. Responds either with a note to append or
   * the literal string "SKIP" when nothing is worth saving.
   *
   * Uses the auxiliary model when available to reduce cost.
   */
  private async *autoUpdateNotes(): AsyncGenerator<EngineEvent, void, unknown> {
    // Only consider the last user+assistant exchange to keep the prompt small
    const recentMessages = this.getLastTurnMessages();
    if (recentMessages.length === 0) return;

    const client = this.opts.auxiliaryClient ?? this.opts.modelClient;
    const model = this.opts.config.auxiliary?.name ?? this.currentModel;

    const turnText = recentMessages
      .map(m => {
        if (m.role === "tool") return `[tool result]: ${(m.content ?? "").slice(0, 300)}`;
        if (m.tool_calls && m.tool_calls.length > 0) {
          return `[assistant called tools: ${m.tool_calls.map(tc => tc.function.name).join(", ")}]`;
        }
        return `[${m.role}]: ${(m.content ?? "").slice(0, 600)}`;
      })
      .join("\n");

    const systemPrompt = `You are a memory curator for an AI agent.
Your job: read the latest conversation turn and extract facts worth keeping in long-term notes.

Rules:
- Output SKIP if there is nothing new worth remembering (e.g. casual chitchat, purely ephemeral tasks).
- Otherwise output a compact Markdown note (max 200 words) summarising: decisions made, files modified, key facts learned, current task state.
- Do not repeat information already obvious from the conversation.
- Write in past tense. No preamble — just the note content, or SKIP.`;

    const userContent = `Conversation turn:\n\n${turnText}`;

    let noteText = "";
    for await (const event of streamChat(client, {
      model,
      messages: [{ role: "user", content: userContent }],
      systemPrompt,
      maxTokens: 256,
    })) {
      if (event.type === "text_delta") noteText += event.delta;
      if (event.type === "error") return; // silently skip on error
    }

    noteText = noteText.trim();
    if (!noteText || noteText.toUpperCase().startsWith("SKIP")) return;

    try {
      const manager = createNotesManager(this.opts.profileDir);
      await manager.append(noteText);
      this.invalidateSystemPrompt();
      // Reuse notes_shown to surface the written note in the UI so the user
      // knows what was persisted (same event the /notes show command uses).
      yield { type: "notes_shown", content: `✎ Auto-saved to NOTES.md:\n\n${noteText}` };
    } catch (err) {
      // Non-fatal but visible — surface the error so the user knows
      // why memory was not updated (e.g. disk full, permission denied).
      yield {
        type: "command_output",
        message: `NOTES.md auto-update failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error",
      };
    }
  }

  /** Returns the messages from the last user input onward (current turn only) */
  private getLastTurnMessages(): ChatMessage[] {
    // Walk backwards to find the most recent user message boundary.
    // We want messages from the LAST user message onward, not the second-to-last.
    // The previous implementation returned the slice after the second-to-last user
    // message, which is correct for multi-turn conversations but falls back to the
    // entire history on the first turn — potentially sending thousands of tokens to
    // the summarizer. Cap at the last user message instead.
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === "user") {
        return this.messages.slice(i);
      }
    }
    return [];
  }

  private buildUsageEvent(systemPrompt: string): EngineEvent {
    const snapshot = computeBudgetSnapshot(
      this.messages,
      systemPrompt,
      this.opts.config.context,
      this.currentModel
    );
    this.currentRatio = snapshot.usageRatio;
    this.currentContextWindowSize = snapshot.contextWindowSize;
    return {
      type: "usage_updated",
      sessionUsage: {
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        estimatedCostUsd: this.estimatedCostUsd,
        currentRatio: snapshot.usageRatio,
        contextWindowSize: snapshot.contextWindowSize,
      },
    };
  }

  /** Restores messages from a previous session */
  static async restoreSession(
    db: Database.Database,
    sessionId: string,
    opts: EngineOptions
  ): Promise<ConversationEngine> {
    const rows = loadMessagesForSession(db, sessionId);
    const messages = rowsToChatMessages(rows);
    return new ConversationEngine({ ...opts, sessionId, initialMessages: messages });
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Produces a one-line human-readable description of a tool invocation.
 * Shown in the ToolCallCard while the tool is running so the user can see
 * what the model is doing (e.g. "src/main.ts" rather than just "ReadFile").
 */
function buildToolDescription(toolName: string, input: Record<string, unknown>): string {
  // Generic extraction: pick the most meaningful single-value field.
  const path    = typeof input["path"]    === "string" ? input["path"]    : null;
  const command = typeof input["command"] === "string" ? input["command"] : null;
  const pattern = typeof input["pattern"] === "string" ? input["pattern"] : null;
  const query   = typeof input["query"]   === "string" ? input["query"]   : null;
  const content = typeof input["content"] === "string" ? input["content"] : null;

  if (path)    return path;
  if (command) return command.length > 60 ? command.slice(0, 59) + "…" : command;
  if (pattern) return pattern.length > 60 ? pattern.slice(0, 59) + "…" : pattern;
  if (query)   return query.length   > 60 ? query.slice(0, 59)   + "…" : query;
  // WriteNotes / ReadNotes
  if (toolName === "WriteNotes" && content) return content.slice(0, 60) + (content.length > 60 ? "…" : "");
  if (toolName === "ReadNotes")  return "NOTES.md";
  return "";
}
