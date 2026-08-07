/**
 * Entries management hook
 * Handles message entries, committed count, and clear count
 */

import { useCallback, useRef, useState } from "react";
import type { MessageEntry, MessageEntryData } from "../types.js";

export interface UseEntriesResult {
  entries: MessageEntry[];
  entriesRef: React.MutableRefObject<MessageEntry[]>;
  committedCount: number;
  clearCount: number;
  addEntry: (entry: MessageEntryData) => void;
  updateToolEntry: (toolId: string, status: "done" | "error", result: string) => void;
  setToolDescription: (toolId: string, description: string) => void;
  commitEntries: () => void;
  clearEntries: () => void;
  replaceEntries: (entries: MessageEntryData[]) => void;
}

export function useEntries(initialEntries: MessageEntryData[] = []): UseEntriesResult {
  const initialWithIds = useRef<MessageEntry[]>(
    initialEntries.map((entry, index) => ({ ...entry, id: String(index + 1) })),
  );
  const [entries, setEntries] = useState<MessageEntry[]>(initialWithIds.current);
  const entriesRef = useRef<MessageEntry[]>(initialWithIds.current);
  const [committedCount, setCommittedCount] = useState(initialWithIds.current.length);
  const [clearCount, setClearCount] = useState(0);
  const entryIdCounter = useRef(initialWithIds.current.length);

  const addEntry = useCallback((entry: MessageEntryData) => {
    entryIdCounter.current += 1;
    const withId: MessageEntry = { ...entry, id: String(entryIdCounter.current) };
    entriesRef.current = [...entriesRef.current, withId];
    setEntries(entriesRef.current);
  }, []);

  const updateToolEntry = useCallback((
    toolId: string,
    status: "done" | "error",
    result: string,
  ) => {
    entriesRef.current = entriesRef.current.map((e) =>
      e.kind === "tool_call" && e.toolId === toolId
        ? { ...e, status, result }
        : e
    );
    setEntries(entriesRef.current);
  }, []);

  const setToolDescription = useCallback((toolId: string, description: string) => {
    entriesRef.current = entriesRef.current.map((e) =>
      e.kind === "tool_call" && e.toolId === toolId
        ? { ...e, description }
        : e
    );
    setEntries(entriesRef.current);
  }, []);

  const commitEntries = useCallback(() => {
    setCommittedCount(entriesRef.current.length);
  }, []);

  const clearEntries = useCallback(() => {
    commitEntries();
    setClearCount((c) => c + 1);
    entriesRef.current = [];
    setEntries([]);
    setCommittedCount(0);
  }, [commitEntries]);

  const replaceEntries = useCallback((newEntries: MessageEntryData[]) => {
    const withIds = newEntries.map(entry => {
      entryIdCounter.current += 1;
      return { ...entry, id: String(entryIdCounter.current) } as MessageEntry;
    });
    entriesRef.current = withIds;
    setEntries(withIds);
    setCommittedCount(withIds.length);
    setClearCount(count => count + 1);
  }, []);

  return {
    entries,
    entriesRef,
    committedCount,
    clearCount,
    addEntry,
    updateToolEntry,
    setToolDescription,
    commitEntries,
    clearEntries,
    replaceEntries,
  };
}
