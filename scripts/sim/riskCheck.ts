/** Usage: tsx scripts/sim/riskCheck.ts <session-result.json> [riskPct=0.02]
 *  Compares every approved BUY of a synthetic session against the independent risk oracle. Exit 1 on OVER_EXPOSURE / zero-room approvals.
 *  UNDER_SIZED findings are printed but informational (an unmodelled cap applied - must be explainable, not a safety breach). */
import { sectorOf } from './oraclePolicy';
import { readFileSync } from 'node:fs';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import { compareApprovalsToOracle } from '../../src/server/replay/synthetic/oracles/riskOracle';
import { readBuyApprovals } from '../../src/server/replay/synthetic/oracles/riskAdapter';

const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const riskPct = Number(process.argv[3] ?? '0.02'); // Medium risk level (portfolioRiskPctForLevel) - passed explicitly, not imported
const safety = loadRepoConfigJson<Record<string, number>>('tradingSafety.json');
// The oracle owns its own coarse sector table (independent of PositionSizing.SECTOR_MAP); only symbols used by the synthetic universe.
const approvals = readBuyApprovals(j.dbPath, {
  maxPortfolioRiskPct: riskPct,
  stopLossAssumptionPct: Number(safety.stopLossAssumptionPct),
  maxSingleSymbolConcentrationPct: Number(safety.maxSingleSymbolConcentrationPct),
  maxSectorConcentrationPct: Number(safety.maxSectorConcentrationPct),
  sectorOf,
});
const mismatches = compareApprovalsToOracle(approvals);
const hard = mismatches.filter((m) => m.code !== 'UNDER_SIZED');
console.log(JSON.stringify({ file: process.argv[2], approvedBuys: approvals.length, hardViolations: hard, informational: mismatches.filter((m) => m.code === 'UNDER_SIZED') }, null, 2));
process.exit(hard.length ? 1 : 0);
