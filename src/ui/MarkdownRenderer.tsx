/**
 * MarkdownRenderer — converts Markdown to styled Ink terminal components.
 *
 * Used for completed assistant messages. The streaming buffer intentionally
 * bypasses this component and displays raw text — partial Markdown renders
 * poorly (unclosed code fences, etc.), so we only render when the response
 * is complete.
 *
 * Supported elements
 *   Block:  heading (h1–h6), paragraph, fenced code block, ordered/unordered
 *           list, blockquote, table, horizontal rule, blank lines
 *   Inline: bold, italic, strikethrough, inline code, link, plain text
 *
 * Inline formatting is realised as ANSI escape sequences so styled fragments
 * can participate in natural text flow without forcing line breaks.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';
import type { Token, Tokens } from 'marked';

// ---------------------------------------------------------------------------
// ANSI helpers — used only for inline formatting within paragraphs
// ---------------------------------------------------------------------------

const A = {
  bold:      '\x1b[1m',  boldOff:      '\x1b[22m',
  italic:    '\x1b[3m',  italicOff:    '\x1b[23m',
  strike:    '\x1b[9m',  strikeOff:    '\x1b[29m',
  inverse:   '\x1b[7m',
  reset:     '\x1b[0m',
  cyan:      '\x1b[36m',
  gray:      '\x1b[90m',
} as const;

// ---------------------------------------------------------------------------
// Inline token → ANSI string
// ---------------------------------------------------------------------------

function renderInline(tokens: Token[] | undefined, fallback = ''): string {
  if (!tokens?.length) return fallback;
  return tokens.map(inlineToken).join('');
}

function inlineToken(t: Token): string {
  switch (t.type) {
    case 'strong': {
      const s = t as Tokens.Strong;
      return `${A.bold}${renderInline(s.tokens, s.text)}${A.boldOff}`;
    }
    case 'em': {
      const s = t as Tokens.Em;
      return `${A.italic}${renderInline(s.tokens, s.text)}${A.italicOff}`;
    }
    case 'del': {
      const s = t as Tokens.Del;
      return `${A.strike}${renderInline(s.tokens, s.text)}${A.strikeOff}`;
    }
    case 'codespan': {
      const s = t as Tokens.Codespan;
      // Inverse + cyan gives a clear "chip" appearance for inline code
      return `${A.inverse}${A.cyan} ${s.text} ${A.reset}`;
    }
    case 'link': {
      const s = t as Tokens.Link;
      const label = renderInline(s.tokens, s.text);
      // Show URL in parentheses so users can copy it
      return s.href ? `${label}${A.gray}(${s.href})${A.reset}` : label;
    }
    case 'text': {
      const s = t as Tokens.Text;
      return s.tokens?.length ? renderInline(s.tokens, s.text) : s.text;
    }
    case 'escape':
      return (t as Tokens.Escape).text;
    case 'br':
      return '\n';
    default:
      return t.raw ?? '';
  }
}

// ---------------------------------------------------------------------------
// Block components
// ---------------------------------------------------------------------------

function HeadingBlock({ token }: { token: Tokens.Heading }): React.ReactElement {
  const text = renderInline(token.tokens, token.text);
  if (token.depth === 1) {
    // ▌ Title   cyan + bold — most prominent
    return <Box marginBottom={0}><Text bold color="cyan">{`▌ ${text}`}</Text></Box>;
  }
  if (token.depth === 2) {
    // ▸ Title   bold
    return <Box marginBottom={0}><Text bold>{`▸ ${text}`}</Text></Box>;
  }
  // ### Title   dim hashes + bold text
  const prefix = `${A.gray}${'#'.repeat(token.depth)} ${A.reset}`;
  return (
    <Box marginBottom={0}>
      <Text>{`${prefix}${A.bold}${text}${A.boldOff}`}</Text>
    </Box>
  );
}

function ParagraphBlock({ token }: { token: Tokens.Paragraph }): React.ReactElement {
  return <Text>{renderInline(token.tokens, token.text)}</Text>;
}

function CodeBlock({ token }: { token: Tokens.Code }): React.ReactElement {
  // Extract the language tag (may have extra attributes after a space)
  const lang = (token.lang ?? '').split(/\s/)[0] ?? '';
  const lines = token.text.split('\n');

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {lang !== '' && (
        <Text color="gray" dimColor>{lang}</Text>
      )}
      {lines.map((line, i) => (
        // Empty lines must render as a single space so Ink assigns them height
        <Text key={i} color="yellow">{line.length > 0 ? line : ' '}</Text>
      ))}
    </Box>
  );
}

/** Renders the content tokens inside a single list item. */
function ListItemContent({ tokens }: { tokens: Token[] }): React.ReactElement {
  const nodes = tokens.map((t, i) => {
    if (t.type === 'text') {
      const s = t as Tokens.Text;
      return <Text key={i}>{renderInline(s.tokens, s.text)}</Text>;
    }
    if (t.type === 'paragraph') {
      const s = t as Tokens.Paragraph;
      return <Text key={i}>{renderInline(s.tokens, s.text)}</Text>;
    }
    // Nested lists, code blocks, etc.
    return <BlockToken key={i} token={t} />;
  });
  return <Box flexDirection="column">{nodes}</Box>;
}

