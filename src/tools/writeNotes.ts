import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { createNotesManager } from "../memory/notesManager.js";
import { registerTool } from "./registry.js";

const writeNotesTool: Tool = {
  name: "WriteNotes",
  description:
    "Appends a section to the persistent NOTES.md memory file. " +
    "Use this to record important facts, decisions, or context that should be remembered in future sessions. " +
    "Do not record ephemeral information — only facts with lasting value.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The note content to append. Plain text or Markdown.",
      },
    },
    required: ["content"],
    additionalProperties: false,
  },
  maxResultChars: 200,

  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = input["content"] as string;
    if (!content.trim()) {
      return { content: "Error: content is empty", isError: true };
    }

    const manager = createNotesManager(ctx.profileDir);
    const written = await manager.append(content);
    if (!written) {
      return { content: "Note skipped: content is substantially similar to existing notes." };
    }
    return { content: `Appended note to ${manager.getPath()}` };
  },
};

registerTool(writeNotesTool);
