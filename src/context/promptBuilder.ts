/**
 * System prompt builder.
 *
 * Assembles the system prompt from independent, togglable blocks.
 * Each block can fail or be absent without breaking the overall prompt.
 * Runs git context lookups in parallel for startup performance.
 *
 * Security: NOTES.md and PROFILE.md content is scanned for prompt injection
 * patterns before injection. Detected content is skipped with a warning.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { createNotesManager } from "../memory/notesManager.js";
import { readProfile } from "../memory/profileReader.js";
import type { MemoAgentConfig } from "../types/config.js";
import { estimateStringTokens } from "./tokenBudget.js";

const execFileAsync = promisify(execFile);

export interface RecipeDescriptor {
  name: string;
  description: string;
  scope: "global" | "project";
}

export interface PromptBuilderOptions {
  cwd: string;
  profileDir: string;
  config: MemoAgentConfig;
  recipes: RecipeDescriptor[];
}

// Patterns that suggest someone is trying to manipulate the agent via
// injected content files (NOTES.md, PROFILE.md, recipe bodies, etc.)
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|previous\s+|above\s+)?instructions/i,
  /disregard\s+(your\s+|all\s+|any\s+)(instructions|rules|guidelines)/i,
  /you\s+are\s+now\s+(a\s+|an\s+)?(different|new|unrestricted|jailbroken|evil|uncensored)/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+(restrictions|limits)/i,
  /reveal\s+(your\s+)?(system\s+)?prompt/i,
  /new\s+persona/i,
  /\bDAN\b/, // "Do Anything Now" jailbreak marker
  // Credential exfiltration via shell commands
  /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i,
  /cat\s+[^\n]*(\.env|credentials|\.netrc)/i,
];

/**
 * Scans text for prompt injection patterns.
 * Returns true if a threat is detected (meaning the block should be skipped).
 */
export function scanForInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(text));
}

export interface SystemPromptResult {
  prompt: string;
  injectionWarnings: string[];
}

/** Builds the complete system prompt for the current turn */
export async function buildSystemPrompt(opts: PromptBuilderOptions): Promise<SystemPromptResult> {
  const { cwd, profileDir, config, recipes } = opts;
  const injectionWarnings: string[] = [];

  // Fetch external context sources in parallel
  const [gitContext, notesContent, profileContent] = await Promise.allSettled([
    fetchGitContext(cwd),
    loadNotesContent(profileDir, config.memory.maxInjectTokens),
    loadProfileContent(profileDir),
  ]);

  const blocks: string[] = [];

  // Block 1: Role definition (always included)
  blocks.push(buildRoleBlock());

  // Block 2: Runtime environment
  const git = gitContext.status === "fulfilled" ? gitContext.value : null;
  blocks.push(buildEnvironmentBlock(cwd, git));

  // Block 3: Working notes (NOTES.md)
  const notes = notesContent.status === "fulfilled" ? notesContent.value : null;
  if (notes === "INJECTION_DETECTED") {
    injectionWarnings.push("NOTES.md");
  } else if (notes) {
    blocks.push(`## Working Notes\n\n${notes}`);
  }

  // Block 4: User profile (PROFILE.md)
  const profile = profileContent.status === "fulfilled" ? profileContent.value : null;
  if (profile === "INJECTION_DETECTED") {
    injectionWarnings.push("PROFILE.md");
  } else if (profile) {
    blocks.push(`## User Profile\n\n${profile}`);
  }

  // Block 5: Available recipes
  if (recipes.length > 0) {
    blocks.push(buildRecipesBlock(recipes));
  }

  // Block 6: Behavior rules (always included)
  blocks.push(buildBehaviorRulesBlock());

  return { prompt: blocks.join("\n\n"), injectionWarnings };
}

function buildRoleBlock(): string {
  return `You are Memo Agent, a terminal AI assistant for software development and knowledge work.

You have access to tools for reading/writing files, running shell commands, searching code, and managing notes.
You maintain persistent memory across sessions via NOTES.md. You are direct, accurate, and concise.`;
}

function buildEnvironmentBlock(cwd: string, git: GitContext | null): string {
  const lines = [
    "## Environment",
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- OS: ${os.type()} ${os.release()}`,
    `- Working directory: ${cwd}`,
  ];

  if (git) {
    if (git.branch) lines.push(`- Git branch: ${git.branch}`);
    if (git.status) lines.push(`- Git status: ${git.status.slice(0, 200)}`);
    if (git.lastCommit) lines.push(`- Last commit: ${git.lastCommit}`);
  }

  return lines.join("\n");
}

function buildRecipesBlock(recipes: RecipeDescriptor[]): string {
  const list = recipes
    .map(r => `- \`/${r.name}\` — ${r.description}`)
    .join("\n");
  return `## Available Recipes\n\nInvoke a recipe with /<name> [arguments].\n\n${list}`;
}

function buildBehaviorRulesBlock(): string {
  return `## Behavior Rules

- Be concise. Prefer short, direct answers over lengthy explanations.
- When executing non-file tools (RunCommand, SearchCode, etc.), explain what you are doing in one sentence before calling the tool.
- **Code output rule (critical):** When writing or modifying a source-code file, you MUST output the complete file content as a fenced code block in your text response FIRST, then call WriteFile or EditFile. The user reads code from the terminal — writing silently to disk without showing it is not acceptable.
  - For new files: output the full content, then call WriteFile.
  - For edits: output the changed section with surrounding context, then call EditFile.
  - Exception: binary files, large generated files (>200 lines), or files whose content the user explicitly said they do not need to see.
- Always prefer editing existing files over creating new ones.
- Do not add comments, docstrings, or error handling beyond what the task requires.
- Never generate or guess URLs — only use URLs explicitly provided by the user.
- When updating NOTES.md, record only facts that would be useful in a future session.`;
}

// ---------------------------------------------------------------------------
// Git context helpers
// ---------------------------------------------------------------------------

interface GitContext {
  branch: string | null;
  status: string | null;
  lastCommit: string | null;
}

async function fetchGitContext(cwd: string): Promise<GitContext> {
  const [branch, status, lastCommit] = await Promise.allSettled([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    runGit(["status", "--short"], cwd),
    runGit(["log", "-1", "--pretty=%h %s"], cwd),
  ]);

  return {
    branch: branch.status === "fulfilled" ? branch.value.trim() : null,
    status: status.status === "fulfilled" ? status.value.trim() : null,
    lastCommit: lastCommit.status === "fulfilled" ? lastCommit.value.trim() : null,
  };
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5_000 });
  return stdout;
}

// ---------------------------------------------------------------------------
// Memory loading helpers
// ---------------------------------------------------------------------------

async function loadNotesContent(
  profileDir: string,
  maxInjectTokens: number
): Promise<string | null> {
  const manager = createNotesManager(profileDir);
  const raw = await manager.read();

  if (!raw.trim()) return null;

  if (scanForInjection(raw)) return "INJECTION_DETECTED";

  // Truncate to maxInjectTokens
  const maxChars = maxInjectTokens * 4; // ~4 chars per token
  return raw.length > maxChars ? raw.slice(0, maxChars) + "\n...(truncated)" : raw;
}

async function loadProfileContent(profileDir: string): Promise<string | null> {
  const raw = await readProfile(profileDir);
  if (!raw || !raw.trim()) return null;

  if (scanForInjection(raw)) return "INJECTION_DETECTED";

  return raw;
}

/** Estimates the token length of the system prompt (for budget tracking) */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return estimateStringTokens(systemPrompt);
}