function ListBlock({ token }: { token: Tokens.List }): React.ReactElement {
  const startNum = typeof token.start === 'number' ? token.start : 1;

  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => {
        const bullet = token.ordered ? `${startNum + i}.` : '•';
        return (
          <Box key={i} flexDirection="row">
            {/* Fixed-width gutter so text wraps under itself, not the bullet */}
            <Box width={4}>
              <Text color="gray">{`${bullet} `}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <ListItemContent tokens={item.tokens} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function BlockquoteBlock({ token }: { token: Tokens.Blockquote }): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text color="gray">{'┃ '}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {token.tokens.map((t, i) => <BlockToken key={i} token={t} />)}
      </Box>
    </Box>
  );
}

function TableBlock({ token }: { token: Tokens.Table }): React.ReactElement {
  const renderCell = (cell: Tokens.TableCell): string =>
    renderInline(cell.tokens, cell.text);

  const headerCells = token.header.map(renderCell);
  const divider = headerCells.map(h => '─'.repeat(Math.max(3, h.length))).join('─┼─');

  return (
    <Box flexDirection="column">
      <Text bold>{headerCells.join(' │ ')}</Text>
      <Text color="gray">{divider}</Text>
      {token.rows.map((row, i) => (
        <Text key={i}>{row.map(renderCell).join(' │ ')}</Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Block token dispatcher
// ---------------------------------------------------------------------------

function BlockToken({ token }: { token: Token }): React.ReactElement {
  switch (token.type) {
    case 'heading':
      return <HeadingBlock token={token as Tokens.Heading} />;
    case 'paragraph':
      return <ParagraphBlock token={token as Tokens.Paragraph} />;
    case 'code':
      return <CodeBlock token={token as Tokens.Code} />;
    case 'list':
      return <ListBlock token={token as Tokens.List} />;
    case 'blockquote':
      return <BlockquoteBlock token={token as Tokens.Blockquote} />;
    case 'table':
      return <TableBlock token={token as Tokens.Table} />;
    case 'hr':
      return <Text color="gray">{'─'.repeat(50)}</Text>;
    case 'space':
      // Blank line between Markdown blocks
      return <Box height={1} />;
    default:
      return <Text>{token.raw ?? ''}</Text>;
  }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function MarkdownRenderer({ content }: { content: string }): React.ReactElement {
  // Memoise parsing — lexing is fast but we avoid re-running on re-renders
  // triggered by unrelated state changes (e.g. spinner ticks).
  const tokens = useMemo(() => marked.lexer(content), [content]);

  return (
    <Box flexDirection="column" gap={0}>
      {tokens.map((token, i) => (
        <BlockToken key={i} token={token} />
      ))}
    </Box>
  );
}
