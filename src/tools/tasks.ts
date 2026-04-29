/**
 * In-session task tracking tools.
 *
 * Tasks are stored in memory and scoped to the current session.
 * They are NOT persisted to SQLite — they reset when the session ends.
 * Use WriteNotes for information that should persist across sessions.
 */

import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
}

// Session-scoped in-memory store, keyed by sessionId.
// Capped at MAX_TASK_SESSIONS entries; oldest sessions are evicted when the
// cap is exceeded so the process doesn't accumulate unbounded state.
const taskStore = new Map<string, Map<string, Task>>();
const MAX_TASK_SESSIONS = 50;

function getSessionTasks(sessionId: string): Map<string, Task> {
  if (!taskStore.has(sessionId)) {
    taskStore.set(sessionId, new Map());
    // Evict oldest session if we exceed the cap (Map preserves insertion order)
    if (taskStore.size > MAX_TASK_SESSIONS) {
      const oldest = taskStore.keys().next().value;
      if (oldest !== undefined) taskStore.delete(oldest);
    }
  }
  return taskStore.get(sessionId) as Map<string, Task>;
}

/** Removes a session's tasks from memory. Called by the engine on /clear. */
export function clearSessionTasks(sessionId: string): void {
  taskStore.delete(sessionId);
}

// Per-session id counter. Stored alongside tasks so IDs reset on /clear.
function nextId(tasks: Map<string, Task>): string {
  // Find the highest numeric id in use and add 1.
  let max = 0;
  for (const key of tasks.keys()) {
    const n = parseInt(key, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
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
    },
    required: ["subject", "description"],
    additionalProperties: false,
  },
  maxResultChars: 200,
  isReadOnly(): boolean { return false; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tasks = getSessionTasks(ctx.sessionId);
    const id = nextId(tasks);
    const task: Task = {
      id,
      subject: input["subject"] as string,
      description: input["description"] as string,
      status: "pending",
      blockedBy: [],
      blocks: [],
      createdAt: new Date().toISOString(),
    };
    tasks.set(id, task);
    return { content: `Created task #${id}: ${task.subject}` };
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
        enum: ["pending", "in_progress", "completed"],
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
    const tasks = getSessionTasks(ctx.sessionId);
    const id = input["id"] as string;
    const task = tasks.get(id);

    if (!task) {
      return { content: `Task #${id} not found`, isError: true };
    }

    const changes: string[] = [];

    if (input["status"] !== undefined) {
      task.status = input["status"] as TaskStatus;
      changes.push(`status → ${task.status}`);
    }

    if (Array.isArray(input["blockedBy"])) {
      task.blockedBy = input["blockedBy"] as string[];
      changes.push(`blockedBy → [${task.blockedBy.join(", ")}]`);
    }

    if (Array.isArray(input["blocks"])) {
      task.blocks = input["blocks"] as string[];
      changes.push(`blocks → [${task.blocks.join(", ")}]`);
    }

    if (changes.length === 0) {
      return { content: `Task #${id}: nothing to update`, isError: true };
    }

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
    const tasks = getSessionTasks(ctx.sessionId);
    if (tasks.size === 0) {
      return { content: "No tasks in this session." };
    }

    const lines = Array.from(tasks.values()).map(t => {
      const statusIcon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
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
    const tasks = getSessionTasks(ctx.sessionId);
    const id = input["id"] as string;
    const task = tasks.get(id);

    if (!task) {
      return { content: `Task #${id} not found`, isError: true };
    }

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
