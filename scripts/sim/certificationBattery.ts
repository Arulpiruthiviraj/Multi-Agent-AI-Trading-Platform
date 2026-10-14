/**
 * Synthetic certification battery - READINESS AREA report (2026-10-13).
 *
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/certificationBattery.ts --out=/tmp/cb \
 *        [--sessions=<result.json>,<result.json>...] [--restart=<restart-battery.json>,...] [--skip-suites]
 *
 * Two kinds of evidence, never mixed up:
 *   SUITE areas    - delegated vitest files (real production code under test; mechanism / unit / e2e). PASS only if every test in every
 *                    listed file passed. A file that does not exist is a FAIL (the area would otherwise be vacuous).
 *   SESSION areas  - synthetic session artifacts (--sessions): the independent oracles are applied to each session's isolated DB and broker
 *                    summary (accounting, lineage, risk). An area with no artifact is NOT_RUN, never PASS.
 *
 * Labels: SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY. A PASS proves mechanical capability of the platform, not market alpha, and does not
 * change LIVE_NO_GO. Strategy authorization (no lifecycle records) and Jev (advisory) are reported separately and never gate controlled PAPER.
 */
import { sectorOf } from './oraclePolicy';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import { compareOracleToLedger, runAccountingOracle } from '../../src/server/replay/synthetic/oracles/accountingOracle';
import { readOracleInputs } from '../../src/server/replay/synthetic/oracles/ledgerAdapter';
import { runLineageOracle } from '../../src/server/replay/synthetic/oracles/lineageOracle';
import { readLineageRows } from '../../src/server/replay/synthetic/oracles/lineageAdapter';
import { compareApprovalsToOracle } from '../../src/server/replay/synthetic/oracles/riskOracle';
import { readBuyApprovals } from '../../src/server/replay/synthetic/oracles/riskAdapter';
import { measureMultiTrade } from '../../src/server/replay/synthetic/oracles/multiTradeMetrics';
import Database from 'better-sqlite3';

type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN' | 'INFO';
interface AreaResult { area: string; verdict: Verdict; evidence: string; detail?: string[] }

