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
  dbGetTask,
  dbListTasks,
  dbUpdateTask,
  getSession,
  loadMessagesForSession,
  pruneOldSessions,
  rowsToChatMessages,
  setSessionTitle,
  updateSessionStats,
} from "../session/db.js";
import { streamChat } from "../model/streaming.js";
import { type RecipeDescriptor, scanForInjection } from "../context/promptBuilder.js";
import {
  computeBudgetSnapshot,
  estimateCostUsd,
  estimateTokenCount,
  getContextWindowSize,
} from "../context/tokenBudget.js";
import { compressContext, type CompressorDeps } from "../context/compressor.js";
import { createNotesManager } from "../memory/notesManager.js";
import { getToolsAsOpenAIFunctions, setDisabledTools } from "../tools/registry.js";
import { type PermissionRequest } from "../permissions/guard.js";
import { routeCommand, type CommandContext } from "./commandRouter.js";
import { expandRecipe } from "../recipes/recipeRegistry.js";
import type { Task } from "../tools/tasks.js";
import type { ChatMessage, OpenAIToolCall, TokenUsage } from "../types/messages.js";
import type { MemoAgentConfig } from "../types/config.js";
import type { Recipe } from "../recipes/recipeRegistry.js";
import { SystemPromptManager } from "./services/SystemPromptManager.js";
import { ToolExecutor } from "./services/ToolExecutor.js";
import { createClientFromConfig } from "../model/client.js";

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
  | { type: "session_restored"; messages: ChatMessage[]; sessionUsage: SessionUsage }
  | { type: "notes_shown"; content: string }
  | { type: "notes_cleared" }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string; decision: PermissionDecision }
  | { type: "exit_requested" }
  | { type: "injection_warning"; source: string }
  | { type: "error"; message: string; code: string }
  | { type: "agent_plan_start" }
  | { type: "agent_task_start"; taskId: string; subject: string; index: number; total: number }
  | { type: "agent_task_done"; taskId: string; subject: string; status: "completed" | "failed" }
  | { type: "agent_reflect_start" };

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  currentRatio: number;
  contextWindowSize: number;
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

