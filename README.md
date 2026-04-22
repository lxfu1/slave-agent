# slave-agent

> [中文文档](README.zh-CN.md)

A terminal AI assistant with memory (Hermes Agent simplified version) — an essential tool for every worker.

Connects directly to OpenAI-compatible APIs, features cross-session persistent memory, structured slash commands, and an extensible tool system.

---

## Features

- **Persistent Memory** — `NOTES.md` retains context across sessions and is automatically injected into the system prompt every round; when `auto_update` is enabled, it automatically evaluates and writes at the end of each round
- **Session Chain Archiving** — When context compression is triggered, a new session is created and linked to the old session via `parent_session_id`, ensuring history is never lost
- **Three-Zone Context Compression** — Automatically archives the middle history for extra-long conversations, preserving the first round and the most recent ~20k tokens, so conversations are never truncated
- **Slash Commands** — `/notes`, `/history`, `/search`, `/compact`, `/cost`, and more; use `/help` to see all available commands
- **Recipes System** — Custom `.md` template files; invoke with `/recipe-name [args]` in one click; supports `watchPaths` to auto-recommend related recipes when matching files are modified
- **MCP Tool Extensions** — Connect to external tool servers via the Model Context Protocol
- **Session Persistence** — SQLite stores all history; `/resume` restores any historical session; supports full-text search
- **Profile Isolation** — Multiple profiles with independent configurations, memory, and session data, completely isolated from each other
- **Permission Guard** — `ask`/`auto` modes; dangerous commands (e.g., `rm -rf`) force confirmation; path safety restrictions; supports `disabledTools` to completely block specified tools
- **Rich Text UI** — Rendered with React + Ink, streaming output, status bar displays token usage and cost in real time
- **Enhanced Input** — Cursor positioning (←/→ to move, edit mid-line), history navigation (↑/↓), queued input during streaming without loss

---

## Quick Start

### Install Dependencies

```bash
npm install
```

### Configuration

Copy the example configuration file and fill in your API details:

```bash
cp .env.example .env
```

```env
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=sk-...
MODEL_NAME=gpt-4o
```

