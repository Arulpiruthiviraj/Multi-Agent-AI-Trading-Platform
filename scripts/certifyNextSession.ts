/**
 * certify-next-session (isolated child).
 *
 * Runs the full pre-market release-gate certification against an ISOLATED copy of the
 * production database. The parent process (argus-cli `certify-next-session`) creates the
 * copy with VACUUM INTO from the live DB; this child never touches the live DB.
 *
 * Safety:
 * - Read-only with respect to production. Never seeds lifecycle rows, never promotes
 *   strategies, never manufactures VALIDATED/CHAMPION authority.
 * - The MANDATORY invariant holds: AUTHORIZED_PAPER_QUANT_STRATEGIES = 0 =>
 *   QUANT_FIRST_OPERATIONALLY_INACTIVE => overallStatus NO_GO, even with
 *   quantPolicyEnabled = true. Missing lifecycle FAILS certification; it is never
 *   worked around.
 * - PAPER ONLY. This script never places orders, never arms LIVE.
 *
 * Usage (child form):
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/certifyNextSession.ts \
 *     --isolated-db=/tmp/argus-cert-XXXX/snapshot.db [--json]
 *
 * Output: JSON report on stdout with OVERALL_STATUS in {READY, READY_WITH_CONDITIONS, NO_GO}.
 * Exit code: 0 = READY, 2 = READY_WITH_CONDITIONS, 3 = NO_GO, 1 = internal error.
 * (A NO_GO is a certification RESULT, not a bug: the child must not fail loudly in a way
 * that hides the verdict.)
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AvailableData } from '../src/server/certification/strategyDataContracts';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

async function main() {
  const asJson = process.argv.includes('--json');
  const dbArg = process.argv.find(a => a.startsWith('--isolated-db='));
  if (!dbArg) {
    console.error('certifyNextSession: --isolated-db=<path> is required (the parent creates it).');
    process.exit(1);
  }
  const isolatedDbPath = path.resolve(dbArg.slice('--isolated-db='.length));
  if (!fs.existsSync(isolatedDbPath)) {
    console.error(`certifyNextSession: isolated DB not found: ${isolatedDbPath}`);
    process.exit(1);
  }

  // Point every subsequent import at the isolated copy. Set before importing ../src/server/db.
  process.env.ARGUS_DB_PATH = isolatedDbPath;
  process.env.SYNTHETIC_SIMULATION = 'false';
  process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
  // This certification is a paper-only diagnostic: assert the paper lock in the child
  // environment (the child places no orders; the flag makes the invariant explicit).
  process.env.PAPER_TRADING_ONLY = 'true';
  if (asJson) {
    // db/index.ts prints migration progress to stdout on import; keep --json pure.
    // Fatal errors still go to the real stderr via process.stderr.write directly.
    (globalThis as any).__certStderr = process.stderr.write.bind(process.stderr);
    console.log = () => {};
    console.error = () => {};
  }

  const report: any = {
    certification: 'CERTIFY_NEXT_SESSION',
    generatedAt: new Date().toISOString(),
    paperOnlyEnforced: true,
    isolatedDbPath,
  };

  let dbHandle: any = null;
  const closeDb = () => { try { dbHandle?.close(); } catch { /* best effort */ } dbHandle = null; };

  try {
    // --- Build / config / schema identity -------------------------------------
    try {
      report.buildSha = execSync('git rev-parse HEAD', { cwd: path.resolve('.'), encoding: 'utf8' }).trim();
    } catch {
      report.buildSha = 'UNKNOWN (git unavailable)';
    }
    const safetyCfgPath = path.resolve('config/tradingSafety.json');
    const safetyCfgRaw = fs.readFileSync(safetyCfgPath, 'utf8');
    const safetyCfg = JSON.parse(safetyCfgRaw);
    report.configHash = sha256Hex(safetyCfgRaw);

    // --- Layer 3: production-state certification (canonical authorization) ----
    const { certifyProductionState } = await import('../src/server/certification/productionStateCertification');
    const productionState = await certifyProductionState();
    report.productionState = productionState;
    report.lifecycleSummary = {
      totalStrategies: productionState.TOTAL_STRATEGIES,
      enabledQuantStrategies: productionState.ENABLED_QUANT_STRATEGIES,
      lifecycleRows: productionState.LIFECYCLE_ROWS,
      missingLifecycleRows: productionState.MISSING_LIFECYCLE_ROWS,
      byState: productionState.lifecycleStateCounts,
      authorizedPaperQuantStrategies: productionState.AUTHORIZED_PAPER_QUANT_STRATEGIES,
      quantPolicyEnabled: productionState.quantPolicyEnabled,
      verdict: productionState.verdict,
    };

    // --- Data readiness: probe the isolated DB for real available data --------
    const { sqliteDb } = await import('../src/server/db');
    dbHandle = sqliteDb;
    const { available, probeDetails } = probeAvailableData(sqliteDb);
    report.dataReadiness = {
      available,
      probeDetails,
      probeNotes: 'UNVERIFIED dimensions were not observable from the DB snapshot and are treated as unavailable (fail-closed).',
    };
    const { evaluateDataReadiness } = await import('../src/server/certification/strategyDataContracts');
    const readiness = evaluateDataReadiness(available);
    // Keep readiness scoped to strategies that could actually trade: authorized or
    // consensus-eligible. A NOT_READY strategy with no authority is informational only.
    const authorizedIds = new Set(
      (productionState.details ?? []).filter((d: any) => d.authorized).map((d: any) => d.strategyId),
    );
    report.dataReadiness.perStrategy = readiness.map(r => ({
      ...r,
      hasQuantAuthority: authorizedIds.has(r.strategyId),
    }));
    report.dataReadiness.notReadyAuthorized = readiness.filter(
      r => r.readiness === 'NOT_READY' && authorizedIds.has(r.strategyId),
    ).map(r => ({ strategyId: r.strategyId, missingRequired: r.missingRequired }));

    try {
      report.schemaVersion = sqliteDb.prepare('PRAGMA user_version').get() as any;
    } catch {
      report.schemaVersion = 'UNKNOWN';
    }

    // --- Strategy registry hash (detects registry drift between builds) -------
    const { STRATEGY_DATA_CONTRACTS } = await import('../src/server/certification/strategyDataContracts');
    const registryFingerprint = Object.keys(STRATEGY_DATA_CONTRACTS)
      .sort()
      .map(id => {
        const c: any = STRATEGY_DATA_CONTRACTS[id];
        return `${id}:${Object.keys(c.inputs ?? {}).sort().map(k => `${k}=${c.inputs[k]}`).join(',')}`;
      })
      .join('|');
    report.strategyRegistryHash = sha256Hex(registryFingerprint);
    report.strategyRegistrySize = Object.keys(STRATEGY_DATA_CONTRACTS).length;

    // --- Quant scheduler SLA configuration ------------------------------------
    report.quantSchedulerSla = {
      quantCycleIntervalMs: safetyCfg.quantCycleIntervalMs ?? null,
      quantMaxConcurrentSymbols: safetyCfg.quantMaxConcurrentSymbols ?? null,
      note: 'Runtime SLA (cycle completion, per-symbol completeness, late-admission bound) is certified by src/server/certification/quantSchedulerSla.test.ts against the real scheduler with fault injection.',
    };

    // --- Stale cache status: probe the isolated DB's bar tails -------------------
    // The Oct-9 forensic found 508/972 late bar-input records with a newest bar >7d
    // old. The gateway's stale-tail gate (f9277c7) now refuses to treat such caches
    // as sufficient; this probe reports the production snapshot's tail health so a
    // stale production cache is visible BEFORE open instead of discovered live.
    try {
      const tailTolMs = safetyCfg.quantBarsTailFreshnessToleranceMs ?? 259200000;
      const tailRows = sqliteDb.prepare(`
        SELECT symbol, MAX(timestamp) AS newestTs, COUNT(*) AS n
        FROM ohlcv_bars WHERE timeframe = '1Day' GROUP BY symbol
      `).all() as Array<{ symbol: string; newestTs: number; n: number }>;
      const nowMs = Date.now();
      let fresh = 0, stale = 0;
      const staleSymbols: string[] = [];
      for (const r of tailRows) {
        if (r.newestTs >= nowMs - tailTolMs) fresh += 1;
        else { stale += 1; if (staleSymbols.length < 20) staleSymbols.push(r.symbol); }
      }
      report.staleCacheStatus = {
        symbolsWithDailyBars: tailRows.length,
        freshTail: fresh,
        staleTail: stale,
        staleTailSample: staleSymbols,
        toleranceMs: tailTolMs,
        note: 'A stale tail no longer suppresses provider refresh (gateway stale-tail gate); this is visibility, not a block by itself.',
      };
    } catch {
      report.staleCacheStatus = { error: 'probe failed' };
    }

    // --- PIT replay provenance: is decision_provenance populated? ---------------
    // The replay-equality itself is suite-owned (PIT replay suite: production calc ==
    // independent replay calc, no-lookahead enforced). The CLI honestly reports
    // whether the isolated snapshot carries replayable provenance rows.
    try {
      const provCount = (sqliteDb.prepare('SELECT COUNT(*) AS n FROM decision_provenance').get() as any)?.n ?? 0;
      const provLatest = sqliteDb.prepare('SELECT MAX(decision_time_ms) AS m FROM decision_provenance').get() as any;
      report.pitReplay = {
        provenanceRows: provCount,
        latestProvenanceTime: provLatest?.m ?? null,
        replayEquality: 'suite-owned: PIT replay suite (production calc == independent replay calc; no-lookahead enforced)',
        note: provCount > 0
          ? 'decision_provenance rows present in snapshot; replayability certified by the PIT suite, not this probe.'
          : 'no decision_provenance rows in snapshot: exact point-in-time replay of recent decisions is not possible from this snapshot.',
      };
    } catch {
      report.pitReplay = { error: 'decision_provenance not observable (table missing or probe failed)' };
    }

    // --- Suites that certify areas this CLI cannot measure directly -----------
    // These are HONEST pointers: the CLI names the exact test file that owns each
    // area, rather than pretending a static probe certifies runtime behavior.
    report.delegatedToSuite = {
      aiIndependence: 'src/server/replay/synthetic/SynthesisDefectSweep.test.ts (ALL_AI_DOWN: authorized quant completes the full spine with every AI provider dead)',
      riskSpine: 'src/server/certification/productionStateMechanismE2E.test.ts (authorization -> policy -> Chief -> RiskAgent -> RiskEngine -> sizing -> OMS)',
      reconciliationFixtures: 'src/server/services/ReconciliationService.test.ts + OCT-1 regression (POSITION_FILL_CONFLICT)',
      backup: 'src/server/services/DbBackupService.worker.test.ts',
      watchdog: 'watchdog chaos tests (slowness -> no restart; death -> one restart; storm -> bounded lockout)',
      memory: 'memory growth-slope tests (post-warmup slope, not fixed MB)',
      queues: 'QUEUE BACKPRESSURE suite (known capacity + rejection behavior)',
      premarket: 'premarket wiring tests (TRADE_PLAN create/refresh/promote/downgrade/expire, PREMARKET_REFRESH_COMPLETED)',
      pitReplay: 'PIT replay suite (production calc == independent replay calc; no-lookahead enforced)',
      lateAdmissionTest: 'src/server/scheduling/quantSchedulerForensicRegressions.test.ts (MRNA-style: high-priority mover admitted mid-cycle resolves in seconds; CRCL-style: explicit terminal; COMBINED: late admission + stale cache + slow provider + fast lane)',
      fastLaneLeaseTest: 'src/server/fastlane/fastLaneEvaluator.test.ts (lease held until settle; caller timeout never releases capacity; bounded hung-work quarantine)',
      quantSchedulerSla: 'src/server/scheduling/quantPriorityScheduler.test.ts (HIGH start<=30s/complete<=60s p95; NORMAL start<=60s/complete<=120s p95; per-symbol completeness invariant)',
    };

    // --- Overall verdict -------------------------------------------------------
    const conditions: string[] = [];
    let overall: 'READY' | 'READY_WITH_CONDITIONS' | 'NO_GO' = 'READY';

    if (productionState.verdict !== 'QUANT_FIRST_OPERATIONAL') {
      overall = 'NO_GO';
      conditions.push(`QUANT_FIRST_OPERATIONALLY_INACTIVE: ${productionState.AUTHORIZED_PAPER_QUANT_STRATEGIES} authorized paper quant strategies (quantPolicyEnabled=${productionState.quantPolicyEnabled}).`);
    }
    if (report.dataReadiness.notReadyAuthorized.length > 0) {
      overall = 'NO_GO';
      conditions.push(`DATA NOT_READY for authorized strategies: ${report.dataReadiness.notReadyAuthorized.map((r: any) => r.strategyId).join(', ')}.`);
    }
    const partiallyReadyAuthorized = readiness.filter(
      r => r.readiness === 'PARTIALLY_READY' && authorizedIds.has(r.strategyId),
    );
    if (partiallyReadyAuthorized.length > 0 && overall === 'READY') {
      overall = 'READY_WITH_CONDITIONS';
      conditions.push(`PARTIALLY_READY (degraded, honest) for authorized: ${partiallyReadyAuthorized.map(r => r.strategyId).join(', ')}.`);
    }
    if (productionState.MISSING_LIFECYCLE_ROWS > 0) {
      // Missing lifecycle is already captured by the FAIL invariant above when it drives
      // authorization to zero; when some strategies ARE authorized, missing rows elsewhere
      // are still a condition the operator should see.
      if (overall === 'READY') {
        overall = 'READY_WITH_CONDITIONS';
        conditions.push(`${productionState.MISSING_LIFECYCLE_ROWS} strategies have no lifecycle record (terminally NOT_AUTHORIZED; routing falls back to consensus where eligible).`);
      } else {
        conditions.push(`${productionState.MISSING_LIFECYCLE_ROWS} strategies have no lifecycle record (terminally NOT_AUTHORIZED).`);
      }
    }

    report.conditions = conditions;
    report.overallStatus = overall;

    closeDb();

    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printHuman(report);
    }
    process.exitCode = overall === 'READY' ? 0 : overall === 'READY_WITH_CONDITIONS' ? 2 : 3;
  } catch (error: any) {
    closeDb();
    const fatal = `certifyNextSession: internal error: ${error?.message || error}\n`;
    if (asJson && (globalThis as any).__certStderr) (globalThis as any).__certStderr(fatal);
    else console.error(fatal);
    process.exitCode = 1;
  }
  // Imports may install diagnostic timers; this command has no running engine to drain.
  process.exit(process.exitCode ?? 1);
}