interface ToolLoopResult {
  completed: boolean;
  aborted: boolean;
  failed: boolean;
}

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
  private pendingEvents: EngineEvent[] = [];
  private recipeAllowedTools: Set<string> = new Set();
  private sessionAlwaysAllowedTools: Set<string> = new Set();
  private notesUpdateChain: Promise<void> = Promise.resolve();
  private notesAbortController: AbortController | null = null;
  private shuttingDown = false;

  private readonly sysPromptManager = new SystemPromptManager();
  private readonly toolExecutor: ToolExecutor;

  constructor(private readonly opts: EngineOptions) {
    this.messages = opts.initialMessages ?? [];
    this.sessionId = opts.sessionId;
    this.permissionMode = opts.permissionMode ?? opts.config.permissions.mode;
    this.currentModel = opts.config.model.name;
    this.isFirstMessage = this.messages.length === 0;
    this.currentContextWindowSize = getContextWindowSize(
      this.currentModel,
      opts.config.model.contextWindowTokens,
    );
    this.currentRatio = this.currentContextWindowSize > 0
      ? estimateTokenCount(this.messages, "") / this.currentContextWindowSize
      : 0;

    this.toolExecutor = new ToolExecutor({
      cwd: opts.cwd,
      profileDir: opts.profileDir,
      db: opts.db,
      getConfig: () => this.opts.config,
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

    const existingSession = getSession(opts.db, this.sessionId);
    if (existingSession) {
      this.totalInputTokens = existingSession.inputTokens;
      this.totalOutputTokens = existingSession.outputTokens;
      this.estimatedCostUsd = existingSession.estimatedCostUsd;
      this.flushedInputTokens = existingSession.inputTokens;
      this.flushedOutputTokens = existingSession.outputTokens;
      this.flushedCostUsd = existingSession.estimatedCostUsd;
    } else {
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

    pruneOldSessions(opts.db);
  }

  /** Updates the active config (e.g. after a hot-reload) and invalidates the system prompt cache */
  updateConfig(newConfig: MemoAgentConfig): void {
    this.opts.config = newConfig;
    this.currentModel = newConfig.model.name;
    this.opts.modelClient = createClientFromConfig(newConfig.model);
    this.opts.auxiliaryClient = newConfig.auxiliary ? createClientFromConfig(newConfig.auxiliary) : null;
    setDisabledTools(newConfig.permissions.disabledTools);
    this.currentContextWindowSize = getContextWindowSize(
      this.currentModel,
      newConfig.model.contextWindowTokens,
    );
    this.currentRatio = this.currentContextWindowSize > 0
      ? estimateTokenCount(this.messages, "") / this.currentContextWindowSize
      : 0;
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

  /** Finishes background memory work before the UI and database shut down. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.interrupt();
    this.notesAbortController?.abort();
    await this.notesUpdateChain;
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

    // Drain events queued by background operations (e.g. notes auto-update from
    // the previous turn). Yielded here so the UI sees them before the new turn.
    for (const event of this.pendingEvents.splice(0)) {
      yield event;
    }

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

    const userMessage: ChatMessage = {
      role: "user",
      content: markerText ? `${markerText}\n\n${messageBody}` : messageBody,
    };
    const toolDefs = getToolsAsOpenAIFunctions();
    const snapshot = computeBudgetSnapshot(
      [...this.messages, userMessage],
      systemPrompt,
      this.opts.config.context,
      this.currentModel,
      this.opts.config.model.contextWindowTokens,
      toolDefs,
    );

    if (snapshot.isAboveCompress) {
      yield* this.performCompression(systemPrompt, "auto");
    } else if (snapshot.isAboveWarn) {
      yield { type: "token_warning", ratio: snapshot.usageRatio, level: "warn" };
    }

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

    const loopResult = yield* this.runToolCallLoop(systemPrompt);

    if (loopResult.completed && this.opts.config.memory.autoUpdate && !this.shuttingDown) {
      // Fire-and-forget: runs after the response is delivered to the user.
      // Any events it produces are queued in pendingEvents and yielded at the
      // start of the next submitMessage call, so the UI isn't blocked.
      const recentMessages = this.getLastTurnMessages();
      this.notesUpdateChain = this.notesUpdateChain
        .then(() => this.autoUpdateNotes(recentMessages))
        .catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Tool call loop
  // ---------------------------------------------------------------------------

  private async *runToolCallLoop(
    systemPrompt: string,
    opts?: { allowedToolNames?: string[]; maxRounds?: number }
  ): AsyncGenerator<EngineEvent, ToolLoopResult, unknown> {
    this.abortController = new AbortController();
    let rounds = 0;
    let completed = false;
    let aborted = false;
    let failed = false;
    let needsAnotherRound = false;

    const allToolDefs = getToolsAsOpenAIFunctions();
    const toolDefs = opts?.allowedToolNames
      ? allToolDefs.filter(t => {
          const name = (t as { function?: { name?: string } }).function?.name;
          return name !== undefined && (opts.allowedToolNames as string[]).includes(name);
        })
      : allToolDefs;

    const maxRounds = opts?.maxRounds ?? this.opts.config.limits.maxToolCallRounds;

    outer: while (rounds < maxRounds) {
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
        abortSignal: (this.abortController as AbortController).signal,
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
            failed = true;
            break outer;
        }
      }

      if (!streamDone) {
        failed = true;
        break;
      }

      const turnCost = estimateCostUsd(turnUsage, this.currentModel);
      this.totalInputTokens += turnUsage.promptTokens;
      this.totalOutputTokens += turnUsage.completionTokens;
      this.estimatedCostUsd += turnCost;

      const persistedContent = stopReason === "aborted" && assistantContent
        ? `${assistantContent} [interrupted]`
        : assistantContent;
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: persistedContent || null,
        ...(accumulatedToolCalls.length > 0 && { tool_calls: accumulatedToolCalls }),
      };

      this.messages = [...this.messages, assistantMessage];

      appendMessage(this.opts.db, {
        sessionId: this.sessionId,
        role: "assistant",
        content: persistedContent || null,
        toolCallsJson: accumulatedToolCalls.length > 0 ? JSON.stringify(accumulatedToolCalls) : null,
        toolCallId: null,
        tokenCount: turnUsage.completionTokens,
      });

      yield { type: "messages_updated", messages: this.messages };
      yield this.buildUsageEvent(systemPrompt);

      if (stopReason === "aborted") {
        aborted = true;
        break;
      }

      if (stopReason === "length") {
        yield {
          type: "error",
          message: "The model response reached its output-token limit and may be incomplete.",
          code: "OUTPUT_TRUNCATED",
        };
        failed = true;
        break;
      }

      if (stopReason === "tool_calls" && accumulatedToolCalls.length > 0) {
        yield* this.toolExecutor.executeAll(accumulatedToolCalls);
        if (this.abortController.signal.aborted) {
          aborted = true;
          break;
        }
        needsAnotherRound = true;
        continue;
      }

      completed = true;
      needsAnotherRound = false;
      break;
    }

    if (needsAnotherRound && rounds >= maxRounds && !aborted && !failed) {
      yield {
        type: "error",
        message: `Reached maximum tool call rounds (${maxRounds}). Use /clear to reset context.`,
        code: "MAX_ROUNDS_EXCEEDED",
      };
      failed = true;
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
      this.currentModel,
      this.opts.config.model.contextWindowTokens,
      toolDefs,
    );

    if (finalSnapshot.isAboveWarn) {
      yield {
        type: "token_warning",
        ratio: finalSnapshot.usageRatio,
        level: finalSnapshot.isAboveCompress ? "critical" : "warn",
      };
    }

    this.abortController = null;
    return { completed: completed && !failed && !aborted, aborted, failed };
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
        const archivedSession = getSession(this.opts.db, archivedSessionId);
        const compressionModel = this.opts.config.auxiliary?.name ?? this.currentModel;
        const compressionCost = estimateCostUsd(result.usage, compressionModel);
        this.totalInputTokens += result.usage.promptTokens;
        this.totalOutputTokens += result.usage.completionTokens;
        this.estimatedCostUsd += compressionCost;
        if (result.usage.totalTokens > 0) {
          updateSessionStats(
            this.opts.db,
            archivedSessionId,
            result.usage.promptTokens,
            result.usage.completionTokens,
            compressionCost,
          );
        }

        createSession(this.opts.db, {
          id: newSessionId,
          title: `[compressed] ${(archivedSession?.title || new Date().toISOString().slice(0, 10)).slice(0, 100)}`,
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
  // Agent Loop: Plan → Execute → Reflect
  // ---------------------------------------------------------------------------

  private async *runAgentLoop(
    systemPrompt: string,
    goal: string
  ): AsyncGenerator<EngineEvent, void, unknown> {
    // === PHASE 1: PLAN ===
    yield { type: "agent_plan_start" };
    const existingTaskIds = new Set(dbListTasks(this.opts.db, this.sessionId).map(task => task.id));

    const planningContent = buildPlanningPrompt(goal);
    const planningMsg: ChatMessage = { role: "user", content: planningContent };
    this.messages = [...this.messages, planningMsg];
    appendMessage(this.opts.db, {
      sessionId: this.sessionId,
      role: "user",
      content: planningContent,
      toolCallsJson: null,
      toolCallId: null,
      tokenCount: 0,
    });

    if (this.isFirstMessage) {
      this.isFirstMessage = false;
      setSessionTitle(this.opts.db, this.sessionId, `[plan] ${goal.slice(0, 75)}`);
    }

    yield { type: "messages_updated", messages: this.messages };
    yield this.buildUsageEvent(systemPrompt);

    // Planning phase: task creation and dependency updates only.
    const planningResult = yield* this.runToolCallLoop(systemPrompt, {
      allowedToolNames: ["CreateTask", "UpdateTask", "ListTasks"],
      maxRounds: this.opts.config.limits.maxAgentPlanningRounds,
    });
    if (!planningResult.completed) {
      yield {
        type: "command_output",
        message: planningResult.aborted ? "Planning interrupted." : "Planning failed before tasks were ready.",
        kind: "error",
      };
      return;
    }

    // Load tasks created during planning phase
    const createdRows = dbListTasks(this.opts.db, this.sessionId)
      .filter(task => !existingTaskIds.has(task.id));
    const createdTasks: Task[] = createdRows.map(r => ({
      id: r.id,
      subject: r.subject,
      description: r.description,
      status: r.status,
      blockedBy: JSON.parse(r.blockedBy) as string[],
      blocks: JSON.parse(r.blocks) as string[],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    if (createdTasks.length === 0) {
      yield { type: "command_output", message: "No tasks were planned. Executing directly.", kind: "info" };
      yield* this.runToolCallLoop(systemPrompt);
      return;
    }

    // === PHASE 2: EXECUTE ===
    let orderedTasks: Task[];
    try {
      orderedTasks = resolveExecutionOrder(createdTasks);
    } catch (err) {
      yield {
        type: "command_output",
        message: err instanceof Error ? err.message : String(err),
        kind: "error",
      };
      return;
    }
    const total = orderedTasks.length;

    for (let i = 0; i < orderedTasks.length; i++) {
      const task = orderedTasks[i] as Task;
      const index = i + 1;

      dbUpdateTask(this.opts.db, this.sessionId, task.id, { status: "in_progress" });
      yield { type: "agent_task_start", taskId: task.id, subject: task.subject, index, total };

      const execContent = buildTaskExecutionPrompt(task, index, total);
      const execMsg: ChatMessage = { role: "user", content: execContent };
      this.messages = [...this.messages, execMsg];
      appendMessage(this.opts.db, {
        sessionId: this.sessionId,
        role: "user",
        content: execContent,
        toolCallsJson: null,
        toolCallId: null,
        tokenCount: 0,
      });

      yield { type: "messages_updated", messages: this.messages };
      yield this.buildUsageEvent(systemPrompt);

      const taskResult = yield* this.runToolCallLoop(systemPrompt);

      if (!taskResult.completed) {
        dbUpdateTask(this.opts.db, this.sessionId, task.id, { status: "failed" });
        yield { type: "agent_task_done", taskId: task.id, subject: task.subject, status: "failed" };
        yield {
          type: "command_output",
          message: taskResult.aborted
            ? `Task interrupted: ${task.subject}`
            : `Task failed: ${task.subject}. Remaining dependent tasks were not executed.`,
          kind: "error",
        };
        return;
      }

      // Mark completed if model didn't do so explicitly
      const freshRow = dbGetTask(this.opts.db, this.sessionId, task.id);
      if (freshRow?.status === "failed") {
        yield { type: "agent_task_done", taskId: task.id, subject: task.subject, status: "failed" };
        yield {
          type: "command_output",
          message: `Task reported failure: ${task.subject}. Remaining dependent tasks were not executed.`,
          kind: "error",
        };
        return;
      }
      if (freshRow?.status !== "completed") {
        dbUpdateTask(this.opts.db, this.sessionId, task.id, { status: "completed" });
      }

      yield { type: "agent_task_done", taskId: task.id, subject: task.subject, status: "completed" };
    }

    // === PHASE 3: REFLECT ===
    yield { type: "agent_reflect_start" };

    const reflectContent = buildReflectPrompt(total);
    const reflectMsg: ChatMessage = { role: "user", content: reflectContent };
    this.messages = [...this.messages, reflectMsg];
    appendMessage(this.opts.db, {
      sessionId: this.sessionId,
      role: "user",
      content: reflectContent,
      toolCallsJson: null,
      toolCallId: null,
      tokenCount: 0,
    });

    yield { type: "messages_updated", messages: this.messages };
    yield this.buildUsageEvent(systemPrompt);

    // Reflect: read-only tools only, single pass
    yield* this.runToolCallLoop(systemPrompt, {
      allowedToolNames: ["ReadFile", "ListFiles", "SearchCode", "ListTasks", "GetTask"],
      maxRounds: 2,
    });
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
        this.messages = [];
        this.isFirstMessage = true;
        this.sessionId = crypto.randomUUID();
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        this.estimatedCostUsd = 0;
        this.flushedInputTokens = 0;
        this.flushedOutputTokens = 0;
        this.flushedCostUsd = 0;
        this.currentRatio = 0;
        this.currentContextWindowSize = getContextWindowSize(
          this.currentModel,
          this.opts.config.model.contextWindowTokens,
        );
        this.sessionAlwaysAllowedTools.clear();
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
        yield { type: "usage_updated", sessionUsage: this.getUsage() };
        break;

      case "compact": {
        const systemPrompt = await this.sysPromptManager.get(this.buildPromptOptions());
        yield* this.performCompression(systemPrompt, "manual", result.focus);
        yield this.buildUsageEvent(systemPrompt);
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
        const session = getSession(this.opts.db, targetId);
        if (!session) {
          yield {
            type: "command_output",
            message: `Session ${targetId} not found. Use /history to list available sessions.`,
            kind: "error",
          };
          break;
        }
        const rows = loadMessagesForSession(this.opts.db, targetId);
        this.messages = rowsToChatMessages(rows);
        this.sessionId = targetId;
        this.isFirstMessage = rows.length === 0;
        this.totalInputTokens = session.inputTokens;
        this.totalOutputTokens = session.outputTokens;
        this.estimatedCostUsd = session.estimatedCostUsd;
        this.flushedInputTokens = session.inputTokens;
        this.flushedOutputTokens = session.outputTokens;
        this.flushedCostUsd = session.estimatedCostUsd;
        this.sessionAlwaysAllowedTools.clear();
        this.sysPromptManager.invalidate();
        const restoredPrompt = await this.sysPromptManager.get(this.buildPromptOptions());
        const usageEvent = this.buildUsageEvent(restoredPrompt);
        const sessionUsage = usageEvent.type === "usage_updated" ? usageEvent.sessionUsage : this.getUsage();
        yield { type: "session_restored", messages: this.messages, sessionUsage };
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

      case "agent_plan": {
        const systemPrompt = await this.sysPromptManager.get(this.buildPromptOptions());
        for (const source of this.sysPromptManager.drainWarnings()) {
          yield { type: "injection_warning", source };
        }
        yield* this.runAgentLoop(systemPrompt, result.goal);
        break;
      }

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
  // NOTES.md auto-update (fire-and-forget)
  // ---------------------------------------------------------------------------

  private async autoUpdateNotes(recentMessages: ChatMessage[]): Promise<void> {
    if (this.shuttingDown || recentMessages.length === 0) return;

    // Quick skip: pure text exchange with no tool calls is rarely worth persisting.
    const hasToolActivity = recentMessages.some(
      m => m.role === "tool" || (m.tool_calls && m.tool_calls.length > 0)
    );
    const isTrivialTurn = !hasToolActivity && recentMessages.length <= 3;
    if (isTrivialTurn) return;

    const abortController = new AbortController();
    this.notesAbortController = abortController;

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
    try {
      for await (const event of streamChat(client, {
        model,
        messages: [{ role: "user", content: `Conversation turn:\n\n${turnText}` }],
        systemPrompt,
        maxTokens: 256,
        abortSignal: abortController.signal,
      })) {
        if (event.type === "text_delta") noteText += event.delta;
        if (event.type === "error") return;
      }
    } finally {
      if (this.notesAbortController === abortController) {
        this.notesAbortController = null;
      }
    }

    if (this.shuttingDown || abortController.signal.aborted) return;
    noteText = noteText.trim();
    if (!noteText || noteText.toUpperCase().startsWith("SKIP")) return;

    // Security: scan LLM output before persisting — the model's output is itself
    // an injection vector if the conversation processed attacker-controlled content.
    if (scanForInjection(noteText)) {
      this.pendingEvents.push({
        type: "command_output",
        message: "NOTES.md auto-update blocked: potential injection pattern detected in generated note.",
        kind: "error",
      });
      return;
    }

    try {
      const manager = createNotesManager(this.opts.profileDir);
      const written = await manager.append(noteText);
      if (!written) return; // skipped as duplicate — no notification needed
      this.sysPromptManager.invalidate();
      this.pendingEvents.push({ type: "notes_shown", content: `✎ Auto-saved to NOTES.md:\n\n${noteText}` });
    } catch (err) {
      this.pendingEvents.push({
        type: "command_output",
        message: `NOTES.md auto-update failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error",
      });
    }
  }

  private getLastTurnMessages(): ChatMessage[] {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if ((this.messages[i] as ChatMessage).role === "user") {
        return this.messages.slice(i);
      }
    }
    return [];
  }

  private buildUsageEvent(systemPrompt: string): EngineEvent {
    const toolDefs = getToolsAsOpenAIFunctions();
    const snapshot = computeBudgetSnapshot(
      this.messages,
      systemPrompt,
      this.opts.config.context,
      this.currentModel,
      this.opts.config.model.contextWindowTokens,
      toolDefs,
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

// ---------------------------------------------------------------------------
// Agent loop helpers (module-level pure functions)
// ---------------------------------------------------------------------------

function buildPlanningPrompt(goal: string): string {
  return `<agent-planning>
Goal: ${goal}

Before doing anything else, break this goal into concrete, actionable tasks using CreateTask.
Create 3-7 tasks maximum. Use blockedBy and blocks with task IDs to express dependencies.
During planning, only use CreateTask, UpdateTask, and ListTasks. Do not execute implementation actions yet.
</agent-planning>`;
}

function buildTaskExecutionPrompt(task: Task, index: number, total: number): string {
  return `<agent-task index="${index}" total="${total}">
Now execute task #${task.id}: ${task.subject}
${task.description}

Use the available tools to complete this task fully.
When done, call UpdateTask to mark task #${task.id} as "completed".
</agent-task>`;
}

function buildReflectPrompt(total: number): string {
  return `<agent-reflect>
All ${total} planned tasks have been executed. Provide a concise 2-3 sentence summary of what was accomplished and any important outcomes or side effects.
</agent-reflect>`;
}

/** Topological sort (Kahn's algorithm) respecting blockedBy dependencies */
function resolveExecutionOrder(tasks: Task[]): Task[] {
  if (tasks.length === 0) return [];

  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const inDegree = new Map<string, number>(tasks.map(t => [t.id, 0]));

  for (const task of tasks) {
    for (const depId of task.blockedBy) {
      if (!taskMap.has(depId)) throw new Error(`Task #${task.id} depends on unknown task #${depId}`);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue: Task[] = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0);
  const ordered: Task[] = [];

  while (queue.length > 0) {
    const task = queue.shift() as Task;
    ordered.push(task);

    for (const other of tasks) {
      if (other.blockedBy.includes(task.id)) {
        const newDeg = (inDegree.get(other.id) ?? 0) - 1;
        inDegree.set(other.id, newDeg);
        if (newDeg === 0) {
          queue.push(taskMap.get(other.id) as Task);
        }
      }
    }
  }

  if (ordered.length !== tasks.length) {
    const unresolved = tasks.filter(task => !ordered.some(item => item.id === task.id));
    throw new Error(`Task plan contains circular dependencies: ${unresolved.map(task => `#${task.id}`).join(", ")}`);
  }

  return ordered;
}
