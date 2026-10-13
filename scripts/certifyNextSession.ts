/**
 * certify-next-session (isolated child).
 *
 * Runs the full pre-market release-gate certification against an ISOLATED copy of the
 * production database. The parent process (argus-cli `certify-next-session`) creates the
 * copy with the sqlite3 online backup API from the live DB; this child never touches the
 * live DB.
 *
 * As of 2026-10-11 the verdict is computed by the release certification driver
 * (src/server/certification/releaseCertificationDriver.ts), which orchestrates ALL
 * mandatory checks under the strict rule: a partial probe can NEVER report READY.
 * Only PASS satisfies; FAIL/NOT_RUN/UNKNOWN/NOT_CERTIFIED force READY=false.
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
 *     --isolated-db=/tmp/argus-cert-XXXX/snapshot.db [--json] [--with-suites] [--engine-url=http://127.0.0.1:3000]
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
import { getTradingDayStartMs } from '../src/server/core/TradingCalendar';
import {
  runReleaseCertification,
  type ReleaseCheck,
  type ReleaseCertificationReport,
} from '../src/server/certification/releaseCertificationDriver';
import { buildCliAuthHeaders, defaultSessionFilePath } from './cli/cliSession';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

async function main() {
  const asJson = process.argv.includes('--json');
  const withSuites = process.argv.includes('--with-suites');
  // Phase 2 (2026-10-12): synthetic market-open session stage, reusing the
  // scripts/sim/marketOpen.ts --certify infrastructure (the same command as
  // package.json test:certification). Opt-in like --with-suites: it is a
  // minutes-long stage and the release gate stays fast by default.
  const withSim = process.argv.includes('--with-sim');
  const simSpeedArg = process.argv.find(a => a.startsWith('--sim-speed='));
  const simSpeed = simSpeedArg ? Number(simSpeedArg.slice('--sim-speed='.length)) : 400; // 400 = test:certification
  if (simSpeedArg && (!Number.isFinite(simSpeed) || simSpeed <= 0)) {
    throw new Error('certifyNextSession: --sim-speed=<n> must be a positive number');
  }
  const engineUrlArg = process.argv.find(a => a.startsWith('--engine-url='));
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
    let buildSha: string;
    try {
      buildSha = execSync('git rev-parse HEAD', { cwd: path.resolve('.'), encoding: 'utf8' }).trim();
    } catch {
      buildSha = 'UNKNOWN (git unavailable)';
    }
    report.buildSha = buildSha;
    const safetyCfgPath = path.resolve('config/tradingSafety.json');
    const safetyCfgRaw = fs.readFileSync(safetyCfgPath, 'utf8');
    const safetyCfg = JSON.parse(safetyCfgRaw);
    const configHash = sha256Hex(safetyCfgRaw);
    report.configHash = configHash;

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

    // --- Real lifecycle-state summary (Phase 2): the canonical pre-market inputs,
    // read-only. Authorized strategies, the PAPER allocation profile, existing
    // positions (SELECT-only on the isolated snapshot), and the key trading-safety
    // numbers as actually configured. Never writes, never seeds, never promotes.
    const { buildRealStateSummary } = await import('../src/server/certification/nextSessionCertExtras');
    report.realState = buildRealStateSummary({
      productionState,
      safetyConfig: safetyCfg,
      db: sqliteDb,
      repoRoot: path.resolve('.'),
    });

    const schemaVersionRaw: any = (() => {
      try { return sqliteDb.prepare('PRAGMA user_version').get(); } catch { return null; }
    })();
    report.schemaVersion = typeof schemaVersionRaw === 'number'
      ? schemaVersionRaw : (schemaVersionRaw?.user_version ?? 'UNKNOWN');

    // --- Strategy registry hash (detects registry drift between builds) -------
    const { STRATEGY_DATA_CONTRACTS } = await import('../src/server/certification/strategyDataContracts');
    const registryFingerprint = Object.keys(STRATEGY_DATA_CONTRACTS)
      .sort()
      .map(id => {
        const c: any = STRATEGY_DATA_CONTRACTS[id];
        return `${id}:${Object.keys(c.inputs ?? {}).sort().map(k => `${k}=${c.inputs[k]}`).join(',')}`;
      })
      .join('|');
    const strategyRegistryHash = sha256Hex(registryFingerprint);
    const strategyRegistrySize = Object.keys(STRATEGY_DATA_CONTRACTS).length;
    report.strategyRegistryHash = strategyRegistryHash;
    report.strategyRegistrySize = strategyRegistrySize;

    // --- Quant scheduler SLA configuration ------------------------------------
    report.quantSchedulerSla = {
      quantCycleIntervalMs: safetyCfg.quantCycleIntervalMs ?? null,
      quantMaxConcurrentSymbols: safetyCfg.quantMaxConcurrentSymbols ?? null,
      note: 'Runtime SLA (cycle completion, per-symbol completeness, late-admission bound) is certified by src/server/certification/quantSchedulerSla.test.ts against the real scheduler with fault injection.',
    };

    // --- Stale cache status: probe the isolated DB's bar tails -------------------
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

    // --- PIT replay provenance ---------------------------------------------------
    let pitProvenanceRows: number | null = null;
    try {
      const provCount = (sqliteDb.prepare('SELECT COUNT(*) AS n FROM decision_provenance').get() as any)?.n ?? 0;
      pitProvenanceRows = provCount;
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

    // --- Release certification driver (2026-10-11): ALL mandatory checks --------
    // The driver owns the verdict under the strict rule: only PASS satisfies;
    // FAIL/NOT_RUN/UNKNOWN/NOT_CERTIFIED force READY=false (a partial probe can
    // never report READY).
    const sourceDbPath = process.env.ARGUS_CERT_SOURCE_DB
      ? path.resolve(process.env.ARGUS_CERT_SOURCE_DB)
      : path.resolve('data/argus.db');
    const driverReport: ReleaseCertificationReport = await runReleaseCertification({
      repoRoot: path.resolve('.'),
      buildSha,
      configHash,
      schemaVersionRaw,
      strategyRegistryHash,
      strategyRegistrySize,
      snapshot: { snapshotPath: isolatedDbPath, sourcePath: sourceDbPath },
      configEquivalence: {
        envFilePresent: fs.existsSync(path.resolve('.env')),
        forcedOverrides: [
          'SYNTHETIC_SIMULATION=false',
          'ARGUS_DISABLE_MARKET_DATA_WS=true',
          'PAPER_TRADING_ONLY=true',
          `ARGUS_DB_PATH=<isolated snapshot>`,
        ],
      },
      productionState: {
        TOTAL_STRATEGIES: productionState.TOTAL_STRATEGIES,
        ENABLED_QUANT_STRATEGIES: productionState.ENABLED_QUANT_STRATEGIES,
        LIFECYCLE_ROWS: productionState.LIFECYCLE_ROWS,
        MISSING_LIFECYCLE_ROWS: productionState.MISSING_LIFECYCLE_ROWS,
        lifecycleStateCounts: productionState.lifecycleStateCounts as unknown as Record<string, number>,
        AUTHORIZED_PAPER_QUANT_STRATEGIES: productionState.AUTHORIZED_PAPER_QUANT_STRATEGIES,
        quantPolicyEnabled: productionState.quantPolicyEnabled,
        paperOnlyEnforced: productionState.paperOnlyEnforced,
        verdict: productionState.verdict,
        details: (productionState.details ?? []).map((d: any) => ({
          strategyId: d.strategyId, authorized: d.authorized, reason: d.reason,
        })),
      },
      dataReadiness: {
        perStrategy: report.dataReadiness.perStrategy,
        notReadyAuthorized: report.dataReadiness.notReadyAuthorized,
        probeDetails: report.dataReadiness.probeDetails,
      },
      staleCacheStatus: report.staleCacheStatus,
      pitProvenanceRows,
      quantSchedulerSla: {
        quantCycleIntervalMs: report.quantSchedulerSla.quantCycleIntervalMs,
        quantMaxConcurrentSymbols: report.quantSchedulerSla.quantMaxConcurrentSymbols,
      },
      withSuites,
      engineBaseUrl: engineUrlArg ? engineUrlArg.slice('--engine-url='.length) : null,
      liveProbeHeaders: engineUrlArg
        ? buildCliAuthHeaders({
            sessionPath: process.env.ARGUS_CLI_SESSION_FILE || defaultSessionFilePath(path.resolve('.')),
          })
        : undefined,
    });
    report.releaseCertification = driverReport;

    // --- Simulated market-open session (Phase 2, --with-sim) -----------------------
    // Reuses the mandatory marketOpen --certify infrastructure (Test A QUIET_OPEN
    // no-trade safety + Test B VALIDATED_CONVERGENCE_CONTROL), labeled
    // SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY. It never
    // forces a strategy signal, a Chief/Risk approval, or a fill above the broker
    // boundary — the sim's own HistoricalReplayBroker is the only "broker", in
    // the sim's own isolated tmp DBs. A FAIL here fails the verdict closed
    // (NO_GO); it can never manufacture a GO.
    const { runMarketOpenCertify, computeGoNoGo } = await import('../src/server/certification/nextSessionCertExtras');
    if (withSim) {
      report.simulatedSession = await runMarketOpenCertify({ repoRoot: path.resolve('.'), speed: simSpeed });
    } else {
      report.simulatedSession = null;
    }

    // --- GO / NO-GO verdict (Phase 2): fail-closed mapping of the release driver
    // plus the simulated session. GO requires driver READY and (when run) a
    // passing sim. A correct, explainable NO-GO is a valid certification
    // result, never a bug.
    const goNoGo = computeGoNoGo({
      driverOverallStatus: driverReport.overallStatus,
      driverBlockingChecks: driverReport.blockingChecks ?? [],
      simStage: report.simulatedSession
        ? { ran: true, pass: report.simulatedSession.pass === true, summary: report.simulatedSession.summary ?? '' }
        : { ran: false, pass: false, summary: 'not run (pass --with-sim to include a synthetic market-open session)' },
    });
    report.goNoGo = goNoGo.goNoGo;
    report.goNoGoReasons = goNoGo.reasons;

    // The required CLI fields, flat: every mandatory check by field name.
    report.fields = Object.fromEntries(
      driverReport.checks.map((c: ReleaseCheck) => [c.field, { state: c.state, value: c.value, evidence: c.evidence }]),
    );
    report.conditions = driverReport.conditions;
    report.overallStatus = driverReport.overallStatus;
    report.ready = driverReport.ready;
    report.blockingChecks = driverReport.blockingChecks;

    closeDb();

    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printHuman(report);
    }
    process.exitCode = report.overallStatus === 'READY' ? 0 : report.overallStatus === 'READY_WITH_CONDITIONS' ? 2 : 3;
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
  // 2026-10-11: session boundary is the market-timezone trading day start
  // (America/New_York, DST-correct via TradingCalendar.getTradingDayStartMs), not UTC
  // midnight. The old UTC-midnight boundary was wrong for several hours around each
  // exchange midnight (e.g. 21:00 EDT Oct 11 is already Oct 12 in UTC, so the probe
  // looked for "today's" intraday bars in the wrong UTC day).
  const sessionStartMs = getTradingDayStartMs(new Date());

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

/** Phase 2: read-only real lifecycle-state summary (JSON report already carries the full object). */
function printRealState(rs: any) {
  if (!rs) {
    console.log('REAL LIFECYCLE STATE: unavailable');
    return;
  }
  console.log('REAL LIFECYCLE STATE (read-only: isolated snapshot + config/*.json — no writes, no seeding, no promotion)');
  console.log(`  authorized PAPER quant strategies : ${rs.authorizedPaperQuantStrategies ?? 'n/a'}` +
    (rs.quantVerdict ? `  [${rs.quantVerdict}]` : ''));
  const alloc = rs.allocationProfile ?? {};
  console.log(`  allocation profile                : ${alloc.budget != null ? `$${alloc.budget}` : 'n/a'}` +
    `  (${alloc.source ?? 'config/paperAllocationProfile.json'})` +
    (alloc.error ? `  ERROR: ${alloc.error}` : ''));
  const pos = rs.positions ?? {};
  console.log(`  open positions                    : ${pos.count ?? 'n/a'}` +
    (pos.error ? `  ERROR: ${pos.error}` : ''));
  if (Array.isArray(pos.rows) && pos.rows.length > 0) {
    for (const p of pos.rows.slice(0, 10)) {
      console.log(`    - ${p.symbol} qty=${p.quantity} avg=${p.averagePrice ?? '?'} px=${p.currentPrice ?? '?'} uPnL=${p.unrealizedPnL ?? '?'}`);
    }
    if (pos.rows.length > 10) console.log(`    ... (${pos.rows.length - 10} more)`);
  }
  const safety = rs.tradingSafety ?? {};
  const safetyLine = Object.entries(safety).map(([k, v]) => `${k}=${v ?? 'n/a'}`).join('  ');
  console.log(`  trading safety                    : ${safetyLine}  (${rs.tradingSafetySource ?? 'config/tradingSafety.json'})`);
}