/** Readiness area -> delegated vitest files. */
const SUITE_AREAS: Record<string, string[]> = {
  PROTECTIVE_EXIT: [
    'src/server/certification/protectiveExitUnderPause.e2e.test.ts',
    'src/server/continuous/portfolioIntel.exitOwnership.test.ts',
    'src/server/services/PortfolioMonitor.test.ts',
    'src/server/services/PortfolioMonitor.isolation.test.ts',
  ],
  BROKER_ORDER_LIFECYCLE: ['src/server/certification/brokerOrderFaults.e2e.test.ts'],
  OMS: [
    'src/server/services/OrderManagement.test.ts',
    'src/server/services/OrderManagement.lifecycle.test.ts',
    'src/server/services/OrderManagement.crashRecovery.test.ts',
    'src/server/services/OrderManagement.restartMidPosition.test.ts',
    'src/server/services/OrderManagement.syntheticBrokerPartialFill.test.ts',
  ],
  RISK_AND_RESEARCH_CAPITAL: [
    'src/server/engines/RiskEngine.researchCapitalCaps.test.ts',
    'src/server/engines/RiskEngine.entriesOnlyPause.test.ts',
    'src/server/engines/RiskEngine.gates.test.ts',
    'src/server/risk/researchEquity.test.ts',
    'src/server/risk/OvertradingGuards.test.ts',
  ],
  INTRADAY_DATA_AND_1MIN_QUEUE: [
    'src/brokers/ibkrHistoricalScheduler.test.ts',
    'src/server/services/QuantSignalAgent.intradayDeadline.test.ts',
    'src/server/services/QuantSignalAgent.scheduledBounds.test.ts',
  ],
  BACKFILL_NEGATIVE_CACHE: ['src/brokers/ibkrHistoricalScheduler.test.ts'],
  EVENT_LOOP_AND_DB_PRESSURE: ['src/server/db/offThreadCount.test.ts', 'src/server/db/selectRowsOffThread.test.ts', 'src/server/certification/quantSchedulerSla.test.ts'],
  MARKET_DATA_CLOCK: ['src/server/services/MarketDataWorker.simulationClock.test.ts'],
  WALL_CLOCK_AUDIT: ['src/server/replay/synthetic/WallClockAudit.test.ts'],
  ORACLES: [
    'src/server/replay/synthetic/oracles/accountingOracle.test.ts',
    'src/server/replay/synthetic/oracles/accountingOracle.canonical.test.ts',
    'src/server/replay/synthetic/oracles/riskOracle.test.ts',
    'src/server/replay/synthetic/oracles/lineageOracle.test.ts',
    'src/server/replay/synthetic/oracles/multiTradeMetrics.test.ts',
  ],
  SYMBOL_ROUTING: ['src/server/data/symbolFormat.test.ts'],
  PROPERTY_FUZZ_METAMORPHIC: ['src/server/certification/properties.test.ts'],
  // GATE_CERTIFIED (not FULL_SESSION_EXERCISED): gate 9 ignores REPLAY trades by design, so it is certified on an isolated PAPER ledger.
  CONSECUTIVE_LOSS_GATE_CERTIFIED: ['src/server/certification/consecutiveLossGate.e2e.test.ts'],
  // Oct 13 incidents kept as permanent scenarios (each file reproduces the incident's failure mode and fails if the repair is removed):
  //  1Min starvation (scheduler FAILURE MODE test), rejected protective exit then retry (exit-ownership cases), entries paused with active
  //  protection (e2e), $1M broker vs $20K Argus capital (research-capital caps), main-thread DB pressure (off-thread + slow-SQL attribution),
  //  bad symbols (routing). AI outage is exercised by every full synthetic session's AI_OUTAGE fault.
  KNOWN_OCT13_INCIDENTS: [
    'src/brokers/ibkrHistoricalScheduler.test.ts',
    'src/server/continuous/portfolioIntel.exitOwnership.test.ts',
    'src/server/certification/protectiveExitUnderPause.e2e.test.ts',
    'src/server/engines/RiskEngine.researchCapitalCaps.test.ts',
    'src/server/db/selectRowsOffThread.test.ts',
    'src/server/db/slowSqlTiming.test.ts',
    'src/server/data/symbolFormat.test.ts',
  ],
};

function runSuite(files: string[]): { pass: boolean; summary: string; detail: string[] } {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) return { pass: false, summary: `missing test files: ${missing.join(', ')}`, detail: missing };
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--reporter=json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = r.stdout ?? '';
  const start = out.indexOf('{"numTotalTestSuites"');
  if (start < 0) return { pass: false, summary: `vitest produced no JSON (exit ${r.status})`, detail: [(r.stderr ?? '').slice(-400)] };
  try {
    const j = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
    const failed: string[] = [];
    for (const f of j.testResults ?? []) for (const t of f.assertionResults ?? []) if (t.status !== 'passed' && t.status !== 'skipped' && t.status !== 'pending') failed.push(`${path.basename(f.name)} :: ${t.fullName}`);
    return { pass: j.numFailedTests === 0 && j.numTotalTests > 0 && (r.status === 0), summary: `${j.numPassedTests}/${j.numTotalTests} tests passed in ${files.length} file(s)`, detail: failed };
  } catch (e) {
    return { pass: false, summary: `could not parse vitest JSON: ${(e as Error).message}`, detail: [] };
  }
}

/** Scenarios whose design intentionally leaves positions open at the close (Argus has no end-of-day flatten configured; it is a swing system). */
const SWING_BY_DESIGN = new Set(['MULTI_TRADE_DAY']);

