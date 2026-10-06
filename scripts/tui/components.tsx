/**
 * Shared TUI primitives: bordered Panel and aligned DataTable.
 * Pure presentation — no trading logic.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme, Badge, ModeBadge, ReadinessBadge, StateBadge } from './theme.js';

export { Badge, ModeBadge, ReadinessBadge, StateBadge };

/** Bordered panel with a title bar. */
export function Panel({ title, width, children }: { title: string; width?: number | string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>{title}</Text>
      {children}
    </Box>
  );
}

/** Key/value row: dim key, bright value. */
export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Box>
      <Box width={18}><Text color={theme.dim}>{k}</Text></Box>
      <Text>{v}</Text>
    </Box>
  );
}

export type Column = { header: string; width: number };

/** Compact aligned table. rows are arrays of React nodes. */
export function DataTable({ columns, rows, emptyText }: { columns: Column[]; rows: React.ReactNode[][]; emptyText?: string }) {
  if (rows.length === 0) {
    return <Text color={theme.dim}>{emptyText ?? '(no rows)'}</Text>;
  }
  const cell = (node: React.ReactNode, width: number) => (
    <Box width={width} flexShrink={0} overflow="hidden">
      <Text wrap="truncate">{node}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column">
      <Box>
        {columns.map((col, i) => (
          <Box key={i} width={col.width} flexShrink={0}>
            <Text color={theme.bright} bold wrap="truncate">{col.header}</Text>
          </Box>
        ))}
      </Box>
      {rows.map((row, r) => (
        <Box key={r}>
          {row.map((val, i) => (
            <React.Fragment key={i}>{cell(val, columns[i]?.width ?? 12)}</React.Fragment>
          ))}
        </Box>
      ))}
    </Box>
  );
}
