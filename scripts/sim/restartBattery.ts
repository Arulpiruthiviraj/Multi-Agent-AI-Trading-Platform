/**
 * Restart battery (2026-10-13). Places a deterministic process restart at an EVENT-defined point of an organic synthetic session, resumes in a
 * fresh process on the same persisted DB + exported broker state, and then applies the independent oracles to the final state.
 *
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/restartBattery.ts --out=/tmp/rb [--seed=11] [--cases=FIRST_BUY_SUBMITTED,...]
 *
 * Invariant for every case (restart may DELAY action but never create duplicate exposure or lose broker truth):
 *   accounting oracle: positions / avg cost / P&L / cash / fees of broker and ledger equal the oracle recomputed from raw fills
 *   lineage oracle:    every idea has an explicit fate; BUY has an approved risk assessment; position conserved
 *   risk oracle:       every approved BUY is within the independently computed maximum
 * A case whose restart condition was never reached is INCONCLUSIVE (reported, never counted as PASS): the point of the case is the state at
 * the restart, so a session that never got there proves nothing about it. Labeled SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY.
 */
import { sectorOf } from './oraclePolicy';
import fs from 'node:fs';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import { buildMultiTradeDaySpec, type FullSessionSpec } from './fullSessionPlan';
import { runSpecInChild } from './sessionRunner';
import { compareOracleToLedger, runAccountingOracle } from '../../src/server/replay/synthetic/oracles/accountingOracle';
import { readOracleInputs } from '../../src/server/replay/synthetic/oracles/ledgerAdapter';
import { runLineageOracle } from '../../src/server/replay/synthetic/oracles/lineageOracle';
import { readLineageRows } from '../../src/server/replay/synthetic/oracles/lineageAdapter';
import { compareApprovalsToOracle } from '../../src/server/replay/synthetic/oracles/riskOracle';
import { readBuyApprovals } from '../../src/server/replay/synthetic/oracles/riskAdapter';
import type { RestartCondition } from '../../src/server/replay/synthetic/SyntheticSessionEngine';

interface CaseDef { id: RestartCondition; extraBars: number; thinLiquidity?: boolean; note: string }

const CASES: CaseDef[] = [
  { id: 'FIRST_BUY_SUBMITTED', extraBars: 0, note: 'restart immediately after the first BUY order exists' },
  { id: 'FIRST_BUY_FILLED', extraBars: 0, note: 'restart immediately after the first BUY filled' },
  { id: 'HOLDING_ONE_POSITION', extraBars: 8, note: 'restart while holding one position' },
  { id: 'HOLDING_TWO_POSITIONS', extraBars: 4, note: 'restart while holding two positions' },
  { id: 'SELL_SUBMITTED', extraBars: 0, note: 'restart right after the first protective/exit SELL exists' },
  { id: 'PARTIAL_FILL_RECORDED', extraBars: 0, thinLiquidity: true, note: 'restart during a partial fill (thin liquidity)' },
  { id: 'WORKING_ORDER_OPEN', extraBars: 0, thinLiquidity: true, note: 'restart with an order still working at the broker (thin liquidity)' },
];


