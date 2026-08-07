/**
 * Persistent task tracking tools.
 *
 * Tasks are stored in SQLite and scoped to the current session.
 * They persist across restarts and are accessible via /resume.
 */

import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import type { TaskRow, TaskStatus } from "../types/session.js";
import { dbCreateTask, dbUpdateTask, dbListTasks, dbGetTask, dbNextTaskId } from "../session/db.js";
import { registerTool } from "./registry.js";

export type { TaskStatus };

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
  updatedAt: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    blockedBy: JSON.parse(row.blockedBy) as string[],
    blocks: JSON.parse(row.blocks) as string[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// CreateTask
// ---------------------------------------------------------------------------

const createTaskTool: Tool = {
  name: "CreateTask",
  description: "Creates a task to track work in the current session.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Brief task title" },
      description: { type: "string", description: "Detailed description of what needs to be done" },
      blockedBy: {
        type: "array",
        items: { type: "string" },
        description: "IDs of tasks that must complete before this task",
      },
      blocks: {
        type: "array",
        items: { type: "string" },
        description: "IDs of tasks that this task blocks",
      },
    },
    required: ["subject", "description"],
    additionalProperties: false,
  },
  maxResultChars: 200,
  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = dbNextTaskId(ctx.db, ctx.sessionId);
    dbCreateTask(ctx.db, ctx.sessionId, {
      id,
      subject: input["subject"] as string,
      description: input["description"] as string,
      status: "pending",
      blockedBy: JSON.stringify(Array.isArray(input["blockedBy"]) ? input["blockedBy"] : []),
      blocks: JSON.stringify(Array.isArray(input["blocks"]) ? input["blocks"] : []),
    });
    return { content: `Created task #${id}: ${input["subject"] as string}` };
  },
};

// ---------------------------------------------------------------------------
// UpdateTask
// ---------------------------------------------------------------------------

const updateTaskTool: Tool = {
  name: "UpdateTask",
  description: "Updates the status and/or dependency relationships of a task.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID" },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "failed"],
        description: "New status (optional)",
      },
      blockedBy: {
        type: "array",
        items: { type: "string" },
        description: "IDs of tasks that must complete before this one (replaces existing list)",
      },
      blocks: {
        type: "array",
        items: { type: "string" },
        description: "IDs of tasks that this task blocks (replaces existing list)",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  maxResultChars: 200,
  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = input["id"] as string;
    const existing = dbGetTask(ctx.db, ctx.sessionId, id);

    if (!existing) {
      return { content: `Task #${id} not found`, isError: true };
    }

    const changes: string[] = [];
    const updates: Parameters<typeof dbUpdateTask>[3] = {};

    if (input["status"] !== undefined) {
      updates.status = input["status"] as TaskStatus;
      changes.push(`status → ${updates.status}`);
    }

    if (Array.isArray(input["blockedBy"])) {
      updates.blockedBy = JSON.stringify(input["blockedBy"]);
      changes.push(`blockedBy → [${(input["blockedBy"] as string[]).join(", ")}]`);
    }

    if (Array.isArray(input["blocks"])) {
      updates.blocks = JSON.stringify(input["blocks"]);
      changes.push(`blocks → [${(input["blocks"] as string[]).join(", ")}]`);
    }

    if (changes.length === 0) {
      return { content: `Task #${id}: nothing to update`, isError: true };
    }

    dbUpdateTask(ctx.db, ctx.sessionId, id, updates);
    return { content: `Task #${id} updated: ${changes.join("; ")}` };
  },
};

// ---------------------------------------------------------------------------
// ListTasks
// ---------------------------------------------------------------------------

const listTasksTool: Tool = {
  name: "ListTasks",
  description: "Lists all tasks in the current session.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  maxResultChars: 5_000,
  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rows = dbListTasks(ctx.db, ctx.sessionId);
    if (rows.length === 0) {
      return { content: "No tasks in this session." };
    }

    const lines = rows.map(rowToTask).map(t => {
      const statusIcon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : t.status === "in_progress" ? "→" : "○";
      return `${statusIcon} #${t.id} [${t.status}] ${t.subject}`;
    });

    return { content: lines.join("\n") };
  },
};

// ---------------------------------------------------------------------------
// GetTask
// ---------------------------------------------------------------------------

const getTaskTool: Tool = {
  name: "GetTask",
  description: "Gets the full details of a task by ID.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  maxResultChars: 2_000,
  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = input["id"] as string;
    const row = dbGetTask(ctx.db, ctx.sessionId, id);

    if (!row) {
      return { content: `Task #${id} not found`, isError: true };
    }

    const task = rowToTask(row);
    return {
      content: [
        `#${task.id} — ${task.subject}`,
        `Status: ${task.status}`,
        `Description: ${task.description}`,
        task.blockedBy.length > 0 ? `Blocked by: ${task.blockedBy.join(", ")}` : "",
        task.blocks.length > 0 ? `Blocks: ${task.blocks.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};

registerTool(createTaskTool);
registerTool(updateTaskTool);
registerTool(listTasksTool);
registerTool(getTaskTool);
