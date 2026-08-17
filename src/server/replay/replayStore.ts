/**
 * Durable replay artifacts under data/replays (or ARGUS_REPLAY_DIR). Not SQLite bars.
 */
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplayEvent } from './ReplayContext';

export function replayRootDir(): string {
  if (process.env.ARGUS_REPLAY_DIR) return process.env.ARGUS_REPLAY_DIR;
  return join(process.cwd(), 'data', 'replays');
}

// Real replay IDs are always crypto.randomUUID() (FullArgusReplayEngine.ts). Validating the
// format here - the one chokepoint every function in this file joins a replayId into a
// filesystem path through - closes a real path-traversal bug: replayDir() used to join
// req.params.id straight into a path with zero sanitization, so an id like "../../../etc" could
// list or read files outside data/replays entirely via the export routes.
const REPLAY_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidReplayId(replayId: string): boolean {
  return typeof replayId === 'string' && REPLAY_ID_PATTERN.test(replayId);
}

export function replayDir(replayId: string): string {
  if (!isValidReplayId(replayId)) {
    throw new Error(`Invalid replayId (must be a UUID): ${JSON.stringify(replayId)}`);
  }
  return join(replayRootDir(), replayId);
}

export function ensureReplayDir(replayId: string): string {
  const dir = replayDir(replayId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendReplayEvent(replayId: string, event: ReplayEvent): void {
  const dir = ensureReplayDir(replayId);
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

export function writeReplayJson(replayId: string, name: string, value: unknown): void {
  const dir = ensureReplayDir(replayId);
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

export function readReplayJson<T>(replayId: string, name: string): T | null {
  const p = join(replayDir(replayId), name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function listReplayPackages(): string[] {
  const root = replayRootDir();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => existsSync(join(root, n, 'summary.json')));
}

export function exportReplayManifest(replayId: string): Record<string, string> {
  const dir = replayDir(replayId);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return { replayId, dir, files: files.join(',') };
}

export function readReplayArtifact(replayId: string, name: string): { content: string; contentType: string } | null {
  const p = join(replayDir(replayId), name);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf8');
  if (name.endsWith('.jsonl')) return { content, contentType: 'application/x-ndjson' };
  if (name.endsWith('.csv')) return { content, contentType: 'text/csv' };
  return { content, contentType: 'application/json' };
}

/** Build a trades CSV from trades.json (or empty). */
export function exportTradesCsv(replayId: string): string {
  const trades = readReplayJson<Array<Record<string, unknown>>>(replayId, 'trades.json') || [];
  const header = 'timestamp,symbol,side,quantity,price,strategyId,traceId,realizedPnl,executionModel,executionEnvironment';
  const rows = trades.map((t) =>
    [t.timestamp, t.symbol, t.side, t.quantity, t.price, t.strategyId, t.traceId, t.realizedPnl ?? '', t.executionModel, t.executionEnvironment].join(',')
  );
  return [header, ...rows].join('\n');
}

export function exportEquityCsv(replayId: string): string {
  const equity = readReplayJson<Array<{ t: number; equity: number; cash: number; drawdownPct: number }>>(replayId, 'equity_curve.json') || [];
  const header = 't,equity,cash,drawdownPct';
  const rows = equity.map((e) => [e.t, e.equity, e.cash, e.drawdownPct].join(','));
  return [header, ...rows].join('\n');
}
