/** Usage: tsx scripts/sim/exitCheck.ts <session-result.json> [graceMinutes=15]
 *  Independent protective-exit oracle over a session's simulated-time fills (timeline ORDER_FILLED) and persisted 1Min bars. Exit 1 on any violation. */
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runExitOracle, type OracleBar } from '../../src/server/replay/synthetic/oracles/exitOracle';

const [file, grace = '15'] = process.argv.slice(2);
const j = JSON.parse(readFileSync(file, 'utf8'));
const dbPath: string = existsSync(j.evidenceRetention?.path ?? '') ? j.evidenceRetention.path : j.dbPath;
const db = new Database(dbPath, { readonly: true });
const fills = (j.timeline as any[]).filter((e) => e.eventType === 'ORDER_FILLED' && e.symbol && e.summary?.price > 0 && e.summary?.quantity > 0)
  .map((e) => ({ atMs: e.simulatedTimeMs, symbol: e.symbol as string, side: e.side as 'BUY' | 'SELL', quantity: Number(e.summary.quantity), price: Number(e.summary.price) }));
const stopRow = db.prepare('select trailing_stop_pct as p from settings limit 1').get() as { p: number } | undefined;
const stopPct = stopRow?.p ?? 5;
const barsBySymbol = new Map<string, OracleBar[]>();
for (const s of new Set(fills.map((f) => f.symbol))) {
  barsBySymbol.set(s, (db.prepare("select timestamp as atMs, close from ohlcv_bars where symbol=? and timeframe='1Min' order by timestamp").all(s) as OracleBar[]));
}
const r = runExitOracle({ fills, barsBySymbol, stopPct, graceMs: Number(grace) * 60_000, sessionEndMs: j.sessionEndMs });
console.log(JSON.stringify({ file, stopPct, fills: fills.length, ...r }, null, 2));
process.exit(r.violations.length ? 1 : 0);
