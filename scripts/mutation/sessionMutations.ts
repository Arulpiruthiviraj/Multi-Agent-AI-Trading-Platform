/**
 * FULL-SESSION mutation runner (2026-10-14). Where scripts/mutation/syntheticMutations.ts proves the unit-level regression tests detect known defects,
 * this proves the FULL-SESSION certification (real discovery -> consensus -> risk -> OMS -> broker, then the independent oracles) turns RED when a serious
 * defect is injected into production code. Each mutation is applied in an isolated git worktree; the unmutated control must be GREEN first.
 *
 * Verdict per variant (computed with the UNMUTATED oracles from the main checkout): RED if ANY of: end-to-end verdict not PASS, accounting/risk oracle
 * mismatch, a lineage violation other than the known IDEA_UNTERMINATED observability finding, an exit-oracle violation, or a simulated-time-integrity failure.
 * A mutation that stays GREEN is reported MISSED_BY_CERTIFICATION - a certification gap, not hidden.
 *
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/mutation/sessionMutations.ts --out=<dir> [--only=SM1,SM2]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface SessionMutation { id: string; defect: string; file: string; find: string; replace: string; all?: boolean }
const MUTATIONS: SessionMutation[] = [
  { id: 'SM1', defect: 'Commission omitted from broker costs', file: 'src/brokers/HistoricalReplayBroker.ts',
    find: 'const commission = this.costs.commissionPerShare * qty;', replace: 'const commission = 0;' },
  { id: 'SM2', defect: 'Broker reports a doubled fill quantity (duplicate/over fill)', file: 'src/brokers/HistoricalReplayBroker.ts',
    find: '      filledQuantity: qty,\n      averageFillPrice: priced.fill,', replace: '      filledQuantity: qty * 2,\n      averageFillPrice: priced.fill,' },
  { id: 'SM3', defect: 'Research capital wrong: replay allocation budget inflated 5x', file: 'src/server/replay/synthetic/SyntheticSessionEngine.ts',
    find: '{ allocationBudget: options.initialCash, initialCapital: options.initialCash, buyingPower: options.initialCash }', replace: '{ allocationBudget: options.initialCash * 5, initialCapital: options.initialCash * 5, buyingPower: options.initialCash * 5 }' },
  { id: 'SM4', defect: 'Protective hard stop / trailing stop exits never fire', file: 'src/server/services/PortfolioMonitor.ts',
    find: 'PnL < -trailingStopPct)', replace: 'false && PnL < -trailingStopPct)', all: true },
  { id: 'SM5', defect: 'Wall-clock contamination: Date.now is no longer bound to the simulated clock', file: 'src/server/replay/synthetic/SyntheticSessionEngine.ts',
    find: 'Date.now = () => clockRef.now();', replace: 'void clockRef;' },
];

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = 3_600_000) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: env ?? process.env, maxBuffer: 256 * 1024 * 1024 }); }
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const out = arg('out') ?? '/tmp/session-mutation';
const only = (arg('only') ?? '').split(',').filter(Boolean);
const repo = process.cwd();
const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
fs.mkdirSync(out, { recursive: true });

function evaluate(resultJson: string): { red: boolean; reasons: string[]; detail: Record<string, unknown> } {
  const reasons: string[] = []; const detail: Record<string, unknown> = {};
  if (!fs.existsSync(resultJson)) return { red: true, reasons: ['SESSION_DID_NOT_PRODUCE_A_RESULT'], detail };
  const parse = (s: string) => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return null; } };
  const v = run(process.execPath, ['--use-system-ca', tsx, 'scripts/sim/endToEndVerdict.ts', resultJson, 'B', '20000'], repo);
  const vj = parse(v.stdout ?? '');
  if (!vj) reasons.push('ORACLE_CRASH:endToEndVerdict (no parsable output; not a clean assertion)');
  detail.verdict = vj?.areas?.map((a: any) => `${a.verdict} ${a.area}`) ?? null;
  for (const a of vj?.areas ?? []) if (a.verdict !== 'PASS') reasons.push(`${a.area}:${a.verdict}`);
  const risk = parse(run(process.execPath, ['--use-system-ca', tsx, 'scripts/sim/riskCheck.ts', resultJson], repo).stdout ?? '');
  if (!risk) reasons.push('ORACLE_CRASH:riskCheck');
  if ((risk?.hardViolations ?? []).length) reasons.push(`RISK_ORACLE:${risk.hardViolations.length}`);
  const lin = parse(run(process.execPath, ['--use-system-ca', tsx, 'scripts/sim/lineageCheck.ts', resultJson], repo).stdout ?? '');
  if (!lin) reasons.push('ORACLE_CRASH:lineageCheck');
  const linBad = (lin?.violations ?? []).filter((x: any) => x.code !== 'IDEA_UNTERMINATED');
  if (linBad.length) reasons.push(`LINEAGE:${[...new Set(linBad.map((x: any) => x.code))].join(',')}`);
  const ex = parse(run(process.execPath, ['--use-system-ca', tsx, 'scripts/sim/exitCheck.ts', resultJson], repo).stdout ?? '');
  if (!ex) reasons.push('ORACLE_CRASH:exitCheck');
  if ((ex?.violations ?? []).length) reasons.push(`EXIT_ORACLE:${ex.violations.length}`);
  return { red: reasons.length > 0, reasons, detail };
}

function runSession(cwd: string, tag: string): string {
  const dir = path.join(out, tag); fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ARGUS_SYNTH_MIN_FREE_DISK_GB: process.env.ARGUS_SYNTH_MIN_FREE_DISK_GB ?? '' } as NodeJS.ProcessEnv;
  if (!env.ARGUS_SYNTH_MIN_FREE_DISK_GB) delete env.ARGUS_SYNTH_MIN_FREE_DISK_GB;
  const r = run(process.execPath, ['--use-system-ca', path.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/sim/endToEnd.ts', `--out=${dir}`, '--test=B', '--seed=102', '--incumbents=10', '--hardcap=13', '--renewals=5'], cwd, env);
  fs.writeFileSync(path.join(dir, 'session.log'), (r.stdout ?? '').split('\n').filter((l) => !l.includes('"logger"')).slice(-200).join('\n') + '\n' + (r.stderr ?? '').slice(-4000));
  return path.join(dir, 'testB-seed102.json');
}

const head = run('git', ['rev-parse', 'HEAD'], repo).stdout.trim();
const wt = path.join(path.dirname(repo), `argus-sessmut-${Date.now()}`);
if (run('git', ['worktree', 'add', '--detach', wt, head], repo).status !== 0) { console.error('worktree add failed'); process.exit(2); }
const results: Array<Record<string, unknown>> = [];
try {
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'), 'junction');
  fs.copyFileSync(path.join(repo, '.env'), path.join(wt, '.env')); // gitignored; the session guard requires the sanitized production-equivalent flags
  // CONTROL
  const ctrlResult = runSession(wt, 'control');
  const control = evaluate(ctrlResult);
  fs.writeFileSync(path.join(out, 'control.json'), JSON.stringify(control, null, 2));
  console.log(`CONTROL ${control.red ? 'RED' : 'GREEN'} ${control.reasons.join(' ')}`);
  if (control.red) throw new Error('unmutated control is not green; session mutation results would be meaningless');
  for (const mu of MUTATIONS.filter((m) => only.length === 0 || only.includes(m.id))) {
    const file = path.join(wt, mu.file);
    const original = fs.readFileSync(file, 'utf8');
    const norm = original.replace(/\r\n/g, '\n');
    if (!norm.includes(mu.find)) { results.push({ id: mu.id, defect: mu.defect, verdict: 'MUTATION_NOT_APPLICABLE' }); continue; }
    const crlf = original.includes('\r\n');
    const mutated = mu.all ? norm.split(mu.find).join(mu.replace) : norm.replace(mu.find, mu.replace);
    fs.writeFileSync(file, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
    const t0 = Date.now();
    const resultJson = runSession(wt, mu.id);
    const ev = evaluate(resultJson);
    fs.writeFileSync(file, original);
    results.push({ id: mu.id, defect: mu.defect, verdict: ev.red ? 'CAUGHT' : 'MISSED_BY_CERTIFICATION', reasons: ev.reasons, minutes: +((Date.now() - t0) / 60000).toFixed(1) });
    console.log(`${mu.id} ${ev.red ? 'CAUGHT' : 'MISSED'} [${ev.reasons.join(' ')}] (${mu.defect})`);
  }
  const clean = run('git', ['status', '--porcelain', '--untracked-files=no'], wt).stdout.trim();
  fs.writeFileSync(path.join(out, 'session-mutation-results.json'), JSON.stringify({ sha: head, generatedAt: new Date().toISOString(), control: { red: control.red, reasons: control.reasons }, restoredClean: clean === '', results }, null, 2));
  console.log(JSON.stringify({ caught: results.filter((r) => r.verdict === 'CAUGHT').length, missed: results.filter((r) => r.verdict === 'MISSED_BY_CERTIFICATION').length, notApplicable: results.filter((r) => r.verdict === 'MUTATION_NOT_APPLICABLE').length, restoredClean: clean === '' }));
} finally {
  try { fs.rmdirSync(path.join(wt, 'node_modules')); } catch { /* link already gone */ }
  run('git', ['worktree', 'remove', '--force', wt], repo);
}