/**
 * Probe the isolated DB for the data dimensions the strategy data contracts consume.
 * Dimensions not observable from the DB are reported as UNVERIFIED and treated as
 * unavailable (fail-closed) — never silently assumed present.
 */
function probeAvailableData(db: any): { available: AvailableData; probeDetails: Record<string, string> } {
  const out: AvailableData = {
    intradayBars: false,
    dailyBars: 0,
    sessionVWAP: false,
    priorDayLevels: false,
    rvol: false,
    sectorData: false,
    relativeStrengthVsSpy: false,
  };
  const details: Record<string, string> = {};
  const sessionStartMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime();

  try {
    const intraday = db.prepare(
      `SELECT COUNT(*) AS n FROM ohlcv_bars WHERE timeframe IN ('1Min','5Min','15Min') AND timestamp >= ?`,
    ).get(sessionStartMs) as any;
    out.intradayBars = (intraday?.n ?? 0) > 0;
    details.intradayBars = `${intraday?.n ?? 0} intraday bars since session start (verified from ohlcv_bars)`;
  } catch { details.intradayBars = 'probe failed'; }

  try {
    const depth = db.prepare(
      `SELECT MAX(c) AS m FROM (SELECT COUNT(*) AS c FROM ohlcv_bars WHERE timeframe = '1Day' GROUP BY symbol)`,
    ).get() as any;
    out.dailyBars = depth?.m ?? 0;
    details.dailyBars = `max per-symbol 1Day depth: ${out.dailyBars}`;
  } catch { details.dailyBars = 'probe failed'; }

  // The newest assessment's stored market context + strategy evaluations are the honest
  // record of what the quant pipeline actually computed last session.
  let latestContext: any = null;
  let latestEvaluations: any = null;
  try {
    const row = db.prepare(
      `SELECT market_context, strategy_evaluations FROM quant_assessments ORDER BY created_at DESC LIMIT 1`,
    ).get() as any;
    if (row?.market_context) { try { latestContext = JSON.parse(row.market_context); } catch { /* keep null */ } }
    if (row?.strategy_evaluations) { try { latestEvaluations = JSON.parse(row.strategy_evaluations); } catch { /* keep null */ } }
  } catch { /* no assessments table/rows */ }

  const unverified = (name: string) => {
    details[name] = 'UNVERIFIED: not observable from the DB snapshot; treated as unavailable (fail-closed)';
    return false;
  };

  out.sessionVWAP = latestEvaluations
    ? scanForIntradayVwap(latestEvaluations)
    : unverified('sessionVWAP');
  out.priorDayLevels = latestContext
    ? scanForPriorDayLevels(latestContext)
    : unverified('priorDayLevels');
  out.sectorData = latestContext
    ? !!(latestContext.sector && latestContext.sector.trend)
    : unverified('sectorData');
  out.relativeStrengthVsSpy = latestContext
    ? latestContext.relativeStrengthVsSPY != null
    : unverified('relativeStrengthVsSpy');
  // RVOL needs volume on intraday bars plus daily depth for the baseline.
  out.rvol = !!(out.intradayBars && (out.dailyBars ?? 0) >= 20);
  details.rvol = out.rvol ? 'derived: intraday volume bars + >=20 daily bars' : 'derived unavailable';

  return { available: out, probeDetails: details };
}

