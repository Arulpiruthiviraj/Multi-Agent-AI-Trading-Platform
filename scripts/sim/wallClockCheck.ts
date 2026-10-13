/** Usage: tsx scripts/sim/wallClockCheck.ts <session-result.json> - evaluates the wall-clock callers recorded by an audited session
 *  (ARGUS_SYNTH_WALLCLOCK_AUDIT=1) against config/syntheticWallClockAudit.json. Exit 1 if any decision-module caller is unclassified. */
import { readFileSync } from 'node:fs';
import { loadRepoConfigJson } from '../../src/server/config/loadRepoConfigJson';
import { evaluateWallClockAudit, type WallClockClassification } from '../../src/server/replay/synthetic/WallClockAudit';

const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(j.wallClockCallers)) { console.error('session result has no wallClockCallers - run with ARGUS_SYNTH_WALLCLOCK_AUDIT=1'); process.exit(2); }
const cfg = loadRepoConfigJson<{ decisionFilePattern: string; classifications: WallClockClassification[] }>('syntheticWallClockAudit.json');
const r = evaluateWallClockAudit(j.wallClockCallers, new RegExp(cfg.decisionFilePattern), cfg.classifications);
const byClass: Record<string, number> = {};
for (const e of r.explained) byClass[e.classification] = (byClass[e.classification] ?? 0) + e.calls;
console.log(JSON.stringify({ file: process.argv[2], explainedCallsByClass: byClass, unexplained: r.unexplained, ignoredCalls: r.ignored }, null, 2));
process.exit(r.unexplained.length ? 1 : 0);
