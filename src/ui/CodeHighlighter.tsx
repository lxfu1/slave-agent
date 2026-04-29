/**
 * Syntax highlighter for code blocks in terminal.
 *
 * Provides basic syntax highlighting for common languages:
 * - TypeScript/JavaScript
 * - Python
 * - Go
 * - Rust
 * - Shell/Bash
 * - JSON/YAML
 * - TypeScript JSX/TSX
 *
 * Uses ANSI color codes for terminal rendering.
 */

import type { Tokens } from 'marked';
import React from 'react';
import { Box, Text } from 'ink';

// ANSI color codes for syntax highlighting
const C = {
  keyword: '\x1b[35m',     // magenta (purple)
  string: '\x1b[32m',      // green
  number: '\x1b[33m',      // yellow
  comment: '\x1b[90m',     // gray (dim)
  function: '\x1b[36m',    // cyan
  type: '\x1b[34m',        // blue
  variable: '\x1b[37m',     // white
  operator: '\x1b[37m',    // white
  reset: '\x1b[0m',
} as const;

// Common keywords for multiple languages
const KEYWORDS = new Set([
  // TypeScript/JavaScript
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally',
  'throw', 'new', 'this', 'class', 'extends', 'implements', 'interface', 'type',
  'import', 'export', 'from', 'as', 'async', 'await', 'yield', 'in', 'of',
  'typeof', 'instanceof', 'void', 'null', 'undefined', 'true', 'false',
  // Python
  'def', 'lambda', 'class', 'if', 'elif', 'else', 'for', 'while', 'return',
  'yield', 'try', 'except', 'finally', 'raise', 'with', 'as', 'import', 'from',
  'pass', 'break', 'continue', 'global', 'nonlocal', 'assert', 'del', 'async',
  'await', 'None', 'True', 'False',
  // Go
  'func', 'var', 'const', 'type', 'struct', 'interface', 'package', 'import',
  'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break',
  'continue', 'goto', 'defer', 'go', 'chan', 'map', 'make', 'new', 'len', 'cap',
  'append', 'copy', 'delete', 'close', 'select', 'fallthrough', 'nil', 'error',
  // Rust
  'fn', 'let', 'mut', 'const', 'static', 'type', 'struct', 'enum', 'trait',
  'impl', 'pub', 'use', 'mod', 'crate', 'super', 'self', 'if', 'else', 'match',
  'loop', 'while', 'for', 'in', 'break', 'continue', 'return', 'async', 'await',
  'move', 'ref', 'where', 'unsafe', 'extern', 'as', 'dyn', 'Some', 'None', 'Ok',
  'Err',
]);

/**
 * Apply syntax highlighting to a line of code.
 * Returns an array of [text, color] tuples.
 */
