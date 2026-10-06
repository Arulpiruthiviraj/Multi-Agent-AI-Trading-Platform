/**
 * TUI theme (2026-10-06): mainframe/institutional-terminal aesthetic.
 *
 * Restrained semantic colors:
 *   green  — healthy / connected / approved
 *   yellow — warning / delayed / degraded / waiting
 *   red    — error / blocked / risk rejection / disconnected
 *   cyan   — informational / market data
 *   gray   — disabled / inactive
 * Never depend on color alone: every state also carries text.
 * NO_COLOR env disables all color (monochrome mode).
 */
import React from 'react';
import { Text } from 'ink';

export const colorEnabled = (): boolean => !process.env.NO_COLOR;

type InkColor = 'green' | 'yellow' | 'red' | 'cyan' | 'gray' | 'white' | 'magenta' | undefined;

function c(color: Exclude<InkColor, undefined>): InkColor {
  return colorEnabled() ? color : undefined;
}

export const theme = {
  ok: c('green'),
  warn: c('yellow'),
  err: c('red'),
  info: c('cyan'),
  dim: c('gray'),
  bright: c('white'),
  accent: c('magenta'),
  border: c('gray'),
};

/** Small colored status badge with text (text never relies on color alone). */
export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'info' | 'dim'; children: React.ReactNode }) {
  const color = { ok: theme.ok, warn: theme.warn, err: theme.err, info: theme.info, dim: theme.dim }[tone];
  return <Text color={color} bold>[{children}]</Text>;
}

/** Trading-mode badge: PAPER is safe-green, LIVE is danger-red, always labeled. */
export function ModeBadge({ mode }: { mode?: string | null }) {
  const m = (mode ?? 'UNKNOWN').toUpperCase();
  if (m === 'LIVE') return <Badge tone="err">LIVE</Badge>;
  if (m === 'PAPER') return <Badge tone="ok">PAPER</Badge>;
  return <Badge tone="dim">{m}</Badge>;
}

/** Live-readiness badge. */
export function ReadinessBadge({ readiness }: { readiness?: string | null }) {
  const r = (readiness ?? 'UNKNOWN').toUpperCase();
  if (r === 'LIVE_NO_GO') return <Badge tone="warn">LIVE_NO_GO</Badge>;
  if (r === 'LIVE_GO') return <Badge tone="err">LIVE_GO</Badge>;
  return <Badge tone="dim">{r}</Badge>;
}

/** Trading-state badge. */
export function StateBadge({ state }: { state?: string | null }) {
  const s = (state ?? 'UNKNOWN').toUpperCase();
  if (s === 'TRADING_ENABLED') return <Badge tone="ok">TRADING ENABLED</Badge>;
  if (s === 'TRADING_PAUSED') return <Badge tone="warn">TRADING PAUSED</Badge>;
  if (s === 'EMERGENCY_STOP' || s === 'KILL_SWITCH') return <Badge tone="err">{s.replace('_', ' ')}</Badge>;
  return <Badge tone="dim">{s}</Badge>;
}