/** Phase 2: simulated-session stage (JSON report already carries the full object). */
function printSimStage(sim: any) {
  if (!sim) {
    console.log('SIMULATED SESSION: not run — pass --with-sim to include a synthetic market-open session (marketOpen --certify).');
    return;
  }
  console.log('SIMULATED SESSION (--with-sim; scripts/sim/marketOpen.ts --certify infra)');
  console.log(`  classification: ${(sim.classification ?? []).join(' / ')}`);
  console.log(`  command: ${sim.command}   exit=${sim.exitCode ?? 'n/a'}${sim.timedOut ? ' (TIMED OUT)' : ''}   ${sim.durationMs}ms`);
  for (const r of sim.parsed?.testA ?? []) {
    console.log(`  TEST A (no-trade safety) [seed=${r.seed}]: ${r.certification} (tradeObserved=${r.tradeObserved}, ${r.detail ?? 'n/a'})`);
  }
  for (const r of sim.parsed?.testB ?? []) {
    console.log(`  TEST B (tradeable scenario) [seed=${r.seed}]: ${r.certification} (tradeObserved=${r.tradeObserved}, calibrationSeeded=${r.calibrationSeeded ?? 'n/a'})`);
  }
  if (sim.error) console.log(`  stage error: ${sim.error}`);
  if (sim.evidenceNote) console.log(`  ${sim.evidenceNote}`);
  console.log(`  sim verdict: ${sim.pass ? 'PASS' : 'FAIL'}`);
}