function highlightLine(line: string, _lang: string): Array<{ text: string; color?: string }> {
  if (!line) return [{ text: ' ' }];

  const result: Array<{ text: string; color?: string }> = [];

  // Find all tokens
  const tokens: Array<{ start: number; end: number; color: string; text: string }> = [];

  // Comments (highest priority)
  const commentMatch = line.match(/^(\s*)(#|\/\/|<!--).*$/);
  if (commentMatch) {
    const leading = commentMatch[1] || '';
    if (leading) tokens.push({ start: 0, end: leading.length, color: C.variable, text: leading });
    tokens.push({
      start: leading.length,
      end: line.length,
      color: C.comment,
      text: line.slice(leading.length),
    });
  }

  // Block comments
  const blockCommentMatch = line.match(/(\/\*[\s\S]*?\*\/)/);
  if (blockCommentMatch && blockCommentMatch.index !== undefined) {
    tokens.push({
      start: blockCommentMatch.index,
      end: blockCommentMatch.index + blockCommentMatch[0].length,
      color: C.comment,
      text: blockCommentMatch[0],
    });
  }
  
  // Strings
  const stringRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
  let match;
  while ((match = stringRegex.exec(line)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length, color: C.string, text: match[0] });
  }
  
  // Numbers
  const numberRegex = /\b-?\d+(\.\d+)?([eE][+-]?\d+)?\b/g;
  while ((match = numberRegex.exec(line)) !== null) {
    // Skip if inside a string or comment
    const m = match;
    if (!tokens.some(t => m.index >= t.start && m.index < t.end)) {
      tokens.push({ start: match.index, end: match.index + match[0].length, color: C.number, text: match[0] });
    }
  }
  
  // Keywords
  const keywordRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
  while ((match = keywordRegex.exec(line)) !== null) {
    const word = match[0];
    const m = match;
    if (KEYWORDS.has(word) && !tokens.some(t => m.index >= t.start && m.index < t.end)) {
      tokens.push({ start: match.index, end: match.index + word.length, color: C.keyword, text: word });
    }
  }
  
  // Function calls
  const funcRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\s*(?=\()/g;
  while ((match = funcRegex.exec(line)) !== null) {
    const m = match;
    if (!tokens.some(t => m.index >= t.start && m.index < t.end)) {
      tokens.push({ 
        start: match.index, 
        end: match.index + match[0].trim().length, 
        color: C.function, 
        text: match[0].trim() 
      });
    }
  }
  
  // Sort tokens by position
  tokens.sort((a, b) => a.start - b.start);
  
  // Build result with non-highlighted parts
  let currentPos = 0;
  for (const token of tokens) {
    if (token.start > currentPos) {
      result.push({ text: line.slice(currentPos, token.start) });
    }
    result.push({ text: token.text, color: token.color });
    currentPos = token.end;
  }
  
  // Add remaining text
  if (currentPos < line.length) {
    result.push({ text: line.slice(currentPos) });
  }
  
  return result.length > 0 ? result : [{ text: line || ' ' }];
}

// ---------------------------------------------------------------------------
// Public component - HighlightedCodeBlock
// ---------------------------------------------------------------------------

export interface HighlightedCodeBlockProps {
  token: Tokens.Code;
  maxHeight?: number; // max lines to show
}

export function HighlightedCodeBlock({ token, maxHeight }: HighlightedCodeBlockProps): React.ReactElement {
  const lang = (token.lang ?? '').split(/\s/)[0] ?? '';
  const lines = token.text.split('\n');
  
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  
  // Limit height if specified
  const displayLines = maxHeight && lines.length > maxHeight
    ? lines.slice(0, maxHeight)
    : lines;
  const hasMore = maxHeight !== undefined && lines.length > maxHeight;
  
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {lang !== '' && (
        <Text color="gray" dimColor>{lang}</Text>
      )}
      {displayLines.map((line, i) => {
        const parts = highlightLine(line, lang);
        return (
          <Box key={i} flexDirection="row">
            {parts.map((part, j) => (
              <Text key={j} color={part.color as string}>{part.text}</Text>
            ))}
          </Box>
        );
      })}
      {hasMore && (
        <Text color="gray" dimColor>... ({lines.length - displayLines.length} more lines)</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Simple fallback code block (no highlighting) - for search/filter mode
// ---------------------------------------------------------------------------

export function PlainCodeBlock({ token, maxHeight }: HighlightedCodeBlockProps): React.ReactElement {
  const lang = (token.lang ?? '').split(/\s/)[0] ?? '';
  const lines = token.text.split('\n');
  
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  
  const displayLines = maxHeight && lines.length > maxHeight
    ? lines.slice(0, maxHeight)
    : lines;
  const hasMore = maxHeight !== undefined && lines.length > maxHeight;
  
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {lang !== '' && (
        <Text color="gray" dimColor>{lang}</Text>
      )}
      {displayLines.map((line, i) => (
        <Text key={i} color="yellow">{line.length > 0 ? line : ' '}</Text>
      ))}
      {hasMore && (
        <Text color="gray" dimColor>... ({lines.length - displayLines.length} more lines)</Text>
      )}
    </Box>
  );
}
