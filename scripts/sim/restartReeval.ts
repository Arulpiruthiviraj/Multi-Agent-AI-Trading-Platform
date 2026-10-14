/** Usage: tsx scripts/sim/restartReeval.ts <dir-with-half2.json>...  Re-applies the three independent oracles to already-produced restart-battery
 *  artifacts (no simulation is rerun). Used when an ORACLE/harness defect (never an Argus defect) was corrected after the sessions ran. */
import fs from 'node:fs';
import path from 'node:path';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import { compareOracleToLedger, runAccountingOracle } from '../../src/server/replay/synthetic/oracles/accountingOracle';
import { readOracleInputs } from '../../src/server/replay/synthetic/oracles/ledgerAdapter';
import { runLineageOracle } from '../../src/server/replay/synthetic/oracles/lineageOracle';
import { readLineageRows } from '../../src/server/replay/synthetic/oracles/lineageAdapter';
import { compareApprovalsToOracle } from '../../src/server/replay/synthetic/oracles/riskOracle';
import { readBuyApprovals } from '../../src/server/replay/synthetic/oracles/riskAdapter';
import { sectorOf } from './oraclePolicy';

const safety = loadRepoConfigJson<Record<string, number>>('tradingSafety.json');
const intervals = loadRepoConfigJson<Record<string, number>>('runtimeIntervals.json');
let bad = 0;
for (const dir of process.argv.slice(2)) {
  const half2 = fs.readdirSync(dir).find((f) => f.endsWith('half2.json'));
  const bat = path.join(dir, 'restart-battery.json');
  const prior = fs.existsSync(bat) ? (JSON.parse(fs.readFileSync(bat, 'utf8'))[0] ?? {}) : {};
  if (!half2) { console.log(`${path.basename(dir)}: ${prior.verdict ?? 'NO_HALF2'} (${(prior.detail ?? '').slice(0, 80)})`); if (prior.verdict !== 'INCONCLUSIVE') bad++; continue; }
  const j = JSON.parse(fs.readFileSync(path.join(dir, half2), 'utf8'));
  const { fills, ledger } = readOracleInputs(j.dbPath, j.brokerSummary, 20000, (f) => f.quantity * 0.005);
  const acc = compareOracleToLedger(runAccountingOracle(fills), ledger).map((m) => `ACCOUNTING ${m.code}`);
  const lin = runLineageOracle(readLineageRows(j.dbPath, Number(safety.consensusIdeaMaxAgeMs) + Number(intervals.chiefTraderIdeaTtlMs))).violations.map((v) => `LINEAGE ${v.code}: ${v.detail}`);
  const rsk = compareApprovalsToOracle(readBuyApprovals(j.dbPath, {
    maxPortfolioRiskPct: 0.02, stopLossAssumptionPct: Number(safety.stopLossAssumptionPct),
    maxSingleSymbolConcentrationPct: Number(safety.maxSingleSymbolConcentrationPct), maxSectorConcentrationPct: Number(safety.maxSectorConcentrationPct), sectorOf,
  })).filter((m) => m.code !== 'UNDER_SIZED').map((m) => `RISK ${m.code}`);
  const all = [...acc, ...lin, ...rsk];
  console.log(`${path.basename(dir)}: ${all.length ? 'FAIL ' + all.join(' | ').slice(0, 400) : 'PASS'}`);
  if (all.length) bad++;
}
process.exit(bad ? 1 : 0);
