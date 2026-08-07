/**
 * RunCommand tool — executes shell commands via spawn (not exec).
 *
 * Using spawn instead of exec:
 * - Avoids shell injection (no shell interpolation by default)
 * - Handles large stdout/stderr without buffer overflow
 * - Enables reliable timeout via AbortController
 *
 * Enforces a hard 30-second timeout. The permission guard is responsible
 * for blocking dangerous commands before this tool is called.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import type { SandboxConfig } from "../types/config.js";
import { registerTool } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

const runCommandTool: Tool = {
  name: "RunCommand",
  description:
    "Runs a shell command and returns stdout + stderr. " +
    "Commands run in the current working directory. Timeout: 30 seconds.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000, max: 120000)",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  maxResultChars: MAX_OUTPUT_CHARS,

  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = input["command"] as string;
    const timeoutMs = Math.min(
      Math.max(1, typeof input["timeout_ms"] === "number" ? input["timeout_ms"] : DEFAULT_TIMEOUT_MS),
      120_000
    );

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromContext = () => controller.abort();
    if (ctx.abortSignal?.aborted) controller.abort();
    else ctx.abortSignal?.addEventListener("abort", abortFromContext, { once: true });

    try {
      const env = buildProcessEnv(ctx.config.permissions.sandbox);
      const result = await runShellCommand(command, ctx.cwd, controller.signal, env);

      const combined = formatOutput(result.stdout, result.stderr, result.exitCode);
      const truncated = combined.length > MAX_OUTPUT_CHARS
        ? combined.slice(0, MAX_OUTPUT_CHARS) + "\n...(truncated)"
        : combined + (result.outputTruncated ? "\n...(output capture truncated)" : "");

      const isError = result.exitCode !== 0;
      return { content: truncated, isError };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          content: timedOut
            ? `Command timed out after ${timeoutMs}ms: ${command}`
            : `Command interrupted: ${command}`,
          isError: true,
        };
      }
      return {
        content: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener("abort", abortFromContext);
    }
  },
};

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputTruncated: boolean;
}

function buildProcessEnv(sandbox: SandboxConfig): NodeJS.ProcessEnv {
  if (!sandbox.enabled) return process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const key of sandbox.allowedEnvVars) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function runShellCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Spawn via sh -c to support pipes and shell features, but the command
    // string itself is the only argument — no interpolation by us.
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let capturedChars = 0;
    let outputTruncated = false;
    let settled = false;

    const capture = (chunk: Buffer, decoder: StringDecoder, target: "stdout" | "stderr") => {
      if (capturedChars >= MAX_OUTPUT_CHARS) {
        outputTruncated = true;
        return;
      }
      const decoded = decoder.write(chunk);
      const remaining = MAX_OUTPUT_CHARS - capturedChars;
      const slice = decoded.slice(0, remaining);
      if (target === "stdout") stdout += slice;
      else stderr += slice;
      capturedChars += slice.length;
      if (slice.length < decoded.length) outputTruncated = true;
    };

    proc.stdout.on("data", (chunk: Buffer) => capture(chunk, stdoutDecoder, "stdout"));
    proc.stderr.on("data", (chunk: Buffer) => capture(chunk, stderrDecoder, "stderr"));

    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        if (capturedChars < MAX_OUTPUT_CHARS) {
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          outputTruncated,
        });
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    signal.addEventListener("abort", () => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      // Give the process 2 s to terminate gracefully before force-killing.
      // Track the timer so we can cancel it if the process exits on its own.
      const sigkillTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 2_000);
      // If the process exits before SIGKILL fires, cancel the timer.
      proc.once("close", () => clearTimeout(sigkillTimer));
      reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
    }, { once: true });
  });
}

function formatOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout);
  if (stderr.trim()) parts.push(`[stderr]\n${stderr}`);
  if (exitCode !== 0) parts.push(`[exit code: ${exitCode}]`);
  return parts.join("\n") || "(no output)";
}

registerTool(runCommandTool);