function scanForIntradayVwap(evaluations: any): boolean {
  const seen = JSON.stringify(evaluations);
  return /"intradayBased"\s*:\s*true/.test(seen);
}

function scanForPriorDayLevels(context: any): boolean {
  const seen = JSON.stringify(context);
  return /previousDay|priorDay|prior_day/i.test(seen);
}

function printHuman(report: any) {
  console.log('CERTIFY NEXT SESSION — pre-market release gate');
  console.log(`generated: ${report.generatedAt}   build: ${String(report.buildSha).slice(0, 12)}   config: ${String(report.configHash).slice(0, 12)}`);
  console.log('');
  const ls = report.lifecycleSummary;
  console.log(`lifecycle: ${ls.totalStrategies} strategies | enabled=${ls.enabledQuantStrategies} | rows=${ls.lifecycleRows} | missing=${ls.missingLifecycleRows}`);
  console.log(`authorized paper quant strategies: ${ls.authorizedPaperQuantStrategies}   verdict: ${ls.verdict}`);
  console.log('');
  console.log('data readiness (authorized strategies only):');
  for (const r of report.dataReadiness.perStrategy) {
    if (!r.hasQuantAuthority) continue;
    const missing = r.missingRequired?.length ? ` missing REQUIRED: ${r.missingRequired.join(', ')}` : '';
    console.log(`  ${r.strategyId}: ${r.readiness}${missing}`);
  }
  const unauthNotReady = report.dataReadiness.perStrategy.filter((r: any) => !r.hasQuantAuthority && r.readiness === 'NOT_READY').length;
  if (unauthNotReady > 0) {
    console.log(`  (${unauthNotReady} non-authorized strategies also NOT_READY — informational, they cannot trade)`);
  }
  console.log('');
  if (report.conditions.length > 0) {
    console.log('conditions:');
    for (const c of report.conditions) console.log(`  - ${c}`);
    console.log('');
  }
  console.log(`OVERALL_STATUS: ${report.overallStatus}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
