/**
 * Ring buffer for server console output + live WebSocket streaming via EventBus wildcard.
 */
import { eventBus } from '../core/EventBus';
import { eventName } from '../core/eventNames';

export type LogLevel = 'log' | 'warn' | 'error';
export type LogSource = 'console' | 'remote-op';
export type LogCategory = 'SYSTEM' | 'TRADING' | 'ERROR' | 'SCRIPT';

export interface ServerLogLine {
  id: string;
  ts: string;
  level: LogLevel;
  text: string;
  source: LogSource;
  category: LogCategory;
  jobId?: string;
  stream?: 'stdout' | 'stderr';
}

const MAX_LINES = 500;
const TRADING_PATTERN = /\b(TRADE|ORDER|RISK|BROKER|CHIEF|OMS|FILL|POSITION|AUTOBOT|QUANT|RECONCIL)/i;

let seq = 0;
const buffer: ServerLogLine[] = [];
let installed = false;

const originals = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function nextId(): string {
  seq += 1;
  return `log-${Date.now()}-${seq}`;
}

function classifyConsoleLine(text: string, level: LogLevel): LogCategory {
  if (level === 'error') return 'ERROR';
  if (TRADING_PATTERN.test(text)) return 'TRADING';
  return 'SYSTEM';
}

/** Skip dev-only noise; compact RSS / stack traces for mobile terminal readability. */
function normalizeConsoleText(text: string): string | null {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (/\[vite\]/i.test(plain) || /\[BABEL\]/i.test(plain) || /hmr update/i.test(plain)) {
    return null;
  }
  const trimmed = plain.trim();
  if (!trimmed.includes('\n')) return trimmed;
  const firstLine = trimmed.split('\n').map((l) => l.trim()).find(Boolean) ?? trimmed;
  if (/^\s*at\s/m.test(trimmed)) return `${firstLine} (stack truncated)`;
  return firstLine;
}

function pushLine(line: ServerLogLine): void {
  buffer.push(line);
  while (buffer.length > MAX_LINES) buffer.shift();
  eventBus.emit(eventName('SERVER_LOG'), line);
}

export function appendServerLogLine(partial: Omit<ServerLogLine, 'id' | 'ts'> & { ts?: string }): ServerLogLine {
  const line: ServerLogLine = {
    id: nextId(),
    ts: partial.ts ?? new Date().toISOString(),
    level: partial.level,
    text: partial.text,
    source: partial.source,
    category: partial.category,
    jobId: partial.jobId,
    stream: partial.stream,
  };
  pushLine(line);
  return line;
}

export function appendRemoteOpOutput(jobId: string, stream: 'stdout' | 'stderr', text: string): void {
  const level: LogLevel = stream === 'stderr' ? 'error' : 'log';
  appendServerLogLine({
    level,
    text,
    source: 'remote-op',
    category: 'SCRIPT',
    jobId,
    stream,
  });
  eventBus.emit(eventName('REMOTE_OP_OUTPUT'), { jobId, stream, line: text, ts: new Date().toISOString() });
}

export function getRecentLogLines(limit = 100): ServerLogLine[] {
  const n = Math.max(1, Math.min(limit, MAX_LINES));
  return buffer.slice(-n);
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function wrapConsole(level: LogLevel, original: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    original(...args);
    const raw = formatConsoleArgs(args);
    const text = normalizeConsoleText(raw);
    if (text == null) return;
    appendServerLogLine({
      level,
      text,
      source: 'console',
      category: classifyConsoleLine(text, level),
    });
  };
}

export function installServerLogBuffer(): void {
  if (installed) return;
  installed = true;
  console.log = wrapConsole('log', originals.log);
  console.warn = wrapConsole('warn', originals.warn);
  console.error = wrapConsole('error', originals.error);
}

export function resetServerLogBufferForTests(): void {
  buffer.length = 0;
  seq = 0;
  installed = false;
  console.log = originals.log;
  console.warn = originals.warn;
  console.error = originals.error;
}
