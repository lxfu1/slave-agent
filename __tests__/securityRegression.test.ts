import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveSafePath } from "../src/tools/pathUtils.js";
import { getTool } from "../src/tools/registry.js";
import { sanitizeTerminalText } from "../src/ui/sanitizeTerminalText.js";
import type { ToolContext } from "../src/types/tool.js";
import { DEFAULT_CONFIG } from "../src/types/config.js";

beforeAll(async () => {
  await import("../src/tools/index.js");
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("security regressions", () => {
  it("strips OSC clipboard and CSI control sequences", () => {
    const input = `before\x1b]52;c;SGVsbG8=\x07middle\x1b[2Jafter`;
    expect(sanitizeTerminalText(input)).toBe("beforemiddleafter");
  });

  it("rejects paths that escape through a symlink", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await fs.symlink(outside, path.join(root, "link"));

    await expect(resolveSafePath("link/secret.txt", root, [root])).resolves.toBeNull();
  });

  it("rejects ListFiles directories outside cwd", async () => {
    const root = await makeTempDir();
    const tool = getTool("ListFiles");
    expect(tool).toBeDefined();
    const result = await tool!.call({ pattern: "*", cwd: ".." }, makeContext(root));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  it("propagates cancellation to RunCommand", async () => {
    const root = await makeTempDir();
    const controller = new AbortController();
    const tool = getTool("RunCommand");
    expect(tool).toBeDefined();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const result = await tool!.call({ command: "sleep 5" }, makeContext(root, controller.signal));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("interrupted");
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memo-agent-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeContext(cwd: string, abortSignal?: AbortSignal): ToolContext {
  return {
    cwd,
    profileDir: cwd,
    sessionId: "test",
    permissionMode: "auto",
    db: {} as ToolContext["db"],
    config: structuredClone(DEFAULT_CONFIG),
    ...(abortSignal && { abortSignal }),
  };
}