Or create `~/.slave-agent/config.yaml` (see [Configuration File](#configuration-file)).

### Launch

```bash
# Development mode (tsx hot reload)
npm run dev

# Build and run
npm run build
npm start

# Global installation to use the `slave` command
npm install -g .
slave
```

---

## CLI Arguments

```
slave [options]

OPTIONS
  --profile <name>        Use the specified profile (default: "default")
  --model <name>          Override the model name in config
  --resume <session-id>   Resume a specific historical session
  --auto                  Start in auto permission mode (no confirmation)
  --version, -v           Print version number
  --help, -h              Print help
```

Examples:

```bash
slave --profile work
slave --model gpt-4o-mini
slave --resume abc12345
slave --auto
```

---

## Terminal Input Operations

| Operation | Effect |
|-----------|--------|
| `←` / `→` | Move cursor within the input line; supports mid-line insertion or deletion |
| `↑` / `↓` | Switch through input history (up to 50 entries); ↓ returns to current editing content |
| `Backspace` / `Delete` | Delete character to the left of the cursor |
| Paste / Multi-character input | Cursor correctly jumps to the end of all characters |
| Typing during streaming | Characters are queued (gray + `(queued)`); can continue editing after idle |
| `Ctrl+C` (during streaming) | Interrupt the request; already streamed content remains on screen (marked `[interrupted]`) |
| `Ctrl+C` (idle, press twice) | Exit |

---

## Status Bar

The bottom status bar displays in real time:

```
● slave-agent │ gpt-4o    tokens: 1234/128k (15%)  │  $0.0042  │  mode:ask  │  profile:default
```

| Field | Description |
|-------|-------------|
| `●` / `○` | Streaming / idle |
| `tokens` | Session used tokens / model limit; turns yellow above 70%, red above 85% |
| `$X.XXXX` | Estimated session cost (USD) |
| `mode` | Current permission mode (ask / auto) |
| `profile` | Current profile name |

---

## Slash Commands

Enter the following commands during a conversation:

| Command | Description |
|---------|-------------|
| `/help` | Display all available commands and recipes |
| `/notes [show\|clear]` | View or clear persistent notes (NOTES.md) |
| `/history [n]` | Show the last n sessions (default 10) |
| `/search <keyword>` | Full-text search all historical messages |
| `/compact [focus description]` | Manually trigger context archival compression |
| `/model [name]` | View or switch the current model |
| `/cost` | Show current session token consumption and estimated cost |
| `/clear` | Clear the current session context (memory is preserved) |
| `/resume [session-id]` | Prompt to resume a session using the `--resume` argument |
| `/profile [name]` | View or switch profile |
| `/recipes` | List installed recipes |
| `/mode [ask\|auto]` | Switch tool execution permission mode |
| `/exit` | Exit slave-agent (alias: `/quit`) |

---

## Recipes System

A recipe is a reusable prompt template stored as a `.md` file.

### Storage Locations

- **Global**: `~/.slave-agent/recipes/`
- **Project-level** (priority): `.slave-agent/recipes/`

### Recipe File Format

```markdown
---
name: review
description: Perform a code review on current changes
allowedTools: [ReadFile, SearchCode, ListFiles]
---
Please perform a code review on the following changes, focusing on security, performance, and maintainability.

$ARGUMENTS
```

| Field | Description |
|-------|-------------|
| `name` | Invocation name (lowercase letters + hyphens) |
| `description` | Description shown in the `/recipes` list |
| `allowedTools` | Tools pre-authorized during recipe execution (skips permission confirmation) |
| `watchPaths` | Auto-recommend this recipe when file paths match (optional) |
| `$ARGUMENTS` | Placeholder for arguments passed during invocation |

### Invoking a Recipe

```
/review src/main.ts
/fix-types
/summarize-pr
```

---

## Persistent Memory

### NOTES.md — Working Notes (Read/Write)

Path: `~/.slave-agent/memory/NOTES.md` (or under the profile directory)

- The agent can append notes via the `WriteNotes` tool
- When `memory.auto_update: true` is enabled, it automatically evaluates whether information is worth retaining and writes it at the end of each round; saved content is displayed in the terminal upon writing
- Automatically injected into the system prompt at the start of each session
- `/notes show` to view, `/notes clear` to clear

### PROFILE.md — User Preferences (Read-Only)

Path: `~/.slave-agent/memory/PROFILE.md`

Only editable by the user; the agent will not modify it. Suitable for placing:

```markdown
I am a backend engineer, primarily using Go and TypeScript.
Code style: functional-first, avoid over-abstraction.
Please respond in Chinese; code comments in English.
```

---

## Context Compression

Conversation context is managed in three zones:

```
┌──────────────────────────────────┐
│  HEAD (Anchor Zone)              │  system prompt + first round, never compressed
├──────────────────────────────────┤
│  MIDDLE (Archive Zone)           │  Replaced with LLM-generated summary when threshold exceeded
├──────────────────────────────────┤
│  TAIL (Active Zone)              │  Most recent ~20k tokens, fully preserved
└──────────────────────────────────┘
```

Trigger thresholds (adjustable in config):
- **70%** context usage → Status bar warning (yellow)
- **85%** context usage → Auto-trigger archival
- Manual trigger: `/compact [focus description]`

---

## Tool System

### Built-in Tools

| Tool | Description | Permission |
|------|-------------|------------|
| `ReadFile` | Read file content, supports line range (limited to cwd / profile directory) | Read-only |
| `WriteFile` | Create or overwrite files (limited to cwd / profile directory) | Write |
| `EditFile` | Precise string replacement; supports `replace_all: true` for global replacement | Write |
| `ListFiles` | List files using glob patterns | Read-only |
| `SearchCode` | Regex search file content (prefers rg, falls back to grep), global result limit | Read-only |
| `RunCommand` | Execute shell commands, 30s timeout | High-risk |
| `WriteNotes` | Append content to NOTES.md | Write |
| `ReadNotes` | Read current NOTES.md | Read-only |
| `CreateTask` | Create in-session tasks (IDs start from 1, reset after `/clear`) | Write |
| `UpdateTask` | Update task status, `blockedBy`, `blocks` | Write |
| `ListTasks` | List all tasks in the current session | Read-only |
| `GetTask` | Get task details (including dependencies) | Read-only |
| `SearchHistory` | Full-text search historical messages (across all sessions) | Read-only |
| `ListSessions` | List historical sessions (including session chain parent-child relationships) | Read-only |

### MCP Tool Extensions

Configure MCP servers in `config.yaml`; tools are auto-registered as `mcp__<server_name>__<tool_name>`:

```yaml
mcp_servers:
  github:
    type: stdio
    command: npx
    args: ["@modelcontextprotocol/server-github"]
  filesystem:
    type: stdio
    command: npx
    args: ["@modelcontextprotocol/server-filesystem", "/tmp"]
```

MCP servers connect in the background in parallel without blocking startup.

---

## Permission System

### Modes

| Mode | Behavior |
|------|----------|
| `ask` (default) | Prompt for confirmation on write operations and shell commands |
| `auto` | Auto-execute (dangerous commands still require confirmation) |

Switch modes: `/mode auto` or start with `--auto`.

### Permission Confirmation Actions

When a permission dialog appears:
- `Enter` / `y` — Allow this time (default)
- `a` — Always allow for this session
- `n` — Deny

### Safe Project Directory Auto-Approval

When `cwd` (current working directory) is **not** a core/sensitive directory, `WriteFile` and `EditFile` operations within the directory are auto-approved without confirmation.

**Core Directories** (still require confirmation):
- Home directory itself `~` (but `~/projects/foo` is safe)
- Filesystem root `/` and system trees (`/etc`, `/usr`, `/bin`, etc.)
- Sensitive subdirectories in home (`~/.ssh`, `~/.aws`, `~/.config`, `~/.kube`, etc.)

`RunCommand` is not affected by this rule and always follows the original ask/auto logic.

### Dangerous Command Force Confirmation

Regardless of mode, the following commands always trigger confirmation:

`rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `dd if=`, `mkfs`, `shutdown`, `kill -9`, etc.

### Config Allow/Deny Rules

```yaml
permissions:
  mode: ask
  allow:
    - ReadFile
    - ListFiles
    - SearchCode
    - "RunCommand(git status)"
  deny:
    - "RunCommand(rm *)"
  disabled_tools:
    - RunCommand     # Completely hidden from the model
```

---

## Configuration File

### File Locations

| Path | Purpose |
|------|---------|
| `~/.slave-agent/config.yaml` | Global default config |
| `~/.slave-agent/profiles/<name>/config.yaml` | Config for a specific profile |
| `.env` | Environment variables in the project root (highest priority) |

### Full Configuration Example

```yaml
# Main model configuration
model:
  provider: openai           # openai | custom
  base_url: "${MODEL_BASE_URL}"
  api_key: "${MODEL_API_KEY}"
  name: gpt-4o
  timeout_ms: 60000

# Auxiliary model (used for context archival compression, recommend a cheaper model)
auxiliary:
  provider: openai
  base_url: "${AUX_BASE_URL}"
  api_key: "${AUX_API_KEY}"
  name: gpt-4o-mini
  timeout_ms: 60000

# Persistent memory
memory:
  auto_update: true          # Auto-evaluate and write to NOTES.md at end of each round (default on)
  max_inject_tokens: 4000    # Max tokens to inject into system prompt

# Context compression thresholds
context:
  warn_threshold: 0.70       # Warning at 70%
  compress_threshold: 0.85   # Auto-archive at 85%
  tail_tokens: 20000         # Tokens to preserve in the active zone

# Permission control
permissions:
  mode: ask                  # ask | auto
  allow:
    - ReadFile
    - ListFiles
    - SearchCode
    - ReadNotes
    - SearchHistory
    - ListSessions
  deny: []
  disabled_tools: []         # List of completely hidden tools, e.g. [RunCommand]

# MCP servers
mcp_servers:
  github:
    type: stdio
    command: npx
    args: ["@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
```

---

## Profile Isolation

Use independent configurations, memory, and sessions for different scenarios:

```
~/.slave-agent/                  # default profile
  config.yaml
  memory/
    NOTES.md
    PROFILE.md
  sessions.db
  recipes/

~/.slave-agent/profiles/work/    # work profile
  config.yaml                    # Can use a different model, API key
  memory/
  sessions.db
  recipes/
```

Switch profiles:

```bash
slave --profile work
slave --profile research
```

---

## Session Management

```bash
# View last 10 sessions
/history

# View last 20 sessions
/history 20

# Full-text search historical messages (/search command used by humans)
/search "sqlite WAL mode"

# Resume a historical session (first use /history to get the session ID)
slave --resume abc12345

# Clear the current session (does not affect NOTES.md)
/clear
```

The model can also proactively query history via tools:

- `SearchHistory` — Full-text search all historical messages, great for "what did we discuss before"
- `ListSessions` — List historical sessions, including session chain parent-child relationships (formed automatically after compression/archival)

---

## Directory Structure

```
slave-agent/
├── src/
│   ├── cli/
│   │   └── index.ts              # Entry: argument parsing, startup flow
│   ├── engine/
│   │   ├── conversationEngine.ts # Core: multi-round session loop, tool invocation
│   │   └── commandRouter.ts      # Slash command routing (pure functions)
│   ├── model/
│   │   ├── client.ts             # OpenAI client factory
│   │   └── streaming.ts          # Streaming response async generator
│   ├── context/
│   │   ├── compressor.ts         # Three-zone archival compression
│   │   ├── tokenBudget.ts        # Token budget tracking and estimation
│   │   └── promptBuilder.ts      # Dynamic system prompt construction
│   ├── memory/
│   │   ├── notesManager.ts       # NOTES.md read/write
│   │   └── profileReader.ts      # PROFILE.md read-only
│   ├── tools/
│   │   ├── registry.ts           # Tool registry (supports disableTools)
│   │   ├── pathUtils.ts          # Shared path security validation
│   │   ├── searchHistory.ts      # Historical message full-text search tool
│   │   ├── listSessions.ts       # Historical session list tool
│   │   └── *.ts                  # Individual tool implementations (self-registering)
│   ├── recipes/
│   │   └── recipeRegistry.ts     # Recipe loading and template expansion
│   ├── session/
│   │   └── db.ts                 # SQLite session storage (WAL + FTS5)
│   ├── permissions/
│   │   └── guard.ts              # Centralized permission decisions
│   ├── mcp/
│   │   └── mcpBridge.ts          # MCP protocol tool bridge
│   ├── config/
│   │   └── loader.ts             # Configuration loading and merging
│   ├── ui/
│   │   ├── App.tsx               # Main UI (state machine)
│   │   ├── MessageList.tsx       # Message list rendering
│   │   └── StatusBar.tsx         # Bottom status bar
│   └── types/
│       ├── messages.ts           # ChatMessage, StreamEvent
│       ├── config.ts             # SlaveAgentConfig
│       ├── errors.ts             # SlaveAgentError discriminated union
│       ├── tool.ts               # Tool interface
│       └── session.ts            # SessionRow, MessageRow
├── .slave-agent/
│   └── recipes/                  # Project-level recipe files
├── .env.example
├── package.json
├── tsconfig.json
└── prd.md
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5 (strict + ESM) |
| Terminal UI | React 18 + Ink 5 |
| Database | better-sqlite3 (WAL mode + FTS5 full-text index) |
| Model SDK | openai (OpenAI-compatible API) |
| Tool Protocol | @modelcontextprotocol/sdk |
| Config Parsing | js-yaml + dotenv |
| Build | tsx (dev) / tsc (production) |

---

## Development

```bash
# Type check
npm run typecheck

# Development mode (tsx, no build needed)
npm run dev

# Production build
npm run build

# Run the built artifact
npm start
```

### Adding Custom Tools

1. Create `myTool.ts` under `src/tools/`
2. Implement the `Tool` interface and call `registerTool(myTool)` at the end of the file
3. Add `import "./myTool.js"` in `src/tools/index.ts`

```typescript
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";

const myTool: Tool = {
  name: "MyTool",
  description: "Describe the tool's purpose",
  inputSchema: {
    type: "object",
    properties: {
      param: { type: "string", description: "Parameter description" },
    },
    required: ["param"],
  },
  maxResultChars: 10_000,
  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const param = input["param"] as string;
    return { content: `Result: ${param}` };
  },
};

registerTool(myTool);
```

---

## Security Notes

- **Path Restriction**: `ReadFile`, `WriteFile`, `EditFile` only allow operating on files within the current working directory or profile directory; out-of-bounds access returns an error
- **Safe Project Directory**: When working in non-core directories (project directories), file write operations are auto-approved; the home directory itself, system paths, and sensitive hidden directories still require confirmation (see [Safe Project Directory Auto-Approval](#safe-project-directory-auto-approval))
- **Injection Scanning**: `NOTES.md`, `PROFILE.md`, and recipe files are automatically scanned for prompt injection signatures before injection; if detected, injection is skipped and a warning is displayed in the UI
- **Command Interception**: `RunCommand` dangerous command blacklist forces confirmation in any mode
- **FTS5 Security**: Search queries are automatically escaped to prevent FTS5 syntax injection
- **Tool Masking**: Specified tools can be completely removed from the model's view via `permissions.disabled_tools`
- **Log Sanitization**: Runtime warnings are output via UI event stream or stderr without interfering with terminal UI rendering
