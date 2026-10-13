/** Usage: tsx scripts/sim/lineageCheck.ts <session-result.json> - applies the lineage oracle to a synthetic session's isolated DB. Exit 1 on violations. */
import { readFileSync } from 'node:fs';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import { runLineageOracle } from '../../src/server/replay/synthetic/oracles/lineageOracle';
import { readLineageRows } from '../../src/server/replay/synthetic/oracles/lineageAdapter';

const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// longest an idea may wait for the consensus sweep: its freshness window plus one sweep period (both from reviewed config)
const safety = loadRepoConfigJson<Record<string, number>>('tradingSafety.json');
const intervals = loadRepoConfigJson<Record<string, number>>('runtimeIntervals.json');
const r = runLineageOracle(readLineageRows(j.dbPath, Number(safety.consensusIdeaMaxAgeMs) + Number(intervals.chiefTraderIdeaTtlMs)));
console.log(JSON.stringify({ file: process.argv[2], fates: r.fates, violations: r.violations.slice(0, 20), violationCount: r.violations.length }, null, 2));
process.exit(r.violations.length ? 1 : 0);
