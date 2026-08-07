/**
 * Tool registry.
 *
 * A simple Map-based registry that tools self-register into at module load time.
 * Zero coupling between tools — no tool knows about any other tool.
 * The engine calls getAllTools() to discover what's available.
 *
 * Tools can be disabled at startup via disableTools(), which is called once
 * after config is loaded. Disabled tools are invisible to the model.
 */

import type { Tool } from "../types/tool.js";
import { toolToOpenAIFunction } from "../types/tool.js";

const registry = new Map<string, Tool>();
const disabledSet = new Set<string>();

/** Registers a tool. Throws if a tool with the same name is already registered. */
export function registerTool(tool: Tool): void {
  if (registry.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
  registry.set(tool.name, tool);
}

/** Returns a registered tool by name, or undefined if not found */
export function getTool(name: string): Tool | undefined {
  return disabledSet.has(name) ? undefined : registry.get(name);
}

/**
 * Marks the given tool names as disabled. Called once at startup with the
 * list from config.permissions.disabledTools. Disabled tools are excluded
 * from getAllTools() and therefore invisible to the model.
 */
export function disableTools(names: string[]): void {
  for (const name of names) {
    disabledSet.add(name);
  }
}

/** Replaces the disabled-tool set, used by configuration hot reload. */
export function setDisabledTools(names: string[]): void {
  disabledSet.clear();
  disableTools(names);
}

/** Returns all currently enabled tools that are not disabled by config */
export function getAllTools(): Tool[] {
  return Array.from(registry.values()).filter(
    t => !disabledSet.has(t.name) && t.isEnabled()
  );
}

/** Returns all enabled tools as OpenAI function-calling schema objects */
export function getToolsAsOpenAIFunctions(): Record<string, unknown>[] {
  return getAllTools().map(toolToOpenAIFunction);
}

/** Returns all registered tool names (for debugging/help display) */
export function getRegisteredToolNames(): string[] {
  return Array.from(registry.keys());
}
