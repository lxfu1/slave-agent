/**
 * Slash command router.
 *
 * Pure function — routes a "/" command string to a typed CommandResult.
 * No side effects, no I/O. All state mutations happen in ConversationEngine.
 * Each command is an explicit case in a switch — no dynamic dispatch.
 */

import type Database from "better-sqlite3";
import { listSessions, searchMessages } from "../session/db.js";

export type CommandResult =
  | { type: "output"; message: string; kind: "info" | "error" | "help" }
  | { type: "exit" }
  | { type: "clear_session" }
  | { type: "compact"; focus?: string }
  | { type: "resume"; sessionId?: string }
  | { type: "switch_profile"; name: string }
  | { type: "switch_mode"; mode: "ask" | "auto" }
  | { type: "switch_model"; name: string }
  | { type: "show_notes" }
  | { type: "clear_notes" }
  | { type: "unknown"; command: string };

export interface CommandContext {
  db: Database.Database;
  currentMode: "ask" | "auto";
  currentModel: string;
  currentProfile: string;
  recipes: Array<{ name: string; description: string; scope: string }>;
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}

const HELP_TEXT = `
Slave Agent — available commands:

  /help                    Show this help
  /notes [show|clear]      View or clear persistent memory (NOTES.md)
  /history [n]             Show recent n sessions (default: 10)
  /search <query>          Full-text search across all message history
  /compact [focus]         Archive older context to free token budget
  /model [name]            Show or switch current model
  /cost                    Show token usage and cost for this session
  /clear                   Clear current session context (memory is preserved)
  /resume [session-id]     Restore a previous session
  /profile [name]          Show or switch current profile
  /recipes                 List available recipes
  /mode [ask|auto]         Show or switch permission mode
  /exit                    Exit slave-agent (alias: /quit)

  /<recipe-name> [args]    Invoke a recipe
`.trim();

/** Routes a slash command to a CommandResult */
export function routeCommand(input: string, ctx: CommandContext): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "unknown", command: trimmed };
  }

  // Split into command name and arguments
  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.indexOf(" ");
  const commandName = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();

  switch (commandName.toLowerCase()) {
    case "help":
      return { type: "output", message: HELP_TEXT, kind: "help" };

    case "notes":
      return handleNotesCommand(args);

    case "history":
      return handleHistoryCommand(args, ctx);

    case "search":
      return handleSearchCommand(args, ctx);

    case "compact":
      return args ? { type: "compact", focus: args } : { type: "compact" };

    case "model":
      return handleModelCommand(args, ctx);

    case "cost":
      return handleCostCommand(ctx);

    case "clear":
      return { type: "clear_session" };

    case "resume":
      return args ? { type: "resume", sessionId: args } : { type: "resume" };

    case "profile":
      return handleProfileCommand(args, ctx);

    case "recipes":
      return handleRecipesCommand(ctx);

    case "mode":
      return handleModeCommand(args, ctx);

    case "exit":
    case "quit":
      return { type: "exit" };

    default:
      // Not a known command — could be a recipe invocation
      return { type: "unknown", command: trimmed };
  }
}

// ---------------------------------------------------------------------------
// Per-command handlers
// ---------------------------------------------------------------------------

function handleNotesCommand(args: string): CommandResult {
  const sub = args.toLowerCase();
  if (!sub || sub === "show") {
    return { type: "show_notes" };
  }
  if (sub === "clear") {
    return { type: "clear_notes" };
  }
  return {
    type: "output",
    message: "Usage: /notes [show|clear]",
    kind: "error",
  };
}

function handleHistoryCommand(args: string, ctx: CommandContext): CommandResult {
  const n = args ? parseInt(args, 10) : 10;
  if (isNaN(n) || n <= 0) {
    return { type: "output", message: "Usage: /history [n]", kind: "error" };
  }

  const sessions = listSessions(ctx.db, n);
  if (sessions.length === 0) {
    return { type: "output", message: "No sessions found.", kind: "info" };
  }

  const lines = sessions.map((s, i) => {
    const date = s.updatedAt.slice(0, 16).replace("T", " ");
    const title = s.title || "(untitled)";
    const tokens = s.inputTokens + s.outputTokens;
    return `${String(i + 1).padStart(2)}. [${s.id.slice(0, 8)}] ${date}  ${title.slice(0, 50)}  (${tokens} tokens)`;
  });

  return {
    type: "output",
    message: `Recent sessions:\n\n${lines.join("\n")}`,
    kind: "info",
  };
}

function handleSearchCommand(args: string, ctx: CommandContext): CommandResult {
  if (!args.trim()) {
    return { type: "output", message: "Usage: /search <query>", kind: "error" };
  }

  const results = searchMessages(ctx.db, args, 15);
  if (results.length === 0) {
    return { type: "output", message: `No results for: ${args}`, kind: "info" };
  }

  const lines = results.map(r => {
    const preview = (r.content ?? "").slice(0, 100).replace(/\n/g, " ");
    return `[${r.sessionTitle.slice(0, 30)}] ${r.role}: ${preview}`;
  });

  return {
    type: "output",
    message: `${results.length} results:\n\n${lines.join("\n")}`,
    kind: "info",
  };
}

function handleModelCommand(args: string, ctx: CommandContext): CommandResult {
  if (!args) {
    return {
      type: "output",
      message: `Current model: ${ctx.currentModel}`,
      kind: "info",
    };
  }
  return { type: "switch_model", name: args };
}

function handleCostCommand(ctx: CommandContext): CommandResult {
  const total = ctx.totalInputTokens + ctx.totalOutputTokens;
  const costStr = ctx.estimatedCostUsd.toFixed(4);
  return {
    type: "output",
    message: [
      `Session: ${ctx.sessionId.slice(0, 8)}`,
      `Input tokens:  ${ctx.totalInputTokens.toLocaleString()}`,
      `Output tokens: ${ctx.totalOutputTokens.toLocaleString()}`,
      `Total tokens:  ${total.toLocaleString()}`,
      `Estimated cost: $${costStr}`,
    ].join("\n"),
    kind: "info",
  };
}

function handleProfileCommand(args: string, ctx: CommandContext): CommandResult {
  if (!args) {
    return {
      type: "output",
      message: `Current profile: ${ctx.currentProfile}`,
      kind: "info",
    };
  }
  return { type: "switch_profile", name: args };
}

function handleRecipesCommand(ctx: CommandContext): CommandResult {
  if (ctx.recipes.length === 0) {
    return {
      type: "output",
      message: "No recipes installed.\n\nAdd .md files to ~/.slave-agent/recipes/ or .slave-agent/recipes/",
      kind: "info",
    };
  }

  const lines = ctx.recipes.map(r => `  /${r.name.padEnd(20)} ${r.description}`);
  return {
    type: "output",
    message: `Available recipes:\n\n${lines.join("\n")}`,
    kind: "info",
  };
}

function handleModeCommand(args: string, ctx: CommandContext): CommandResult {
  if (!args) {
    return {
      type: "output",
      message: `Current mode: ${ctx.currentMode}`,
      kind: "info",
    };
  }
  if (args === "ask" || args === "auto") {
    return { type: "switch_mode", mode: args };
  }
  return {
    type: "output",
    message: "Usage: /mode [ask|auto]",
    kind: "error",
  };
}
