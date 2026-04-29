import React from "react";
import { Box, Text } from "ink";
import type { MessageEntry, SearchBarProps, SearchResultsPanelProps } from "./types.js";

// ---------------------------------------------------------------------------
// Entry text extractor
// ---------------------------------------------------------------------------

export function getEntryDisplayText(entry: MessageEntry): string {
  switch (entry.kind) {
    case "user":
    case "assistant":
      return entry.content;
    case "tool_call":
      return `${entry.name} ${entry.description ?? ""} ${entry.result ?? ""}`.trim();
    case "notice":
      return entry.content;
    case "separator":
      return entry.label;
  }
}

// ---------------------------------------------------------------------------
// Snippet extractor
// ---------------------------------------------------------------------------

export function getSnippet(text: string, query: string, maxLen = 120): string {
  if (!query.trim()) return text.slice(0, maxLen);
  const lc = text.toLowerCase();
  const idx = lc.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

// ---------------------------------------------------------------------------
// Inline highlight
// ---------------------------------------------------------------------------

function TextWithHighlight({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!query.trim()) return <Text color="white">{text}</Text>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} bold color="black" backgroundColor="yellow">{part}</Text>
        ) : (
          <Text key={i} color="white">{part}</Text>
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SearchBar
// ---------------------------------------------------------------------------

export function SearchBar({ query, results, currentIdx }: SearchBarProps): React.ReactElement {
  const hasResults = results.length > 0;
  const statusColor = hasResults ? "green" : "gray";
  const statusText = hasResults ? `${currentIdx + 1}/${results.length}` : "no results";

  return (
    <Box paddingX={1} borderStyle="single" borderColor="cyan" flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>/filter </Text>
        <Text color="white">{query}</Text>
        <Text color="cyan">▊</Text>
      </Box>
      <Box flexDirection="row" gap={2}>
        <Text color={statusColor}>{statusText}</Text>
        <Text color="gray" dimColor>↑/↓ nav • Enter exit • Esc clear</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SearchResultsPanel
// ---------------------------------------------------------------------------

export function SearchResultsPanel({
  entries,
  query,
  matchedIndices,
  currentIdx,
}: SearchResultsPanelProps): React.ReactElement {
  if (matchedIndices.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray" dimColor>No matches found</Text>
      </Box>
    );
  }

  const VISIBLE = 5;
  const start = Math.max(0, currentIdx - 2);
  const end = Math.min(matchedIndices.length, start + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      {matchedIndices.slice(start, end).map((entryIdx, slicePos) => {
        const absPos = start + slicePos;
        const isCurrent = absPos === currentIdx;
        const entry = entries[entryIdx] as (typeof entries)[number];
        const fullText = getEntryDisplayText(entry);
        const snippet = getSnippet(fullText, query);
        const kindLabel = entry.kind === "tool_call" ? entry.name : entry.kind;

        return (
          <Box key={entryIdx} flexDirection="row" gap={1}>
            <Text color={isCurrent ? "cyan" : "gray"}>{isCurrent ? "▶" : " "}</Text>
            <Text color="gray" dimColor>{`[${kindLabel}]`}</Text>
            {isCurrent ? (
              <TextWithHighlight text={snippet} query={query} />
            ) : (
              <Text color="gray">{snippet}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
