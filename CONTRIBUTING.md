# Contributing to memo-agent

Thank you for your interest in contributing! This document explains how to get started.

---

## Development Setup

**Requirements:** Node.js ≥ 20, npm ≥ 10

```bash
git clone https://github.com/yourusername/memo-agent
cd memo-agent
npm install
cp .env.example .env   # fill in your API key
npm run dev            # start in development mode
```

---

## Project Structure

```
src/
  cli/          Entry point and argument parsing
  engine/       Conversation loop and command routing
  context/      Token budget, compression, prompt building
  config/       YAML config loading and merging
  memory/       NOTES.md and PROFILE.md management
  tools/        Built-in tool implementations (self-registering)
  recipes/      Recipe file loading and expansion
  session/      SQLite persistence (WAL + FTS5)
  permissions/  Permission guard and core-directory detection
  mcp/          Model Context Protocol bridge
  ui/           React + Ink terminal UI components
  types/        Shared TypeScript interfaces
  __tests__/    Unit tests (Vitest)
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode (tsx, no build needed) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Watch mode for tests |

---

## Adding a New Tool

1. Create `src/tools/myTool.ts` — implement the `Tool` interface and call `registerTool(myTool)` at the end.
2. Add `import "./myTool.js"` to `src/tools/index.ts`.
3. Add the tool name to the `allow` list in `DEFAULT_CONFIG` if it's read-only.
4. Write tests in `src/__tests__/` if the tool has non-trivial logic.

```typescript
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";

const myTool: Tool = {
  name: "MyTool",
  description: "What this tool does",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Input parameter" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  maxResultChars: 10_000,
  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = input["query"] as string;
    return { content: `Result for: ${query}` };
  },
};

registerTool(myTool);
```

---

## Code Style

- **TypeScript strict mode** — all code must pass `npm run typecheck` with `strict: true` and `exactOptionalPropertyTypes: true`
- **ESLint** — run `npm run lint` before submitting; no `any` without justification
- **No magic strings** — use constants or type-checked literals
- **Error handling** — use `makeError()` from `types/errors.ts` for typed errors; never swallow exceptions silently
- **Optional props** — use conditional spreading `...(x !== undefined && { prop: x })` instead of assigning `undefined`

---

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]
[optional footer]
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

Examples:
```
feat(tools): add BrowserOpen tool for opening URLs
fix(guard): prevent safe-cwd bypass via symlink traversal
test(db): add pruneOldSessions boundary tests
```

---

## Pull Request Process

1. Fork the repository and create a branch: `git checkout -b feat/my-feature`
2. Make your changes, following the code style guidelines above
3. Add or update tests for any changed logic
4. Ensure all checks pass: `npm run typecheck && npm run lint && npm test`
5. Open a PR against `main` with a clear description of what and why

PRs that break existing tests or type-check will not be merged.

---

## Reporting Issues

Use the [GitHub issue tracker](https://github.com/yourusername/memo-agent/issues).
For security vulnerabilities, see [SECURITY.md](SECURITY.md).
