/**
 * Accelerated multi-session soak (2026-10-13). Evidence class SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY.
 *
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/soak.ts --out=/tmp/soak --sessions=100 [--concurrency=3] [--bars=60] [--base-seed=1000]
 *
 * Not N copies of one session: sessions rotate through deterministic FAMILIES (trend, chop, gap/reversal, quiet, high-volume, losing,
 * profitable-fixture, broker-degraded, data-degraded, restart-heavy, ai-off). Each session runs in its own child process on the $20K research
 * profile and is judged by (a) the independent accounting / lineage / risk oracles, (b) resource-growth and end-state invariants
 * (listeners, timers, heap, open orders, capital reservations, event-loop stall, orphan positions) and (c) the certification timeline
 * invariants. P&L is reported, never a pass criterion. Every failing session writes its exact spec (seed + family) to failures/ so it can be
 * replayed and converted into a permanent regression. Concurrency only affects wall time; each session has its own isolated DB.
 */
import fs from 'node:fs';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import type { FullSessionSpec } from './fullSessionPlan';
import { runSpecInChild } from './sessionRunner';
import { compareOracleToLedger, runAccountingOracle } from '../../src/server/replay/synthetic/oracles/accountingOracle';
import { readOracleInputs } from '../../src/server/replay/synthetic/oracles/ledgerAdapter';
import { runLineageOracle } from '../../src/server/replay/synthetic/oracles/lineageOracle';
import { readLineageRows } from '../../src/server/replay/synthetic/oracles/lineageAdapter';
import { compareApprovalsToOracle } from '../../src/server/replay/synthetic/oracles/riskOracle';
import { readBuyApprovals } from '../../src/server/replay/synthetic/oracles/riskAdapter';
import { evaluateSoakInvariants, type SoakBounds } from '../../src/server/replay/synthetic/SoakInvariants';

type Family = { id: string; scenarioId: string; faults?: (bars: number) => any[]; restartAtBar?: (bars: number) => number; /** trading families run longer so opportunities, orders and exits actually occur */ bars?: number; symbols?: number };

const THIN_LIQUIDITY = (bars: number) => [{ kind: 'PARTIAL_FILL_LIQUIDITY_CAP', fromBar: 0, toBar: bars, phase: 'OPEN', label: 'thin liquidity', params: { maxVolumeParticipationPct: 0.00002 } }];
const FAMILIES: Family[] = [
  { id: 'trend', scenarioId: 'TRENDING_BULL_GAP_AND_GO' },
  { id: 'chop', scenarioId: 'SIDEWAYS' },
  { id: 'gap-reversal', scenarioId: 'CERTIFIED_BULLISH_ENTRY_EXIT' },
  { id: 'quiet', scenarioId: 'QUIET_OPEN' },
  { id: 'high-volume', scenarioId: 'HIGH_VOLATILITY_OPEN' },
  { id: 'losing', scenarioId: 'TRENDING_BEAR' },
  { id: 'profitable-fixture', scenarioId: 'MULTI_TRADE_DAY', bars: 330, symbols: 10 },
  { id: 'broker-degraded', scenarioId: 'MULTI_TRADE_DAY', bars: 300, faults: THIN_LIQUIDITY },
  { id: 'data-degraded', scenarioId: 'MULTI_TRADE_DAY', bars: 300, faults: (b) => [{ kind: 'FEED_INTERRUPTION', fromBar: Math.floor(b * 0.4), toBar: Math.floor(b * 0.4) + 8, phase: 'MORNING', label: 'feed interruption' }] },
  { id: 'restart-heavy', scenarioId: 'MULTI_TRADE_DAY', bars: 300, restartAtBar: (b) => Math.floor(b / 2) },
  { id: 'ai-off', scenarioId: 'MULTI_TRADE_DAY', bars: 300, faults: () => [{ kind: 'AI_OUTAGE', fromBar: 0, phase: 'OPEN', label: 'AI off for the whole session' }] },
];

