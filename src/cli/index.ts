#!/usr/bin/env node
/**
 * Startup sequence:
 *   1. Parse argv
 *   2. Load .env
 *   3. Check for updates (non-blocking, background)
 *   4. Resolve profile directory
 *   5. Ensure profile directories exist
 *   6. Load configuration
 *   7. Open SQLite database
 *   8. Register built-in tools (side-effect imports)
 *   9. Bootstrap MCP servers (non-blocking, background)
 *  10. Load recipes
 *  11. Restore session if --resume
 *  12. Create model clients
 *  13. Render terminal UI
 *  14. On exit: graceful cleanup
 */

import { createRequire } from "node:module";
import { config as loadDotenv } from "dotenv";
import { render } from "ink";
import React from "react";
import path from "node:path";
import process from "node:process";

import { handleUpdateCheck } from "../updater/checker.js";

// Load .env before anything else reads env vars
loadDotenv({ path: path.join(process.cwd(), ".env") });

import { resolveProfileDir, ensureProfileDirs, loadConfig } from "../config/loader.js";
import { getSession, openDatabase, loadMessagesForSession, rowsToChatMessages, pruneOldSessions } from "../session/db.js";
import { bootstrapMcp, shutdownMcp, type McpServerEntry } from "../mcp/mcpBridge.js";
import { loadRecipes } from "../recipes/recipeRegistry.js";
import { createClientFromConfig } from "../model/client.js";
import { disableTools } from "../tools/registry.js";
import { App } from "../ui/App.js";