async function runCase(c: CaseDef, seed: number, outDir: string, symbols: number) {
  const tag = `${c.id.toLowerCase()}-${seed}`;
  const first = buildMultiTradeDaySpec(`${outDir}/${tag}-half1.json`, seed, symbols);
  first.simulationId = `restart-battery-${tag}-${Date.now().toString(36)}`;
  first.requireTradeForCertification = null;
  first.label = `restart battery ${c.id}: first half`;
  if (c.thinLiquidity) {
    first.faultPlan = [{ kind: 'PARTIAL_FILL_LIQUIDITY_CAP', fromBar: 0, toBar: 389, phase: 'OPEN', label: 'thin liquidity (battery)', params: { maxVolumeParticipationPct: 0.00002 } } as any];
  }
  first.stopWhen = { condition: c.id, extraBars: c.extraBars };
  const r1 = await runSpecInChild(first);
  if (!r1.ok || !r1.data) return { id: c.id, verdict: 'ERROR', detail: `first half failed: ${r1.error}` };
  if (!r1.data.brokerState || r1.data.stoppedAtBarIndex == null) {
    return { id: c.id, verdict: 'INCONCLUSIVE', detail: `restart condition ${c.id} was never reached in this session (no stop); nothing about the restart state was exercised` };
  }
  const stopBar = r1.data.stoppedAtBarIndex as number;
  const second: FullSessionSpec = { ...first, label: `restart battery ${c.id}: resume half`, outputPath: `${outDir}/${tag}-half2.json`, stopAfterBarIndex: undefined, resume: { startBarIndex: stopBar + 1, brokerState: r1.data.brokerState } };
  delete second.stopWhen;
  const r2 = await runSpecInChild(second);
  if (!r2.ok || !r2.data) return { id: c.id, verdict: 'ERROR', detail: `resume half failed: ${r2.error}` };

  const feePerShare = 0.005;
  const { fills, ledger } = readOracleInputs(r2.data.dbPath, r2.data.brokerSummary, 20000, (f) => f.quantity * feePerShare);
  const accounting = compareOracleToLedger(runAccountingOracle(fills), ledger);
  const safety = loadRepoConfigJson<Record<string, number>>('tradingSafety.json');
  const intervals = loadRepoConfigJson<Record<string, number>>('runtimeIntervals.json');
  const lineage = runLineageOracle(readLineageRows(r2.data.dbPath, Number(safety.consensusIdeaMaxAgeMs) + Number(intervals.chiefTraderIdeaTtlMs))).violations;
  const risk = compareApprovalsToOracle(readBuyApprovals(r2.data.dbPath, {
    maxPortfolioRiskPct: 0.02, stopLossAssumptionPct: Number(safety.stopLossAssumptionPct),
    maxSingleSymbolConcentrationPct: Number(safety.maxSingleSymbolConcentrationPct), maxSectorConcentrationPct: Number(safety.maxSectorConcentrationPct),
    sectorOf,
  })).filter((m) => m.code !== 'UNDER_SIZED');
  const half1Orders = r1.data.brokerSummary?.orderCount ?? 0;
  const failures = [...accounting.map((m) => `ACCOUNTING ${m.code}: ${m.detail}`), ...lineage.map((m) => `LINEAGE ${m.code}: ${m.detail}`), ...risk.map((m) => `RISK ${m.code}: ${m.detail}`)];
  // the state at the restart must have been the one the case names (otherwise the restart proved something weaker)
  const heldAtRestart = (r1.data.brokerState.positions ?? []).filter((p: any) => Math.abs(p.quantity) > 0).length;
  return {
    id: c.id, verdict: failures.length ? 'FAIL' : 'PASS', note: c.note, stopBar,
    stateAtRestart: { brokerOrders: half1Orders, heldPositions: heldAtRestart, workingOrders: (r1.data.brokerState.workingOrders ?? []).length },
    ordersAfterResume: r2.data.brokerSummary?.orderCount ?? null, realizedPnl: r2.data.brokerSummary?.realizedPnl ?? null,
    failures,
  };
}

async function main() {
  const outDir = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=/tmp/restart-battery').slice(6);
  const seed = Number((process.argv.find((a) => a.startsWith('--seed=')) ?? '--seed=11').slice(7));
  const symbols = Number((process.argv.find((a) => a.startsWith('--symbols=')) ?? '--symbols=5').slice(10));
  const only = (process.argv.find((a) => a.startsWith('--cases=')) ?? '').slice(8).split(',').filter(Boolean);
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const c of CASES) {
    if (only.length && !only.includes(c.id)) continue;
    console.log(`\n##### restart case ${c.id} (seed ${seed})`);
    results.push(await runCase(c, seed, outDir, symbols));
    fs.writeFileSync(`${outDir}/restart-battery.json`, JSON.stringify(results, null, 2));
  }
  console.log('\n=== restart battery ===');
  for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.id}  ${(r as any).detail ?? ''}${(r as any).failures?.length ? ' :: ' + (r as any).failures.join(' | ') : ''}`);
  process.exit(results.some((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR') ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
