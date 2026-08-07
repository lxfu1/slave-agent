import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { InputPanel } from "../src/ui/components/InputPanel.js";
import { StatusBar } from "../src/ui/StatusBar.js";

describe("terminal UI regressions", () => {
  it("uses a compact status layout in a 48-column terminal", async () => {
    const io = createTerminal(48);
    const app = render(React.createElement(StatusBar, {
      model: "gpt-4o-2024-11-20-long",
      mode: "auto",
      profile: "development-long",
      usage: {
        totalInputTokens: 123_456,
        totalOutputTokens: 7_890,
        estimatedCostUsd: 12.3456,
        currentRatio: 0.87,
        contextWindowSize: 128_000,
      },
      isStreaming: true,
    }), io.options);

    await wait(20);
    app.unmount();
    const output = stripAnsi(io.read());
    expect(output).toContain("111k/128k 87%");
    expect(output).not.toContain("profile:");
  });

  it("does not mutate the hidden input while search is active", async () => {
    const io = createTerminal(80);
    const props = { appState: "searching" as const, onSubmit: () => undefined };
    const app = render(React.createElement(InputPanel, props), io.options);

    await wait(20);
    io.stdin.write("abc");
    await wait(20);
    app.rerender(React.createElement(InputPanel, { ...props, appState: "idle" }));
    await wait(30);
    app.unmount();

    expect(stripAnsi(io.read())).not.toContain("abc");
  });
});

function createTerminal(columns: number) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (value: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = value => { stdin.isRaw = value; };
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;

  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = columns;
  stdout.rows = 24;
  stdout.isTTY = true;
  const stderr = new PassThrough() as typeof stdout;
  stderr.columns = columns;
  stderr.rows = 24;
  stderr.isTTY = true;

  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });

  return {
    stdin,
    options: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
    read: () => output,
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