// Register all built-in tools (side effects only)
await import("../tools/index.js");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  profile?: string;
  model?: string;
  resumeSessionId?: string;
  permissionMode?: "ask" | "auto";
  showVersion: boolean;
  showHelp: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = { showVersion: false, showHelp: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    switch (arg) {
      case "--version": case "-v":
        result.showVersion = true;
        break;
      case "--help": case "-h":
        result.showHelp = true;
        break;
      case "--auto":
        result.permissionMode = "auto";
        break;
      case "--profile":
        result.profile = args[++i];
        break;
      case "--model":
        result.model = args[++i];
        break;
      case "--resume":
        result.resumeSessionId = args[++i];
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Help and version output
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const VERSION: string = (_require("../../package.json") as { version: string }).version;

const HELP = `
memo-agent v${VERSION} — terminal AI assistant with persistent memory

USAGE
  memo [options]

OPTIONS
  --profile <name>        Use a named profile (default: "default")
  --model <name>          Override the model from config
  --resume [session-id]   Restore a previous session
  --auto                  Start in auto permission mode (no confirmations)
  --version, -v           Print version
  --help, -h              Print this help

COMMANDS (inside the agent)
  /help                   Show all available commands
  /notes [show|clear]     Manage persistent memory
  /history [n]            Browse session history
  /search <query>         Search message history
  /compact [focus]        Archive context to free space
  /cost                   Show token usage and cost
  /mode [ask|auto]        Switch permission mode
  /recipes                List available recipes
  /<recipe-name> [args]   Run a recipe

CONFIG
  ~/.memo-agent/config.yaml   Global configuration
  .env                         Environment variable overrides
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.showVersion) {
    process.stdout.write(`memo-agent v${VERSION}\n`);
    process.exit(0);
  }

  if (cliArgs.showHelp) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  //────────────────────────────────────────────────────────────────────────────
  // Check for updates and prompt user
  //────────────────────────────────────────────────────────────────────────────
  const shouldRestart = await handleUpdateCheck();
  if (shouldRestart) {
    process.exit(0);
  }

  const profileDir = resolveProfileDir(cliArgs.profile);
  await ensureProfileDirs(profileDir);

  let config;
  try {
    config = await loadConfig(profileDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[memo-agent] Configuration error:\n\n  ${message}\n`);
    console.error(`Create ~/.memo-agent/config.yaml or set MODEL_API_KEY env var.\n`);
    process.exit(1);
  }

  // Override model from CLI if provided
  if (cliArgs.model) {
    config.model.name = cliArgs.model;
  }

  // Apply tool disable list from config before opening DB / bootstrapping MCP
  if (config.permissions.disabledTools.length > 0) {
    disableTools(config.permissions.disabledTools);
  }

  // Open database
  const db = openDatabase(profileDir);
  pruneOldSessions(db);

  // Bootstrap MCP servers in the background — don't block startup
  const mcpReady = bootstrapMcp(config.mcpServers)
    .then(entries => {
      const connected = entries.filter(e => e.status.type === "connected");
      const failed = entries.filter(e => e.status.type === "failed");
      if (connected.length > 0) {
        process.stderr.write(`[memo-agent] MCP: ${connected.length} server(s) connected\n`);
      }
      for (const e of failed) {
        const status = e.status as { type: "failed"; error: string };
        process.stderr.write(`[memo-agent] MCP: "${e.name}" failed: ${status.error}\n`);
      }
      return entries;
    })
    .catch(err => {
      process.stderr.write(`[memo-agent] MCP bootstrap error: ${String(err)}\n`);
      return [] as McpServerEntry[];
    });

  // Load recipes
  const recipes = await loadRecipes(process.cwd(), profileDir);

  // Create model clients
  const modelClient = createClientFromConfig(config.model);
  const auxiliaryClient = config.auxiliary ? createClientFromConfig(config.auxiliary) : null;

  // Restore session if requested
  let sessionId: string = crypto.randomUUID();
  let initialMessages;

  if (cliArgs.resumeSessionId) {
    const session = getSession(db, cliArgs.resumeSessionId);
    if (session) {
      const rows = loadMessagesForSession(db, cliArgs.resumeSessionId);
      sessionId = cliArgs.resumeSessionId;
      initialMessages = rowsToChatMessages(rows);
      process.stderr.write(`[memo-agent] Restored session ${cliArgs.resumeSessionId.slice(0, 8)} (${rows.length} messages)\n`);
    } else {
      process.stderr.write(`[memo-agent] Session ${cliArgs.resumeSessionId} not found — starting fresh\n`);
    }
  }

  // Cleanup handler: close async resources before exiting.
  // Must be on SIGINT/SIGTERM (not "exit") because async work in the exit
  // event is abandoned immediately — the event loop is already shutting down.
  let cleanupPromise: Promise<void> | null = null;
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await shutdownMcp();
      try { db.close(); } catch { /* ignore */ }
    })();
    return cleanupPromise;
  }

  process.once("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });

  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

  // ── DEC 2026 Synchronized Output ─────────────────────────────────────────
  // Ink renders each frame by moving the cursor up, clearing the region, then
  // writing new content.  The gap between "clear" and "write" is the source of
  // flickering.  Wrapping every write call with the Begin/End Synchronized
  // Update escape sequences tells the terminal emulator to buffer the entire
  // write and commit it in one display refresh, eliminating intermediate states.
  //
  // Supported by: iTerm2, WezTerm, kitty, Ghostty, Windows Terminal, tmux.
  // Unsupported terminals (Terminal.app) silently ignore the escape sequences.
  const SYNC_START = '\x1b[?2026h';
  const SYNC_END   = '\x1b[?2026l';
  const _origWrite = process.stdout.write.bind(process.stdout);

  function syncWrite(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  function syncWrite(chunk: string | Uint8Array, encoding: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
  function syncWrite(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    // Only wrap string writes — Ink renders as strings, binary is pass-through.
    const data = typeof chunk === 'string' ? SYNC_START + chunk + SYNC_END : chunk;
    if (typeof encodingOrCb === 'function') return _origWrite(data, encodingOrCb);
    return _origWrite(data, encodingOrCb, cb);
  }

  process.stdout.write = syncWrite as typeof process.stdout.write;

  // Render the terminal UI
  const { waitUntilExit } = render(
    React.createElement(App, {
      config,
      profileDir,
      cwd: process.cwd(),
      db,
      sessionId,
      modelClient,
      auxiliaryClient,
      recipes,
      mcpReady,
      // exactOptionalPropertyTypes: don't pass optional props as explicit undefined
      ...(initialMessages !== undefined && { initialMessages }),
      ...(cliArgs.permissionMode !== undefined && { permissionMode: cliArgs.permissionMode }),
      profileName: cliArgs.profile ?? "default",
    })
  );

  try {
    await waitUntilExit();
  } finally {
    process.stdout.write = _origWrite as typeof process.stdout.write;
    await cleanup();
  }
}

main().catch(err => {
  console.error("[memo-agent] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
