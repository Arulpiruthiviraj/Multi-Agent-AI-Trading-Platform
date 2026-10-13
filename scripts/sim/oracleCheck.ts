/** Usage: tsx scripts/sim/oracleCheck.ts <session-result.json> [initialCash=100000] [feePerShare=0.005]
 *  Applies the independent accounting oracle to a synthetic session's isolated DB and broker summary. Exit 1 on any mismatch. */
import { readFileSync } from 'node:fs';
import { compareOracleToLedger, runAccountingOracle } from '../../src/server/replay/synthetic/oracles/accountingOracle';
import { readOracleInputs } from '../../src/server/replay/synthetic/oracles/ledgerAdapter';

const [file, cash = '100000', fee = '0.005'] = process.argv.slice(2);
const j = JSON.parse(readFileSync(file, 'utf8'));
const perShare = Number(fee);
const { fills, ledger } = readOracleInputs(j.dbPath, j.brokerSummary, Number(cash), (f) => f.quantity * perShare);
const oracle = runAccountingOracle(fills);
const mismatches = compareOracleToLedger(oracle, ledger);
console.log(JSON.stringify({ file, fills: fills.length, grossRealizedPnl: oracle.grossRealizedPnl, feesTotal: oracle.feesTotal, netRealizedPnl: oracle.netRealizedPnl, openPositions: oracle.positions, mismatches }, null, 2));
process.exit(mismatches.length ? 1 : 0);
