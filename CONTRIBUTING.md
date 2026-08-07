# Contributing to memo-agent

Thank you for your interest in contributing! This document explains how to get started.

---

## Development Setup

**Requirements:** Node.js ≥ 20, npm ≥ 10

```bash
git clone https://github.com/lxfu1/memo-agent
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

## Publishing a Release

Releases are triggered by pushing a version tag from a local checkout. Before the first release, add an npm granular access token with publish permission as the repository Actions secret `NPM_TOKEN`.

1. Update the version in `package.json` and lock files, then update `CHANGELOG.md`.
2. Merge the release commit into `main` and update the local branch.
3. Create an annotated tag that exactly matches the package version.
4. Push the tag to GitHub.

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.2.1 -m "Release v0.2.1"
git push origin v0.2.1
```

The release workflow verifies that the tag matches `package.json` and points to a commit contained in `origin/main`. It then runs the publish gate, publishes to npm with provenance, and creates a GitHub Release. Versions containing a prerelease suffix, such as `0.3.0-beta.1`, are published with the npm `next` dist-tag.

Do not run `npm publish` locally. If a workflow needs to be retried, rerun it from GitHub Actions; already published npm versions and existing GitHub Releases are skipped safely.

---

## Reporting Issues

Use the [GitHub issue tracker](https://github.com/lxfu1/memo-agent/issues).
For security vulnerabilities, see [SECURITY.md](SECURITY.md).