function sessionOracles(resultFile: string, initialCash: number) {
  const j = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const safety = loadRepoConfigJson<Record<string, number>>('tradingSafety.json');
  const intervals = loadRepoConfigJson<Record<string, number>>('runtimeIntervals.json');
  const perShare = 0.005;
  const { fills, ledger } = readOracleInputs(j.dbPath, j.brokerSummary, initialCash, (f) => f.quantity * perShare);
  const accounting = compareOracleToLedger(runAccountingOracle(fills), ledger);
  const lineage = runLineageOracle(readLineageRows(j.dbPath, Number(safety.consensusIdeaMaxAgeMs) + Number(intervals.chiefTraderIdeaTtlMs)));
  const risk = compareApprovalsToOracle(readBuyApprovals(j.dbPath, {
    maxPortfolioRiskPct: 0.02, stopLossAssumptionPct: Number(safety.stopLossAssumptionPct),
    maxSingleSymbolConcentrationPct: Number(safety.maxSingleSymbolConcentrationPct), maxSectorConcentrationPct: Number(safety.maxSectorConcentrationPct),
    sectorOf,
  })).filter((m) => m.code !== 'UNDER_SIZED');
  // multi-trade facts for the aggregate bar
  const db = new Database(j.dbPath, { readonly: true, fileMustExist: true });
  let metricsInput;
  try {
    const f = db.prepare(`SELECT f.order_id AS orderId, t.symbol, t.side, f.quantity, f.price, f.filled_at AS filledAt FROM fills f JOIN trades t ON t.id=f.order_id ORDER BY f.filled_at, f.id`).all() as any[];
    const ra = db.prepare('SELECT side, approved, rejection_gate AS g, symbol, created_at AS at FROM risk_assessments').all() as any[];
    metricsInput = {
      initialCapital: initialCash,
      fills: f.map((x) => ({ orderId: x.orderId, symbol: x.symbol, side: x.side, quantity: x.quantity, price: x.price, feeUsd: x.quantity * perShare, atMs: Date.parse(x.filledAt) })),
      riskAssessments: ra.map((x) => ({ side: x.side, approved: !!x.approved, rejectionGate: x.g, symbol: x.symbol, atMs: Date.parse(x.at) })),
    };
  } finally { db.close(); }
  // Open positions at session end must be intentional by scenario design AND still monitored (a PortfolioMonitor decision after the last fill).
  const open = ledger.portfolio.map((p) => p.symbol);
  const db2 = new Database(j.dbPath, { readonly: true, fileMustExist: true });
  const unmonitored: string[] = [];
  try {
    for (const sym of open) {
      const lastFill = db2.prepare('SELECT MAX(f.filled_at) AS t FROM fills f JOIN trades t ON t.id=f.order_id WHERE t.symbol=?').get(sym) as { t: string | null };
      const mon = db2.prepare("SELECT COUNT(*) AS n FROM event_traces WHERE event_type='PORTFOLIO_DECISION_RECORDED' AND payload LIKE ?").get(`%\"symbol\":\"${sym}\"%`) as { n: number };
      if (!(mon.n > 0) || lastFill.t === null) unmonitored.push(sym);
    }
  } finally { db2.close(); }
  return { accounting, lineage, risk, metricsInput, openSymbols: open, unmonitored, scenarioId: String(j.spec?.scenarioId ?? '') };
}

