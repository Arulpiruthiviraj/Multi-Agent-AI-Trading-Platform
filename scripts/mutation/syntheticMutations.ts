/**
 * Synthetic-certification MUTATION runner (2026-10-14). Proves the certification can detect the Oct 14 defect classes: each mutation reintroduces one known
 * defect in an ISOLATED git worktree (never the working tree, never production), runs the targeted certification tests, and requires them to FAIL. A mutation
 * whose targeted tests stay green is a certification failure ("the lab missed a known defect"). Usage:
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/mutation/syntheticMutations.ts --out=<dir> [--only=M1,M2]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface Mutation { id: string; defect: string; file: string; find: string; replace: string; tests: string[] }

const MUTATIONS: Mutation[] = [
  { id: 'M1', defect: 'Routine rescue renewal extends eviction immunity again (Oct 14 rescue pinning)', file: 'src/server/services/MarketDataWorker.ts',
    find: "if (requestClass === 'ROUTINE_RECOVERY' && intent === 'RENEWAL' && !continuousIntelligence.temporaryDataRescueRoutineRenewalGrantsImmunity) {", replace: "if (false && requestClass === 'ROUTINE_RECOVERY' && intent === 'RENEWAL') {",
    tests: ['src/server/services/MarketDataWorker.test.ts'] },
  { id: 'M2', defect: 'Dwell protection released after 10 ticks again (CCI/CIEN premature eviction)', file: 'src/server/services/MarketDataWorker.ts',
    find: 'if (continuousIntelligence.minDynamicDwellReleasesOnTicks && ticks >= dwellTicks) return false;', replace: 'if (ticks >= dwellTicks) return false;',
    tests: ['src/server/services/MarketDataWorker.test.ts'] },
  { id: 'M3', defect: 'Held-position streams become eviction candidates', file: 'src/server/services/MarketDataWorker.ts',
    find: '      .filter((s) => !this.heldSymbols.has(s)) // 2026-10-14: a stream backing an open position is never an eviction candidate\n', replace: '',
    tests: ['src/server/services/MarketDataWorker.test.ts'] },
  { id: 'M4', defect: 'Operator report routes lose the heavy-report guard (diagnostic burst freeze)', file: 'src/server/routes/observabilityRoutes.ts',
    find: 'observabilityRouter.use([...OPERATOR_REPORT_PATHS], operatorReportGuard);', replace: '',
    tests: ['src/server/observability/operatorReportGuard.test.ts'] },
  { id: 'M5', defect: 'Score-edge non-promotions fall through to OTHER again (unexplained bucket)', file: 'src/server/continuous/SubscriptionPriorityExplainer.ts',
    find: "return 'SCORE_EDGE_NOT_MET';", replace: "return 'OTHER';",
    tests: ['src/server/continuous/SubscriptionPriorityExplainer.test.ts'] },
  { id: 'M6', defect: 'Agent calibration ignored: raw confidence used as decision confidence (the synthetic-vs-production mismatch)', file: 'src/server/services/ChiefTraderAgent.ts',
    find: "        historicalReliability: row.calibratedConfidence,\n        sampleSize,\n        dataQuality: sufficient ? 'SUFFICIENT_CALIBRATION_DATA' : 'INSUFFICIENT_CALIBRATION_DATA',\n        decisionConfidence: row.calibratedConfidence,",
    replace: "        historicalReliability: row.calibratedConfidence,\n        sampleSize,\n        dataQuality: sufficient ? 'SUFFICIENT_CALIBRATION_DATA' : 'INSUFFICIENT_CALIBRATION_DATA',\n        decisionConfidence: rawConfidence,",
    tests: ['src/server/services/ChiefTraderAgent.productionCalibration.test.ts'] },
  { id: 'M7', defect: 'Missing lifecycle record silently treated as a recorded state (no NO_LIFECYCLE_RECORD)', file: 'src/server/quant/QuantStrategyAuthorization.ts',
    find: 'if (!recordExists) {', replace: 'if (false && !recordExists) {',
    tests: ['src/server/quant/QuantLifecycleMatrix.test.ts', 'src/server/quant/QuantStrategyAuthorization.test.ts'] },
  { id: 'M8', defect: 'Abstention fixture accepts an approval (production-fidelity check removed)', file: 'src/server/replay/synthetic/CertificationGate.ts',
    find: '} else if (consensusApprovals > 0 || ordersSubmitted > 0) {', replace: '} else if (false) {',
    tests: ['src/server/replay/synthetic/CertificationGate.test.ts'] },
  { id: 'M9', defect: 'Synthetic session no longer verifies required production flags / credential absence', file: 'scripts/sim/sessionEnvGuard.ts',
    find: "if (!ok) problems.push(`required production-equivalent flag ${k} is not enabled`);", replace: '',
    tests: ['scripts/sim/sessionEnvGuard.test.ts'] },
  { id: 'M10', defect: 'Artifact cleanup stops protecting certification evidence', file: 'scripts/sim/artifactLifecycle.ts',
    find: 'return policy.protectedPrefixes.some((p) => name.startsWith(p));', replace: 'return false;',
    tests: ['scripts/sim/artifactLifecycle.test.ts'] },
  { id: 'M11', defect: 'Lifecycle authority granted to DEGRADED strategies (revocation ignored)', file: 'src/server/quant/QuantStrategyAuthorization.ts',
    find: "if (lifecycleStatus === 'DEGRADED') {", replace: "if (false && lifecycleStatus === 'DEGRADED') {",
    tests: ['src/server/quant/QuantLifecycleMatrix.test.ts', 'src/server/quant/QuantStrategyAuthorization.test.ts'] },
  { id: 'M12', defect: 'Exploration-health N+1 queries return (per-promotion synchronous query)', file: 'src/server/observability/rescueOutcomeReport.ts',
    find: 'for (let i = 0; i < symbols.length; i += CHUNK) {', replace: 'for (let i = 0; i < symbols.length; i += 1) {',
    tests: ['src/server/observability/rescueOutcomeReport.test.ts'] },
];

function sh(cmd: string, args: string[], cwd: string, timeoutMs = 600_000) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' && cmd === 'npx' }); }

const out = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=/tmp/mutation').slice(6);
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const repo = process.cwd();
fs.mkdirSync(out, { recursive: true });
const wt = path.join(path.dirname(repo), `argus-mutation-${Date.now()}`);
const head = sh('git', ['rev-parse', 'HEAD'], repo).stdout.trim();
let r = sh('git', ['worktree', 'add', '--detach', wt, head], repo);
if (r.status !== 0) { console.error('worktree add failed', r.stderr); process.exit(2); }
try {
  // dependencies are shared by junction/symlink; the isolated worktree never writes to node_modules
  try { fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'), 'junction'); } catch (e) { console.error('node_modules link failed', e); process.exit(2); }
  const results: Array<Record<string, unknown>> = [];
  for (const mu of MUTATIONS.filter((x) => only.length === 0 || only.includes(x.id))) {
    const file = path.join(wt, mu.file);
    const original = fs.readFileSync(file, 'utf8');
    const norm = original.replace(/\r\n/g, '\n');
    if (!norm.includes(mu.find.replace(/\r\n/g, '\n'))) { results.push({ id: mu.id, defect: mu.defect, verdict: 'MUTATION_NOT_APPLICABLE', note: 'target text not found - mutation list is stale' }); continue; }
    const crlf = original.includes('\r\n');
    const mutated = norm.replace(mu.find.replace(/\r\n/g, '\n'), mu.replace);
    fs.writeFileSync(file, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
    const t0 = Date.now();
    const run = sh(process.execPath, [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...mu.tests], wt, 900_000);
    const failedTests = (run.stdout ?? '').split('\n').filter((l) => /^\s*×|FAIL /.test(l)).slice(0, 6).map((l) => l.trim().slice(0, 160));
    const caught = run.status !== 0;
    results.push({ id: mu.id, defect: mu.defect, targetedTests: mu.tests, verdict: caught ? 'CAUGHT' : 'MISSED_BY_CERTIFICATION', exit: run.status, seconds: +((Date.now() - t0) / 1000).toFixed(1), failures: failedTests });
    fs.writeFileSync(file, original); // restore inside the throwaway worktree
    console.log(`${mu.id} ${caught ? 'CAUGHT' : 'MISSED'} (${mu.defect})`);
  }
  const clean = sh('git', ['status', '--porcelain'], wt).stdout.trim();
  const summary = { sha: head, generatedAt: new Date().toISOString(), restoredClean: clean === '', results, caught: results.filter((x) => x.verdict === 'CAUGHT').length, missed: results.filter((x) => x.verdict === 'MISSED_BY_CERTIFICATION').length, notApplicable: results.filter((x) => x.verdict === 'MUTATION_NOT_APPLICABLE').length };
  fs.writeFileSync(path.join(out, 'mutation-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ caught: summary.caught, missed: summary.missed, notApplicable: summary.notApplicable, restoredClean: summary.restoredClean }));
} finally {
  sh('git', ['worktree', 'remove', '--force', wt], repo);
}