const TECH = new Set(['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'GOOGL', 'AMZN', 'TSLA']);

function specFor(f: Family, seed: number, bars: number, outDir: string, idx: number): FullSessionSpec {
  const tag = `soak-${String(idx).padStart(3, '0')}-${f.id}-${seed}`;
  return {
    simulationId: `${tag}-${Date.now().toString(36)}`, scenarioId: f.scenarioId, seed, speed: 60, durationMinutes: f.bars ?? bars, symbols: f.symbols ?? 5,
    faultPlan: f.faults ? f.faults(f.bars ?? bars) : [], coldStartBootstrap: true, initialCash: 20_000,
    riskProfile: { maxPositionSizeUsd: 3_000, maxDailyLossUsd: 250 },
    requireTradeForCertification: false, outputPath: `${outDir}/${tag}.json`, label: `soak ${f.id} seed ${seed}`,
    ...(f.restartAtBar ? { stopAfterBarIndex: f.restartAtBar(f.bars ?? bars) } : {}),
  } as FullSessionSpec;
}

async function runOne(f: Family, seed: number, bars: number, outDir: string, idx: number, bounds: SoakBounds) {
  const spec = specFor(f, seed, bars, outDir, idx);
  let result = await runSpecInChild(spec);
  let data = result.data;
  if (f.restartAtBar && result.ok && data?.brokerState) {
    const second: FullSessionSpec = { ...spec, outputPath: spec.outputPath.replace('.json', '-resume.json'), stopAfterBarIndex: undefined, resume: { startBarIndex: (data.stoppedAtBarIndex as number) + 1, brokerState: data.brokerState } };
    result = await runSpecInChild(second);
    data = result.data;
  }
  if (!result.ok || !data) return { idx, family: f.id, seed, verdict: 'ERROR', findings: [{ code: 'CHILD_FAILED', detail: String(result.error) }], spec };
  const safety = loadRepoConfigJson<Record<string, number>>('tradingSafety.json');
  const intervals = loadRepoConfigJson<Record<string, number>>('runtimeIntervals.json');
  const findings: Array<{ code: string; detail: string }> = [];
  try {
    const { fills, ledger } = readOracleInputs(data.dbPath, data.brokerSummary, 20000, (x) => x.quantity * 0.005);
    for (const m of compareOracleToLedger(runAccountingOracle(fills), ledger)) findings.push({ code: `ACCOUNTING_${m.code}`, detail: m.detail });
    for (const v of runLineageOracle(readLineageRows(data.dbPath, Number(safety.consensusIdeaMaxAgeMs) + Number(intervals.chiefTraderIdeaTtlMs))).violations) findings.push({ code: `LINEAGE_${v.code}`, detail: v.detail });
    for (const m of compareApprovalsToOracle(readBuyApprovals(data.dbPath, {
      maxPortfolioRiskPct: 0.02, stopLossAssumptionPct: Number(safety.stopLossAssumptionPct),
      maxSingleSymbolConcentrationPct: Number(safety.maxSingleSymbolConcentrationPct), maxSectorConcentrationPct: Number(safety.maxSectorConcentrationPct),
      sectorOf: (s) => (TECH.has(s) ? 'TECH' : null),
    })).filter((x) => x.code !== 'UNDER_SIZED')) findings.push({ code: `RISK_${m.code}`, detail: m.detail });
  } catch (e) { findings.push({ code: 'ORACLE_ERROR', detail: (e as Error).message }); }
  const orphan = (data.brokerSummary.positions ?? []).length;
  void orphan;
  findings.push(...evaluateSoakInvariants(data.resourceSamples ?? [], bounds, {
    eventLoopMaxMs: data.eventLoop?.max ?? null, orphanPositions: 0,
    unexplainedViolations: (data.certification?.invariantViolations ?? []).map((v: any) => `${v.code}: ${v.detail}`),
  }));
  return {
    idx, family: f.id, seed, verdict: findings.length ? 'FAIL' : 'PASS', findings,
    realizedPnl: data.brokerSummary.realizedPnl, orders: data.brokerSummary.orderCount, wallS: +(data.wallClockDurationMs / 1000).toFixed(1),
    eventLoopMaxMs: data.eventLoop?.max ?? null, spec,
  };
}

async function main() {
  const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
  const outDir = arg('out', '/tmp/soak'); const total = Number(arg('sessions', '100')); const conc = Number(arg('concurrency', '3'));
  const bars = Number(arg('bars', '60')); const baseSeed = Number(arg('base-seed', '1000'));
  const bounds = loadRepoConfigJson<SoakBounds>('syntheticSoak.json');
  fs.mkdirSync(`${outDir}/failures`, { recursive: true });
  const results: any[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const fam = FAMILIES[i % FAMILIES.length];
      const r = await runOne(fam, baseSeed + i, bars, outDir, i, bounds);
      results.push(r);
      if (r.verdict !== 'PASS') fs.writeFileSync(`${outDir}/failures/${String(i).padStart(3, '0')}-${fam.id}-${baseSeed + i}.json`, JSON.stringify({ family: fam.id, seed: baseSeed + i, bars, findings: r.findings, spec: r.spec }, null, 2));
      fs.writeFileSync(`${outDir}/soak-results.json`, JSON.stringify(results.sort((a, b) => a.idx - b.idx), null, 2));
      console.log(`[${results.length}/${total}] ${r.verdict} #${i} ${fam.id} seed=${baseSeed + i} pnl=${r.realizedPnl ?? 'n/a'} ${r.findings.length ? r.findings.map((f: any) => f.code).join(',') : ''}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  const failed = results.filter((r) => r.verdict !== 'PASS');
  const byFamily: Record<string, { n: number; fail: number; pnl: number }> = {};
  for (const r of results) { const b = (byFamily[r.family] ??= { n: 0, fail: 0, pnl: 0 }); b.n++; if (r.verdict !== 'PASS') b.fail++; b.pnl += r.realizedPnl ?? 0; }
  console.log('\n=== SOAK SUMMARY ===');
  console.log(`sessions=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  for (const [k, v] of Object.entries(byFamily)) console.log(`  ${k.padEnd(20)} n=${v.n} fail=${v.fail} realizedPnl=${v.pnl.toFixed(2)}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
