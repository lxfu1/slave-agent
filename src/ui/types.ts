/**
 * UI 模块统一类型定义
 */

import type { SessionUsage } from "../engine/conversationEngine.js";

// ---------------------------------------------------------------------------
// App 状态
// ---------------------------------------------------------------------------

export type AppState =
  | "idle"
  | "streaming"
  | "tool_running"
  | "interrupting"
  | "awaiting_permission"
  | "searching";

// ---------------------------------------------------------------------------
// 消息条目类型
// ---------------------------------------------------------------------------

export type MessageEntryData =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; isStreaming?: boolean }
  | {
      kind: "tool_call";
      name: string;
      toolId: string;
      status: "running" | "done" | "error";
      result?: string;
      description?: string;
    }
  | {
      kind: "notice";
      content: string;
      level: "info" | "error" | "help" | "success";
    }
  | { kind: "separator"; label: string };

export type MessageEntry = MessageEntryData & { id: string };

// ---------------------------------------------------------------------------
// 搜索相关类型
// ---------------------------------------------------------------------------

export interface SearchState {
  query: string;
  results: number[];
  currentIdx: number;
}

// ---------------------------------------------------------------------------
// 输入状态类型
// ---------------------------------------------------------------------------

export interface InputState {
  linesDisplay: string[];
  currentLineIdx: number;
  cursorPos: number;
  linesRef: React.MutableRefObject<string[]>;
  currentLineIdxRef: React.MutableRefObject<number>;
  cursorPosRef: React.MutableRefObject<number>;
  getInputText: () => string;
  setLines: (newLines: string[], newLineIdx?: number, newCursorPos?: number) => void;
  updateCursorInLine: (pos: number) => void;
  updateCurrentLine: (idx: number) => void;
  setInputFromHistory: (text: string) => void;
  inputHistoryRef: React.MutableRefObject<string[]>;
  historyIdxRef: React.MutableRefObject<number>;
  savedInputRef: React.MutableRefObject<string[]>;
  pushHistory: (text: string) => void;
}

// ---------------------------------------------------------------------------
// StatusBar 属性
// ---------------------------------------------------------------------------

export interface StatusBarProps {
  model: string;
  mode: "ask" | "auto";
  profile: string;
  usage: SessionUsage;
  isStreaming: boolean;
}

// ---------------------------------------------------------------------------
// Search 组件属性
// ---------------------------------------------------------------------------

export interface SearchBarProps {
  query: string;
  results: number[];
  currentIdx: number;
}

export interface SearchResultsPanelProps {
  entries: MessageEntry[];
  query: string;
  matchedIndices: number[];
  currentIdx: number;
}
