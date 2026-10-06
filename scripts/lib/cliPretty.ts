/**
 * cliPretty.ts — beautiful, colorful CLI output for the Argus CLI.
 *
 * 2026-10-06. Zero-dependency ANSI color/formatting helpers. Colors are
 * automatically disabled when:
 *   - NO_COLOR is set (https://no-color.org convention),
 *   - stdout is not a TTY (piped output stays clean for scripting),
 *   - --no-color is passed.
 * Use `isPretty()` to decide whether to render the colorful variant of a
 * command's output; plain output remains the default so scripts never break.
 */

// ---------------------------------------------------------------------------
// Color enablement
// ---------------------------------------------------------------------------

let forceColor: boolean | null = null;

/** Call once from the CLI entrypoint when --pretty/--color is passed. */
export function setPrettyEnabled(enabled: boolean): void {
  forceColor = enabled;
}

/** True when colors/formatting should be emitted. */
export function isPretty(): boolean {
  if (forceColor !== null) return forceColor;
  if (process.env.NO_COLOR) return false;
  return !!process.stdout.isTTY;
}

// ---------------------------------------------------------------------------
// ANSI primitives
// ---------------------------------------------------------------------------

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

const CODES: Record<string, string> = {
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  brightRed: '91',
  brightGreen: '92',
  brightYellow: '93',
  brightBlue: '94',
  brightMagenta: '95',
  brightCyan: '96',
  brightWhite: '97',
  bold: '1',
  dim: '2',
};

function wrap(code: string, text: string): string {
  if (!isPretty()) return text;
  return `${ESC}${code}m${text}${RESET}`;
}

export const red = (t: string) => wrap(CODES.red, t);
export const green = (t: string) => wrap(CODES.green, t);
export const yellow = (t: string) => wrap(CODES.yellow, t);
export const blue = (t: string) => wrap(CODES.blue, t);
export const magenta = (t: string) => wrap(CODES.magenta, t);
export const cyan = (t: string) => wrap(CODES.cyan, t);
export const white = (t: string) => wrap(CODES.white, t);
export const gray = (t: string) => wrap(CODES.gray, t);
export const brightRed = (t: string) => wrap(CODES.brightRed, t);
export const brightGreen = (t: string) => wrap(CODES.brightGreen, t);
export const brightYellow = (t: string) => wrap(CODES.brightYellow, t);
export const brightCyan = (t: string) => wrap(CODES.brightCyan, t);
export const bold = (t: string) => wrap(CODES.bold, t);
export const dim = (t: string) => wrap(CODES.dim, t);

/** Strip ANSI codes — for width calculations and tests. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[\d+m/g, '');
}

/** Visible width of a (possibly colored) string. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

// ---------------------------------------------------------------------------
// Badges & status pills
// ---------------------------------------------------------------------------

export type BadgeColor = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta';

/** A colored status pill like ● LIVE or ■ PAUSED. */
export function badge(text: string, color: BadgeColor): string {
  const dot = '●';
  const colored = { green, red, yellow, cyan, gray, magenta }[color](`${dot} ${text}`);
  return isPretty() ? colored : `[${text}]`;
}

/** Trading-state badge with the right color for each state. */
export function tradingStateBadge(state: string | undefined | null): string {
  const s = (state ?? 'UNKNOWN').toUpperCase();
  if (s === 'TRADING_ENABLED') return badge('TRADING ENABLED', 'green');
  if (s === 'TRADING_PAUSED') return badge('TRADING PAUSED', 'yellow');
  if (s === 'EMERGENCY_STOP') return badge('EMERGENCY STOP', 'red');
  return badge(s, 'gray');
}

/** Trading-mode badge: LIVE is red (danger), PAPER green (safe). */
export function tradingModeBadge(mode: string | undefined | null): string {
  const m = (mode ?? 'UNKNOWN').toUpperCase();
  if (m === 'LIVE') return badge('LIVE', 'red');
  if (m === 'PAPER') return badge('PAPER', 'green');
  if (m === 'SIMULATOR') return badge('SIMULATOR', 'cyan');
  return badge(m, 'gray');
}

/** P&L coloring: green for gains, red for losses, gray for flat/missing. */
export function pnl(text: string, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return gray(text);
  if (value > 0) return green(text);
  if (value < 0) return red(text);
  return gray(text);
}

// ---------------------------------------------------------------------------
// Layout: headers, boxes, tables, bars
// ---------------------------------------------------------------------------

/** A section header with a colored rule, e.g. ── Positions ────────── */
export function sectionHeader(title: string, width = 60): string {
  const plain = `── ${title} ──`;
  if (!isPretty()) return plain;
  const lineLen = Math.max(0, width - visibleWidth(plain));
  return cyan(`── ${bold(title)} `) + dim('─'.repeat(lineLen));
}

/** Wrap lines in a rounded box. */
export function box(lines: string[], title?: string): string {
  const inner = lines.map((l) => `│ ${l}`);
  const width = Math.max(...inner.map(visibleWidth), title ? visibleWidth(title) + 4 : 0);
  const pad = (s: string) => s + ' '.repeat(Math.max(0, width - visibleWidth(s)));
  const top = title
    ? `╭─ ${bold(title)} ${'─'.repeat(Math.max(0, width - visibleWidth(title) - 3))}╮`
    : `╭${'─'.repeat(width)}╮`;
  const bottom = `╰${'─'.repeat(width)}╯`;
  const body = inner.map((l) => `${pad(l)}│`).join('\n');
  if (!isPretty()) {
    const plainTop = title ? `-- ${stripAnsi(title)} --` : '-'.repeat(width);
    return [plainTop, ...lines, '-'.repeat(width)].join('\n');
  }
  return [cyan(top), body, cyan(bottom)].join('\n');
}

/** Simple left-aligned table. rows[0] is the header. */
export function table(rows: string[][], opts?: { headerColor?: (t: string) => string }): string {
  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(...rows.map((r) => visibleWidth(r[c] ?? '')));
  }
  const colorHeader = opts?.headerColor ?? bold;
  return rows
    .map((row, i) => {
      const cells = row.map((cell, c) => {
        const padded = (cell ?? '') + ' '.repeat(Math.max(0, widths[c] - visibleWidth(cell ?? '')));
        return i === 0 ? colorHeader(padded) : padded;
      });
      return cells.join('  ');
    })
    .join('\n');
}

/** A horizontal progress/confidence bar, e.g. ████████░░░░ 65% */
export function bar(pct01: number, width = 20): string {
  const pct = Math.max(0, Math.min(1, pct01));
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const label = `${Math.round(pct * 100)}%`;
  if (!isPretty()) return `${'#'.repeat(filled)}${'-'.repeat(empty)} ${label}`;
  const fillColor = pct >= 0.75 ? green : pct >= 0.5 ? yellow : red;
  return fillColor('█'.repeat(filled)) + dim('░'.repeat(empty)) + ` ${label}`;
}

/** Key-value line with dimmed key and bright value. */
export function kv(key: string, value: string): string {
  return `${dim(key.padEnd(18))} ${value}`;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export function argusBanner(): string {
  const art = [
    '    ___    ____  ____ _   _ ____  ',
    '   / _ \\  |  _ \\/ ___| | | / ___| ',
    '  / /_\\ \\ | |_) \\___ \\ | | \\___ \\ ',
    ' /  _  \\ || _ < ___) | |_| |___) |',
    '/_/   \\_\\|_| \\_\\____/ \\___/|____/ ',
  ];
  if (!isPretty()) return 'ARGUS';
  return art.map((l) => brightCyan(l)).join('\n') + '\n' + dim('  many eyes, one disciplined decision process');
}
