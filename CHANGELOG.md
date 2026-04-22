# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-04-22

### Added

- **Persistent memory** — `NOTES.md` is injected into every system prompt; `auto_update: true` extracts and saves facts automatically after each turn
- **Session chain archiving** — context compression creates a new session linked via `parent_session_id`, so full history is always recoverable
- **Three-zone context compression** — HEAD (anchor), MIDDLE (archived summary), TAIL (~20k tokens live context); auto-triggers at 85% usage
- **Slash command system** — `/help`, `/notes`, `/history`, `/search`, `/compact`, `/cost`, `/clear`, `/resume`, `/model`, `/profile`, `/recipes`, `/mode`, `/exit`
- **Recipes system** — reusable `.md` prompt templates with `allowedTools` pre-approval and `watchPaths` auto-recommendation
- **MCP tool extensions** — connect external tool servers via Model Context Protocol; tools namespaced as `mcp__server__tool`
- **Built-in tool set** — `ReadFile`, `WriteFile`, `EditFile`, `ListFiles`, `SearchCode`, `RunCommand`, `WriteNotes`, `ReadNotes`, `CreateTask`, `UpdateTask`, `ListTasks`, `GetTask`, `SearchHistory`, `ListSessions`
- **Permission guard** — `ask`/`auto` modes; dangerous command blocklist always enforced; safe project directory auto-approval; per-tool disable via `disabledTools`
- **Profile isolation** — independent config, memory, sessions, and recipes per profile (`--profile <name>`)
- **Rich terminal UI** — React + Ink rendering, streaming output, real-time token/cost status bar, cursor positioning, command history
- **YAML config with snake_case support** — `config.yaml` accepts both `snake_case` and `camelCase` field names
- **Session persistence** — SQLite with WAL mode and FTS5 full-text search; `/resume` works in-session and via `--resume` flag
- **Auxiliary model support** — separate cheaper model for context compression via `AUX_*` env vars or config

### Security

- Path traversal protection on `ReadFile`, `WriteFile`, `EditFile` (cwd + profileDir boundary)
- Prompt injection scanning on `NOTES.md`, `PROFILE.md`, and recipe files before injection
- FTS5 query escaping to prevent syntax injection
- `WriteFile` content size limit (10 MB)

[0.1.0]: https://github.com/yourusername/memo-agent/releases/tag/v0.1.0
