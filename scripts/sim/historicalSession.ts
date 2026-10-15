/**
 * Level-2 capability probe (2026-10-14): REAL historical 1Min bars + REAL prior 1Day history from a production snapshot, decided by the REAL production agents,
 * calibration, lifecycle, ChiefTrader, RiskEngine and OMS against a synthetic broker. PURE LAUNCHER (see fullSession.ts). Usage:
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/historicalSession.ts --snapshot=<db> --day=2026-10-14 --out=<dir> [--symbols=12]
 *        [--profile=PRODUCTION_OCT14|POSITIVE_CAPABILITY_BROAD] [--lifecycle=baseline|none] [--duration=390]
 * Evidence class HISTORICAL_REAL_BARS_SYNTHETIC_BROKER: never organic paper evidence, never alpha.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { FULL_SESSION_BARS, type FullSessionSpec } from './fullSessionPlan';
import { runSpecInChild, summarizeResult } from './sessionRunner';

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
async function main() {
  const snapshot = arg('snapshot')!; const day = arg('day', '2026-10-14')!; const out = arg('out', '/tmp/hist')!;
  const n = Number(arg('symbols', '12')); const profile = (arg('profile', 'PRODUCTION_OCT14') as FullSessionSpec['calibrationProfile']); const lifecycleMode = arg('lifecycle', 'baseline')!;
  if (!snapshot) throw new Error('--snapshot required');
  fs.mkdirSync(out, { recursive: true });
  const startMs = Date.parse(`${day}T13:30:00.000Z`); // 09:30 EDT (October is daylight time)
  const endMs = startMs + FULL_SESSION_BARS * 60_000;
  const db = new Database(snapshot, { readonly: true });
  const dayStartIso = new Date(startMs - 5 * 3600_000).toISOString(); const dayEndIso = new Date(endMs).toISOString();
  const active = db.prepare("select symbol, count(*) c from agent_predictions where timestamp>=? and timestamp<? and agent_name in ('TechnicalAgent','QuantEngine','KronosEngine') group by symbol order by c desc limit 80").all(dayStartIso, dayEndIso) as Array<{ symbol: string; c: number }>;
  const cnt = db.prepare("select count(*) c from ohlcv_bars where symbol=? and timeframe='1Min' and timestamp>=? and timestamp<?");
  const cntD = db.prepare("select count(*) c from ohlcv_bars where symbol=? and timeframe='1Day' and timestamp<?");
  const chosen: string[] = [];
  for (const a of active) { if (chosen.length >= n) break; if ((cnt.get(a.symbol, startMs, endMs) as any).c >= 330 && (cntD.get(a.symbol, startMs) as any).c >= 80) chosen.push(a.symbol); }
  db.close();
  console.log(`historical symbols (${chosen.length}): ${chosen.join(',')}`);
  const spec: FullSessionSpec = {
    simulationId: `hist-${day}-${profile}-${lifecycleMode}-${Date.now().toString(36)}`, scenarioId: 'QUIET_OPEN', seed: 7, speed: 30, durationMinutes: Number(arg('duration', String(FULL_SESSION_BARS))), symbols: chosen.length,
    faultPlan: [], historical: { snapshotDbPath: snapshot, symbols: chosen }, sessionStartMs: startMs, initialCash: 20_000, riskProfile: { maxPositionSizeUsd: 3_000, maxDailyLossUsd: 250 },
    calibrationProfile: profile,
    ...(lifecycleMode === 'baseline' ? { lifecycle: { baselineCoreUntested: true, records: [{ strategyId: 'PULLBACK_CONTINUATION', status: 'RETIRED', reason: 'production parity: retired strategy stays retired' }] } } : {}),
    requireTradeForCertification: null, outputPath: `${out}/hist-${day}-${profile}-${lifecycleMode}.json`,
    label: `HISTORICAL REAL BARS ${day} (${chosen.length} symbols), calibration=${profile}, lifecycle=${lifecycleMode} - decisions by the real production agents/consensus/risk`,
  };
  const r = await runSpecInChild(spec);
  const summary = { ok: r.ok, error: r.error ?? null, ...(r.data ? summarizeResult(r.data) : {}), symbols: chosen };
  fs.writeFileSync(`${out}/hist-${day}-${profile}-${lifecycleMode}-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(r.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