function printHuman(report: any) {
  console.log('CERTIFY NEXT SESSION — pre-market release gate (release certification driver)');
  console.log(`generated: ${report.generatedAt}   build: ${String(report.buildSha).slice(0, 12)}   config: ${String(report.configHash).slice(0, 12)}`);
  console.log('');
  const checks: any[] = report.releaseCertification?.checks ?? [];
  const byState: Record<string, number> = {};
  for (const c of checks) byState[c.state] = (byState[c.state] ?? 0) + 1;
  console.log(`mandatory checks: ${checks.length} total | ` +
    Object.entries(byState).map(([s, n]) => `${s}=${n}`).join(' '));
  console.log('');
  console.log('check                                        state          value/evidence');
  console.log('─'.repeat(100));
  for (const c of checks) {
    const val = c.value === null || c.value === undefined ? ''
      : typeof c.value === 'object' ? JSON.stringify(c.value).slice(0, 44)
      : String(c.value).slice(0, 44);
    console.log(`${c.field.padEnd(42)} ${c.state.padEnd(14)} ${val}`);
  }
  console.log('─'.repeat(100));
  console.log('');
  if (report.conditions.length > 0) {
    console.log('conditions:');
    for (const cond of report.conditions) console.log(`  - ${cond}`);
    console.log('');
  }
  if ((report.blockingChecks ?? []).length > 0) {
    console.log(`blocking checks (${report.blockingChecks.length}): ${report.blockingChecks.join(', ')}`);
    console.log('');
  }
  console.log(`READY: ${report.ready}`);
  console.log(`OVERALL_STATUS: ${report.overallStatus}`);
  console.log('');
  printRealState(report.realState);
  console.log('');
  printSimStage(report.simulatedSession);
  console.log('');
  // Phase 2: fail-closed GO / NO-GO with the evidence behind it (JSON report
  // carries the same in goNoGo / goNoGoReasons). A NO-GO is a valid,
  // explainable certification result, never a bug.
  console.log(`VERDICT: ${report.goNoGo}`);
  for (const reason of report.goNoGoReasons ?? []) console.log(`  reason: ${reason}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
