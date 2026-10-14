/**
 * Test A / Test B launcher (2026-10-14). PURE LAUNCHER (see fullSession.ts). Usage:
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/endToEnd.ts --out=<dir> --test=A|B [--seed=102]
 */
import fs from 'node:fs';
import { buildTestASpec, buildTestBSpec } from './fullSessionPlan';
import { runSpecInChild, summarizeResult } from './sessionRunner';

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const out = arg('out') ?? '/tmp/e2e'; const test = (arg('test') ?? 'B').toUpperCase(); const seed = Number(arg('seed') ?? 102);
  fs.mkdirSync(out, { recursive: true });
  const spec = (test === 'A' ? buildTestASpec : buildTestBSpec)(`${out}/test${test}-seed${seed}.json`, seed);
  const r = await runSpecInChild(spec);
  const summary = { test, seed, ok: r.ok, error: r.error ?? null, ...(r.data ? summarizeResult(r.data) : {}), discovery: r.data?.discovery ? { score: r.data.discovery.score, promotedNew: r.data.discovery.promotedNew?.length, admitted: r.data.discovery.admittedToSession, blocked: r.data.discovery.blockedProviderCalls, reasons: r.data.discovery.notPromotedReasons } : null, lifecycleSeed: r.data?.lifecycleSeed ? r.data.lifecycleSeed.length : null };
  fs.writeFileSync(`${out}/test${test}-seed${seed}-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(r.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