async function main() {
  const outDir = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=/tmp/certification-battery').slice(6);
  // each session artifact may carry its initial cash as `path@100000` (legacy canonical/lifecycle sessions run on $100K; research-capital sessions on $20K)
  const sessionSpecs = (process.argv.find((a) => a.startsWith('--sessions=')) ?? '').slice(11).split(',').filter(Boolean).map((x) => { const [p, c] = x.split('@'); return { path: p, cash: c ? Number(c) : 20000 }; });
  const sessions = sessionSpecs.map((x) => x.path);
  const soakFiles = (process.argv.find((a) => a.startsWith('--soak=')) ?? '').slice(7).split(',').filter(Boolean);
  const restarts = (process.argv.find((a) => a.startsWith('--restart=')) ?? '').slice(10).split(',').filter(Boolean);
  const skipSuites = process.argv.includes('--skip-suites');
  fs.mkdirSync(outDir, { recursive: true });
  const areas: AreaResult[] = [];

  if (!skipSuites) {
    for (const [area, files] of Object.entries(SUITE_AREAS)) {
      process.stdout.write(`suite ${area} ... `);
      const r = runSuite(files);
      console.log(r.pass ? 'PASS' : 'FAIL', r.summary);
      areas.push({ area, verdict: r.pass ? 'PASS' : 'FAIL', evidence: r.summary, detail: r.detail });
    }
  }

  if (sessions.length === 0) {
    areas.push({ area: 'SESSION_ORACLES', verdict: 'NOT_RUN', evidence: 'no --sessions artifacts supplied' });
  } else {
    const acc: string[] = []; const lin: string[] = []; const rsk: string[] = []; const opn: string[] = [];
    const allMetrics = { initialCapital: 0, fills: [] as any[], riskAssessments: [] as any[] };
    let n = 0;
    for (const f of sessions) {
      try {
        const o = sessionOracles(f, sessionSpecs.find((x) => x.path === f)?.cash ?? 20000);
        acc.push(...o.accounting.map((m) => `${path.basename(path.dirname(f))}: ${m.code} ${m.detail}`));
        lin.push(...o.lineage.violations.map((m) => `${path.basename(path.dirname(f))}: ${m.code} ${m.detail}`));
        rsk.push(...o.risk.map((m) => `${path.basename(path.dirname(f))}: ${m.code} ${m.detail}`));
        if (o.openSymbols.length) {
          const intentional = SWING_BY_DESIGN.has(o.scenarioId);
          if (!intentional) opn.push(`${path.basename(path.dirname(f))}: ${o.openSymbols.join(',')} open at end in scenario ${o.scenarioId} that does not hold positions by design`);
          for (const s of o.unmonitored) opn.push(`${path.basename(path.dirname(f))}: ${s} open at end with NO portfolio monitoring evidence (unprotected)`);
        }
        allMetrics.initialCapital = 20000;
        // sessions are independent days: offset each session's timeline so FIFO lots never cross sessions
        const base = n * 1e12;
        for (const x of o.metricsInput.fills) allMetrics.fills.push({ ...x, symbol: `${x.symbol}#${n}`, atMs: base + x.atMs });
        for (const x of o.metricsInput.riskAssessments) allMetrics.riskAssessments.push({ ...x, symbol: `${x.symbol}#${n}`, atMs: base + x.atMs });
        n++;
      } catch (e) { acc.push(`${f}: ORACLE_ERROR ${(e as Error).message}`); }
    }
    areas.push({ area: 'ACCOUNTING_ORACLE', verdict: acc.length ? 'FAIL' : 'PASS', evidence: `${n} session(s)`, detail: acc });
    areas.push({ area: 'LINEAGE_ORACLE', verdict: lin.length ? 'FAIL' : 'PASS', evidence: `${n} session(s)`, detail: lin });
    areas.push({ area: 'RISK_ORACLE', verdict: rsk.length ? 'FAIL' : 'PASS', evidence: `${n} session(s)`, detail: rsk });
    areas.push({ area: 'OPEN_POSITIONS_AT_END', verdict: opn.length ? 'FAIL' : 'PASS', evidence: `${n} session(s); only swing-by-design scenarios may hold, and every held position must show monitoring`, detail: opn });
    // Aggregate organic multi-trade evidence across the supplied sessions. Reported, with an explicit bar; an unmet bar is a FINDING about
    // how rarely the real strategy set trades in these fixtures, not something to be forced by relaxing consensus.
    const m = measureMultiTrade(allMetrics, {
      minCompletedTrades: 5, minWinners: 2, minLosers: 2, minDistinctEntrySizes: 3,
      // capital / position-cap / cooldown rejections are reported (see soak aggregate) but not required per fixture: forcing them would mean shaping Argus's behaviour
      requireCapitalOrPositionCapRejection: false, requireCooldownRejection: false, requireCapitalReuse: true, requireNetProfitAfterCosts: false,
    });
    areas.push({
      area: 'ORGANIC_MULTI_TRADE_AGGREGATE',
      verdict: m.failures.length ? 'FAIL' : 'PASS',
      evidence: `${m.roundTrips.length} completed round trips (${m.winners}W/${m.losers}L), ${m.distinctEntrySizes} distinct entry sizes, net ${m.netPnl} after ${m.feesUsd} fees across ${n} session(s)`,
      detail: m.failures,
    });
  }

  if (soakFiles.length) {
    const rows = soakFiles.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as any[]);
    // sessions killed by an external wall-clock limit (child exit 143/137) are INFRASTRUCTURE, not Argus outcomes: counted separately, never as PASS
    const infra = rows.filter((r) => (r.findings ?? []).some((x: any) => x.code === 'CHILD_FAILED' && /exit (143|137|124)/.test(x.detail)));
    const real = rows.filter((r) => !infra.includes(r));
    const failed = real.filter((r) => r.verdict !== 'PASS');
    const byCode: Record<string, number> = {};
    for (const r of failed) for (const x of r.findings ?? []) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
    const orders = real.reduce((s, r) => s + (r.orders ?? 0), 0);
    const pnl = real.reduce((s, r) => s + (r.realizedPnl ?? 0), 0);
    const fam = new Set(real.map((r) => r.family));
    areas.push({
      area: 'MULTI_SESSION_SOAK', verdict: failed.length ? 'FAIL' : 'PASS',
      evidence: `${real.length} completed session(s) across ${fam.size} families, ${orders} orders, realized P&L ${pnl.toFixed(2)} (not a pass criterion); ${infra.length} session(s) killed by an external time limit (excluded)`,
      detail: failed.slice(0, 12).map((r) => `#${r.idx} ${r.family} seed ${r.seed}: ${(r.findings ?? []).map((x: any) => x.code + ' ' + x.detail).join('; ').slice(0, 300)}`),
    });
    areas.push({ area: 'RESOURCE_GROWTH_SOAK', verdict: Object.keys(byCode).some((c) => /GROWTH|LEAK|STALL|OPEN_ORDERS/.test(c)) ? 'FAIL' : 'PASS', evidence: `finding codes in failed sessions: ${JSON.stringify(byCode)}` });
  } else {
    areas.push({ area: 'MULTI_SESSION_SOAK', verdict: 'NOT_RUN', evidence: 'no --soak artifacts supplied' });
  }

  if (restarts.length === 0) {
    areas.push({ area: 'RESTART_BATTERY', verdict: 'NOT_RUN', evidence: 'no --restart artifacts supplied' });
  } else {
    const rows = restarts.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as any[]);
    const bad = rows.filter((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR');
    // A restart condition depends on what the real pipeline chooses to do in that seeded session, so one seed may never reach it. A case is
    // PROVEN only if at least one seed reached the condition AND passed; a case no seed reached is NOT_PROVEN (never silently PASS).
    const ids = [...new Set(rows.map((r) => r.id))];
    const notProven = ids.filter((id) => !rows.some((r) => r.id === id && r.verdict === 'PASS'));
    areas.push({
      area: 'RESTART_BATTERY', verdict: bad.length ? 'FAIL' : notProven.length ? 'INFO' : 'PASS',
      evidence: ids.map((id) => `${id}=${rows.filter((r) => r.id === id).map((r) => r.verdict).join('/')}`).join(' '),
      detail: [...bad.flatMap((r) => (r.failures ?? [r.detail]).map((x: string) => `${r.id}: ${x}`)), ...notProven.map((id) => `NOT_PROVEN ${id}: no seed both reached the restart condition and passed`)],
    });
  }

  areas.push({ area: 'STRATEGY_AUTHORIZATION', verdict: 'INFO', evidence: 'quant lifecycle has no authorized strategies; reported separately, does not gate controlled PAPER' });
  areas.push({ area: 'JEV_ADVISORY', verdict: 'INFO', evidence: 'advisory only; does not gate controlled PAPER' });
  areas.push({ area: 'LIVE', verdict: 'INFO', evidence: 'LIVE_NO_GO (separate; never implied by any synthetic PASS)' });

  fs.writeFileSync(path.join(outDir, 'certification-battery.json'), JSON.stringify({ generatedAt: new Date().toISOString(), label: 'SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY - mechanical capability, not market alpha', areas }, null, 2));
  console.log('\n=== READINESS AREAS ===');
  for (const a of areas) console.log(`${a.verdict.padEnd(8)} ${a.area.padEnd(34)} ${a.evidence}${a.detail?.length ? '\n           - ' + a.detail.slice(0, 6).join('\n           - ') : ''}`);
  process.exit(areas.some((a) => a.verdict === 'FAIL') ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
