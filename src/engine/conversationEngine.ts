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
import { type RecipeDescriptor } from "../context/promptBuilder.js";
import {
  computeBudgetSnapshot,
  estimateCostUsd,
} from "../context/tokenBudget.js";
import { compressContext, type CompressorDeps } from "../context/compressor.js";
import { createNotesManager } from "../memory/notesManager.js";
import { getToolsAsOpenAIFunctions } from "../tools/registry.js";
import { type PermissionRequest } from "../permissions/guard.js";
import { routeCommand, type CommandContext } from "./commandRouter.js";
import { expandRecipe } from "../recipes/recipeRegistry.js";
import { clearSessionTasks } from "../tools/tasks.js";
import type { ChatMessage, OpenAIToolCall, TokenUsage } from "../types/messages.js";
import type { MemoAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import { SystemPromptManager } from "./services/SystemPromptManager.js";
import { ToolExecutor } from "./services/ToolExecutor.js";

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
  private flushedInputTokens = 0;
  private flushedOutputTokens = 0;
  private flushedCostUsd = 0;
  private currentRatio = 0;
  private currentContextWindowSize = 0;
  private permissionMode: "ask" | "auto";
  private currentModel: string;
  private abortController: AbortController | null = null;
  private isFirstMessage: boolean;

  private pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private recipeAllowedTools: Set<string> = new Set();
  private sessionAlwaysAllowedTools: Set<string> = new Set();

  private readonly sysPromptManager = new SystemPromptManager();
  private readonly toolExecutor: ToolExecutor;

  constructor(private readonly opts: EngineOptions) {
    this.messages = opts.initialMessages ?? [];
    this.sessionId = opts.sessionId;
    this.permissionMode = opts.permissionMode ?? opts.config.permissions.mode;
    this.currentModel = opts.config.model.name;
    this.isFirstMessage = this.messages.length === 0;

    this.toolExecutor = new ToolExecutor({
      cwd: opts.cwd,
      profileDir: opts.profileDir,
      db: opts.db,
      config: opts.config,
      recipes: opts.recipes,
      getSessionId: () => this.sessionId,
      getPermissionMode: () => this.permissionMode,
      getAbortController: () => this.abortController,
      getRecipeAllowedTools: () => this.recipeAllowedTools,
      getSessionAlwaysAllowedTools: () => this.sessionAlwaysAllowedTools,
      onMessageAppended: (toolCallId, toolName, content, isError) => {
        const toolMsg: ChatMessage = {
          role: "tool",
          content: isError ? `Error: ${content}` : content,
          tool_call_id: toolCallId,
          name: toolName,
        };
        this.messages = [...this.messages, toolMsg];
      },
      onSessionAlwaysAllow: toolName => {
        this.sessionAlwaysAllowedTools.add(toolName);
      },
      onWaitForPermission: requestId => this.waitForPermission(requestId),
      onInvalidateSystemPrompt: () => this.sysPromptManager.invalidate(),
    });

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

  /** Updates the active config (e.g. after a hot-reload) and invalidates the system prompt cache */
  updateConfig(newConfig: MemoAgentConfig): void {
    this.opts.config = newConfig;
    this.currentModel = newConfig.model.name;
    this.sysPromptManager.invalidate();
  }

  /** Interrupts the current streaming operation and resolves all pending permissions as denied */
  interrupt(): void {
    this.abortController?.abort();
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

    let messageBody = trimmed;
    let markerText: string | null = null;
    this.recipeAllowedTools = new Set();

    if (trimmed.startsWith("/")) {
      const expansion = expandRecipe(this.opts.recipes, trimmed);
      if (expansion) {
        messageBody = expansion.bodyText;
        markerText = expansion.markerText;
        this.recipeAllowedTools = new Set(expansion.allowedTools);
      } else {
        yield* this.handleCommand(trimmed);
        return;
      }
    }

    const systemPrompt = await this.sysPromptManager.get(this.buildPromptOptions());

    for (const source of this.sysPromptManager.drainWarnings()) {
      yield { type: "injection_warning", source };
    }

    const snapshot = computeBudgetSnapshot(
      this.messages,
      systemPrompt,
      this.opts.config.context,
      this.currentModel
    );

    if (snapshot.isAboveCompress) {
      yield* this.performCompression(systemPrompt, "auto");
    } else if (snapshot.isAboveWarn) {
      yield { type: "token_warning", ratio: snapshot.usageRatio, level: "warn" };
    }

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

    if (this.isFirstMessage) {
      this.isFirstMessage = false;
      setSessionTitle(this.opts.db, this.sessionId, trimmed.slice(0, 80));
    }

    yield { type: "messages_updated", messages: this.messages };
    yield this.buildUsageEvent(systemPrompt);

    yield* this.runToolCallLoop(systemPrompt);

    if (this.opts.config.memory.autoUpdate) {
      yield* this.autoUpdateNotes();
    }

    pruneOldSessions(this.opts.db);
  }

  // ---------------------------------------------------------------------------
  // Tool call loop
  // ---------------------------------------------------------------------------

  private async *runToolCallLoop(systemPrompt: string): AsyncGenerator<EngineEvent, void, unknown> {
    this.abortController = new AbortController();
    let rounds = 0;

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
            yield { type: "error", message: event.error.message, code: event.error.code };
            return;
        }
      }

      if (!streamDone) break;

      const turnCost = estimateCostUsd(turnUsage, this.currentModel);
      this.totalInputTokens += turnUsage.promptTokens;
      this.totalOutputTokens += turnUsage.completionTokens;
      this.estimatedCostUsd += turnCost;

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

      if (stopReason === "tool_calls" && accumulatedToolCalls.length > 0) {
        yield* this.toolExecutor.executeAll(accumulatedToolCalls);
        continue;
      }

      break;
    }

    if (rounds >= MAX_TOOL_CALL_ROUNDS) {
      yield {
        type: "error",
        message: `Reached maximum tool call rounds (${MAX_TOOL_CALL_ROUNDS}). Use /clear to reset context.`,
        code: "MAX_ROUNDS_EXCEEDED",
      };
    }

    const newInput = this.totalInputTokens - this.flushedInputTokens;
    const newOutput = this.totalOutputTokens - this.flushedOutputTokens;
    const newCost = this.estimatedCostUsd - this.flushedCostUsd;

    if (newInput > 0 || newOutput > 0) {
      updateSessionStats(this.opts.db, this.sessionId, newInput, newOutput, newCost);
    }

    this.flushedInputTokens = this.totalInputTokens;
    this.flushedOutputTokens = this.totalOutputTokens;
    this.flushedCostUsd = this.estimatedCostUsd;

    const finalSnapshot = computeBudgetSnapshot(
      this.messages,
      systemPrompt,
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
      const result = await compressContext(this.messages, systemPrompt, focus, compressorDeps);

      if (result.summary) {
        const archivedSessionId = this.sessionId;
        const newSessionId = crypto.randomUUID();

        createSession(this.opts.db, {
          id: newSessionId,
          title: `[compressed] ${new Date().toISOString().slice(0, 10)}`,
          model: this.currentModel,
          parentSessionId: archivedSessionId,
          inputTokens: this.totalInputTokens,
          outputTokens: this.totalOutputTokens,
          estimatedCostUsd: this.estimatedCostUsd,
        });

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
        this.sysPromptManager.invalidate();
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
        const systemPrompt = await this.sysPromptManager.get(this.buildPromptOptions());
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
        yield { type: "command_output", message: `Permission mode switched to: ${result.mode}`, kind: "info" };
        break;

      case "switch_model":
        this.currentModel = result.name;
        yield { type: "command_output", message: `Model switched to: ${result.name}`, kind: "info" };
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
        this.sysPromptManager.invalidate();
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

  // ---------------------------------------------------------------------------
  // NOTES.md auto-update
  // ---------------------------------------------------------------------------

  private async *autoUpdateNotes(): AsyncGenerator<EngineEvent, void, unknown> {
    const recentMessages = this.getLastTurnMessages();
    if (recentMessages.length === 0) return;

    // Quick skip: pure text exchange with no tool calls is rarely worth persisting.
    const hasToolActivity = recentMessages.some(
      m => m.role === "tool" || (m.tool_calls && m.tool_calls.length > 0)
    );
    const isTrivialTurn = !hasToolActivity && recentMessages.length <= 3;
    if (isTrivialTurn) return;

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

    let noteText = "";
    for await (const event of streamChat(client, {
      model,
      messages: [{ role: "user", content: `Conversation turn:\n\n${turnText}` }],
      systemPrompt,
      maxTokens: 256,
    })) {
      if (event.type === "text_delta") noteText += event.delta;
      if (event.type === "error") return;
    }

    noteText = noteText.trim();
    if (!noteText || noteText.toUpperCase().startsWith("SKIP")) return;

    // Security: scan LLM output before persisting — the model's output is itself
    // an injection vector if the conversation processed attacker-controlled content.
    const { scanForInjection } = await import("../context/promptBuilder.js");
    if (scanForInjection(noteText)) {
      yield {
        type: "command_output",
        message: "NOTES.md auto-update blocked: potential injection pattern detected in generated note.",
        kind: "error",
      };
      return;
    }

    try {
      const manager = createNotesManager(this.opts.profileDir);
      const written = await manager.append(noteText);
      if (!written) return; // skipped as duplicate — no notification needed
      this.sysPromptManager.invalidate();
      yield { type: "notes_shown", content: `✎ Auto-saved to NOTES.md:\n\n${noteText}` };
    } catch (err) {
      yield {
        type: "command_output",
        message: `NOTES.md auto-update failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error",
      };
    }
  }

  private getLastTurnMessages(): ChatMessage[] {
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

  private buildPromptOptions() {
    const recipeDescriptors: RecipeDescriptor[] = this.opts.recipes.map(r => ({
      name: r.name,
      description: r.description,
      scope: r.scope,
    }));
    return {
      cwd: this.opts.cwd,
      profileDir: this.opts.profileDir,
      config: this.opts.config,
      recipes: recipeDescriptors,
    };
  }

  private waitForPermission(requestId: string): Promise<PermissionDecision> {
    return new Promise(resolve => {
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
