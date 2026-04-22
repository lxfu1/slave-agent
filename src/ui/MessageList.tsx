/**
 * Message list component.
 *
 * Sub-components:
 *   UserMessage      — user input, dashed bottom border
 *   AssistantMessage — streaming or complete model response
 *   ToolCallCard     — tool name + status; result shown only for errors or
 *                      short success messages (≤120 chars)
 *   SystemNotice     — command output, errors, notices
 *   Separator        — context-compression / session markers
 *
 * Streaming buffer hook:
 *   useStreamingBuffer — accumulates deltas in a ref, triggers a re-render
 *   every 50 ms so the display updates without thrashing React state.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import type { MessageEntry } from './types.js';

// Re-export types for backwards compatibility
export type { MessageEntry, MessageEntryData } from './types.js';
export { useStreamingBuffer } from './hooks/useStreamingBuffer.js';

// ---------------------------------------------------------------------------
// MessageList
// ---------------------------------------------------------------------------

interface MessageListProps {
  entries: MessageEntry[];
  streamingBuffer?: string;
}

export function MessageList({
  entries,
  streamingBuffer
}: MessageListProps): React.ReactElement {
  return (
    <Box flexDirection='column' gap={0}>
      {entries.map((entry) => (
        <MessageEntryItem key={entry.id} entry={entry} />
      ))}
      {streamingBuffer && (
        <Box paddingX={1}>
          <Text color='white'>{streamingBuffer}</Text>
          <Text color='cyan'>▊</Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Single-entry renderer — exported for use in App's Static section
// ---------------------------------------------------------------------------

export function MessageEntryItem({
  entry
}: {
  entry: MessageEntry;
}): React.ReactElement {
  switch (entry.kind) {
    case 'user':
      return <UserMessage content={entry.content} />;
    case 'assistant':
      return (
        <AssistantMessage
          content={entry.content}
          isStreaming={entry.isStreaming as boolean}
        />
      );
    case 'tool_call':
      return (
        <ToolCallCard
          name={entry.name}
          status={entry.status as 'running' | 'done' | 'error'}
          result={entry.result}
          description={entry.description}
        />
      );
    case 'notice':
      return <SystemNotice content={entry.content} level={entry.level} />;
    case 'separator':
      return <Separator label={entry.label} />;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UserMessage({ content }: { content: string }): React.ReactElement {
  return (
    <Box
      marginY={0}
      paddingX={1}
      borderStyle='classic'
      borderBottom
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor='gray'
      flexDirection='column'
    >
      <Text color='white' dimColor>
        user
      </Text>
      <Text color='white'>{content}</Text>
    </Box>
  );
}

function AssistantMessage({
  content,
  isStreaming
}: {
  content: string;
  isStreaming?: boolean;
}): React.ReactElement {
  return (
    <Box marginY={0} paddingX={1} flexDirection='column'>
      <Text color='cyan' dimColor>
        assistant{isStreaming ? ' ●' : ''}
      </Text>
      {/* Streaming text shows raw — Markdown only renders on completed messages */}
      {isStreaming ? (
        <Text color='white'>{content}</Text>
      ) : (
        <MarkdownRenderer content={content} />
      )}
    </Box>
  );
}

function ToolCallCard({
  name,
  status,
  result,
  description
}: {
  name: string;
  status: 'running' | 'done' | 'error';
  result?: string | undefined;
  description?: string | undefined;
}): React.ReactElement {
  const icon = status === 'running' ? '⟳' : status === 'done' ? '✓' : '✗';
  const color =
    status === 'running' ? 'yellow' : status === 'done' ? 'green' : 'red';

  // Show result for errors (up to 500 chars) or very short success messages
  // (≤120 chars). For long successful results (e.g. file content) we rely on
  // `description` to tell the user what happened, not the full result body.
  const showResult =
    result !== undefined &&
    status !== 'running' &&
    (status === 'error' || result.length <= 120);

  const displayResult = showResult
    ? result.slice(0, status === 'error' ? 500 : 120) +
      (result.length > 500 ? '…' : '')
    : undefined;

  return (
    <Box
      marginY={0}
      paddingX={1}
      borderStyle='single'
      borderColor='gray'
      flexDirection='column'
    >
      <Box gap={1}>
        <Text color={color}>{icon}</Text>
        <Text color='gray'>{name}</Text>
        {/* Description shows which file / command / pattern is being processed */}
        {description !== undefined && description !== '' && (
          <Text color='gray' dimColor>
            {description}
          </Text>
        )}
      </Box>
      {displayResult && (
        <Text
          color={status === 'error' ? 'red' : 'gray'}
          dimColor={status !== 'error'}
        >
          {displayResult}
        </Text>
      )}
    </Box>
  );
}

function SystemNotice({
  content,
  level
}: {
  content: string;
  level: 'info' | 'error' | 'help' | 'success';
}): React.ReactElement {
  const color =
    level === 'error'
      ? 'red'
      : level === 'success'
        ? 'green'
        : level === 'help'
          ? 'cyan'
          : 'gray';

  return (
    <Box marginY={0} paddingX={1} borderStyle='single' borderColor={color}>
      <Text color={color}>{content}</Text>
    </Box>
  );
}

function Separator({ label }: { label: string }): React.ReactElement {
  return (
    <Box marginY={0} paddingX={1}>
      <Text color='gray' dimColor>
        ── {label} ──
      </Text>
    </Box>
  );
}
