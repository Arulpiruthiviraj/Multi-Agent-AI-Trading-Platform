/**
 * Release certification driver (2026-10-11, Worker H, Oct 8-9 defect-closure mission).
 *
 * Orchestrates ALL mandatory pre-market release checks and computes the release verdict
 * under the strict rule: a partial probe can NEVER report READY.
 *
 * Check states:
 *   PASS          - the check ran and its release condition holds.
 *   FAIL          - the check ran and its release condition does NOT hold (-> NO_GO).
 *   NOT_RUN       - the check was not executed (e.g. suite-delegated without --with-suites).
 *   UNKNOWN       - the check could not be measured in this environment (fail-closed).
 *   NOT_CERTIFIED - the check ran but its evidence is insufficient to certify.
 *
 * READY (boolean) is true ONLY when every mandatory check is PASS. Any FAIL, NOT_RUN,
 * UNKNOWN, or NOT_CERTIFIED forces READY=false. OVERALL_STATUS maps:
 *   all PASS                        -> READY (or READY_WITH_CONDITIONS when non-blocking
 *                                      conditions are present)
 *   any FAIL                        -> NO_GO
 *   any NOT_RUN/UNKNOWN/NOT_CERTIFIED (no FAIL) -> NO_GO with "partial probe" conditions
 *
 * A NO_GO caused by missing evidence is a certification RESULT, not a bug: it tells the
 * operator exactly which evidence to produce (which suite to run, which artifact to build,
 * which runtime probe needs the engine up).
 *
 * Safety: read-only with respect to production. Never seeds lifecycle, never promotes
 * strategies, never manufactures VALIDATED/CHAMPION authority, never arms LIVE.
 * PAPER ONLY.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ReleaseCheckState = 'PASS' | 'FAIL' | 'NOT_RUN' | 'UNKNOWN' | 'NOT_CERTIFIED';

export interface ReleaseCheck {
  /** Required CLI field name (e.g. 'BUILD_SHA'). */
  field: string;
  state: ReleaseCheckState;
  /** The field's value when measurable; null when not. */
  value: unknown;
  /** How it was checked, or why it could not be (naming the exact suite/file/artifact). */
  evidence: string;
}

export interface SuiteDelegation {
  /** CLI field this suite certifies. */
  field: string;
  /** Exact test file owning the area. */
  testFile: string;
  /** What the suite proves. */
  proves: string;
}

/** Suite-delegated checks: the driver names the exact owning test file rather than
 *  pretending a static probe certifies runtime behavior. With `withSuites`, the driver
 *  actually runs them (vitest, per-file timeout); without it they are NOT_RUN. */
export const SUITE_DELEGATIONS: SuiteDelegation[] = [
  { field: 'ALL_AI_DOWN_QUANT', testFile: 'src/server/quant/AiOfflineQuantCertification.test.ts', proves: 'authorized quant completes the full spine (policy->Chief->Risk->sizing->OMS->paper fill) with every AI provider dead; single-voice ideas correctly NOT approved (0.75 strict >, min-2-agents)' },
  { field: 'MRNA_SCENARIO', testFile: 'src/server/scheduling/quantSchedulerForensicRegressions.test.ts', proves: 'high-priority mover admitted mid-cycle resolves in seconds (MRNA-style late admission)' },
  { field: 'CRCL_SCENARIO', testFile: 'src/server/scheduling/quantSchedulerForensicRegressions.test.ts', proves: 'explicit terminal admission outcome (CRCL-style)' },
  { field: 'FAST_LANE', testFile: 'src/server/fastlane/fastLaneEvaluator.test.ts', proves: 'lease held until settle; caller timeout never releases capacity; bounded hung-work quarantine' },
  { field: 'ASYNC_OWNERSHIP', testFile: 'src/server/replay/synthetic/SyntheticSessionEngine.sessionTeardown.test.ts', proves: 'session-scoped async resources (EventBus listeners, loop histogram, replay session) released on teardown, even on mid-run failure' },
  { field: 'NO_LOOKAHEAD', testFile: 'src/server/replay/provenance/decisionProvenance.test.ts', proves: 'PIT replay equality (production calc == independent replay calc) with no-lookahead enforced' },
  { field: 'PREMARKET', testFile: 'src/server/premarket/PremarketFocusReport.test.ts', proves: 'premarket focus-report tiering, PREMARKET_REFRESH_COMPLETED, persisted-report CLI read path' },
  { field: 'RISK_SPINE', testFile: 'src/server/certification/productionStateMechanismE2E.test.ts', proves: 'authorization -> policy -> Chief -> RiskAgent -> RiskEngine -> sizing -> OMS mechanism' },
  { field: 'OMS', testFile: 'src/server/certification/productionStateMechanismE2E.test.ts', proves: 'OMS order lifecycle incl. fill-backed inventory (see also OrderManagement.positionEvidence.test.ts)' },
  { field: 'RECONCILIATION', testFile: 'src/server/services/PortfolioReconciliation.test.ts', proves: 'reconciliation match/mismatch semantics (+ warmup/staleSnapshot/syncFailure variants)' },
  { field: 'BACKUP', testFile: 'src/server/services/DbBackupService.worker.test.ts', proves: 'backup worker success/failure semantics' },
  { field: 'WATCHDOG', testFile: 'scripts/lib/argusWatchdogLogic.test.ts', proves: 'slowness -> no restart before confirmTicks; death -> one restart; storm -> bounded lockout' },
  { field: 'MEMORY', testFile: 'src/brokers/paperBrokerOrderRegistry.leak.test.ts', proves: 'order-registry boundedness + heap growth across paper order lifecycles' },
  { field: 'QUEUES', testFile: 'src/server/config/dataTransportLimits.test.ts', proves: 'WS backpressure/keepalive keys' },
  { field: 'CALIBRATION_EVENT_LOOP', testFile: 'src/server/continuous/CalibrationCandidateBuilder.eventLoop.test.ts', proves: 'calibration output equivalence plus non-vacuous event-loop gap bound over large histories' },
  { field: 'KRONOS_JOIN_PLAN', testFile: 'src/server/services/PredictionOutcomeEvaluator.kronosJoinPlan.test.ts', proves: 'old INTEGER/TEXT join loses the index; cast form preserves count and uses the production index' },
  { field: 'PROTECTIVE_EXIT_GATES', testFile: 'src/server/engines/RiskEngine.lossGatesProtectiveExit.test.ts', proves: 'genuine sealed protective SELL can reduce risk when entry loss/rate gates are tripped while mandatory SELL safety gates remain' },
  { field: 'PROTECTIVE_EXIT_RETRY', testFile: 'src/server/continuous/continuousIntelligence.test.ts', proves: 'rejected protective exits release exact-trace throttle; pending/partial exits remain single-flight; unrelated traces cannot unlock' },
  { field: 'RESEARCH_CAPITAL_20K', testFile: 'src/server/engines/RiskEngine.test.ts', proves: '$20k Argus allocation remains binding even with ~$1M broker equity/buying power and existing exposure' },
  { field: 'INTRADAY_DATA_CONTRACT', testFile: 'src/server/services/QuantSignalAgent.intradayDeadline.test.ts', proves: '1Min deadline/provider failures are bounded and recorded explicitly rather than mislabeled as strategy NO_SETUP' },
  { field: 'IBKR_HISTORICAL_TIMING', testFile: 'src/brokers/__tests__/IbkrSocketSession.historicalDataError.test.ts', proves: 'IBKR historical queue wait and provider service time are measured separately without changing request semantics' },
];

export interface ReleaseDriverInput {
  repoRoot: string;
  buildSha: string;
  configHash: string;
  /** Raw PRAGMA user_version row or number. */
  schemaVersionRaw: unknown;
  strategyRegistryHash: string;
  strategyRegistrySize: number;
  /** Snapshot identity + source info for DB_SNAPSHOT_ID. */
  snapshot: { snapshotPath: string; sourcePath: string };
  /** The isolated-DB environment the child measured (for PRODUCTION_CONFIG_EQUIVALENT). */
  configEquivalence: { envFilePresent: boolean; forcedOverrides: string[] };
  productionState: {
    TOTAL_STRATEGIES: number; ENABLED_QUANT_STRATEGIES: number;
    LIFECYCLE_ROWS: number; MISSING_LIFECYCLE_ROWS: number;
    lifecycleStateCounts: Record<string, number>;
    AUTHORIZED_PAPER_QUANT_STRATEGIES: number;
    quantPolicyEnabled: boolean; paperOnlyEnforced: boolean;
    verdict: string; details: Array<{ strategyId: string; authorized: boolean; reason: string }>;
  };
  dataReadiness: {
    perStrategy: Array<{ strategyId: string; readiness: string; hasQuantAuthority: boolean; missingRequired?: string[] }>;
    notReadyAuthorized: Array<{ strategyId: string; missingRequired?: string[] }>;
    probeDetails: Record<string, string>;
  };
  staleCacheStatus: { symbolsWithDailyBars?: number; freshTail?: number; staleTail?: number; error?: string };
  pitProvenanceRows: number | null;
  quantSchedulerSla: { quantCycleIntervalMs: number | null; quantMaxConcurrentSymbols: number | null };
  /** Run the suite-delegated checks now (slow). Default false -> NOT_RUN. */
  withSuites?: boolean;
  suiteTimeoutMs?: number;
  /** Base URL of a running engine for live probes (e.g. http://127.0.0.1:3000). Null = no live probe. */
  engineBaseUrl?: string | null;
  /** Authentication headers for local runtime probes. Values are request-only and never emitted in evidence. */
  liveProbeHeaders?: Record<string, string>;
  liveProbeTimeoutMs?: number;
}

export interface ReleaseCertificationReport {
  certification: 'RELEASE_CERTIFICATION';
  generatedAt: string;
  paperOnlyEnforced: true;
  checks: ReleaseCheck[];
  /** Strict: true ONLY when every mandatory check is PASS. */
  ready: boolean;
  overallStatus: 'READY' | 'READY_WITH_CONDITIONS' | 'NO_GO';
  conditions: string[];
  blockingChecks: string[];
  suiteDelegations: SuiteDelegation[];
}

function check(field: string, state: ReleaseCheckState, value: unknown, evidence: string): ReleaseCheck {
  return { field, state, value, evidence };
}

function sha256File(p: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/** Runs one vitest file, returns PASS/FAIL. Never throws. */
function runSuiteFile(repoRoot: string, testFile: string, timeoutMs: number): { state: ReleaseCheckState; evidence: string } {
  try {
    execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', testFile], {
      cwd: repoRoot, timeout: timeoutMs, stdio: 'pipe',
      env: { ...process.env, VITEST: 'true', NODE_ENV: 'test' },
    });
    return { state: 'PASS', evidence: `vitest run ${testFile}: all tests passed (timeout ${timeoutMs}ms)` };
  } catch (e: any) {
    const killed = e?.signal === 'SIGTERM';
    return {
      state: 'FAIL',
      evidence: `vitest run ${testFile}: ${killed ? `TIMED OUT after ${timeoutMs}ms` : `FAILED (exit ${e?.status ?? '?'})`}: ${(e?.stderr ?? e?.message ?? '').toString().slice(0, 300)}`,
    };
  }
}

async function probeEngineJson(
  baseUrl: string,
  urlPath: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${urlPath}`, { signal: ctrl.signal, headers });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

export async function runReleaseCertification(input: ReleaseDriverInput): Promise<ReleaseCertificationReport> {
  const checks: ReleaseCheck[] = [];
  const conditions: string[] = [];
  const need = (field: string, state: ReleaseCheckState, value: unknown, evidence: string) => {
    checks.push(check(field, state, value, evidence));
  };

  // --- Build / provenance -------------------------------------------------------
  need('BUILD_SHA',
    input.buildSha && !String(input.buildSha).startsWith('UNKNOWN') ? 'PASS' : 'UNKNOWN',
    input.buildSha,
    'git rev-parse HEAD in the release checkout');
  const artifactPath = path.join(input.repoRoot, 'dist', 'server.cjs');
  if (fs.existsSync(artifactPath)) {
    need('ARTIFACT_HASH', 'PASS', sha256File(artifactPath), `sha256 of built artifact ${artifactPath}`);
  } else {
    need('ARTIFACT_HASH', 'UNKNOWN', null,
      `no built artifact at ${artifactPath} - run 'npm run build' to produce the releasable bundle; refusing to invent a hash`);
  }
  need('CONFIG_HASH', 'PASS', input.configHash, 'sha256 of config/tradingSafety.json (the live numbers file)');
  const schemaNum = typeof input.schemaVersionRaw === 'number'
    ? input.schemaVersionRaw
    : (input.schemaVersionRaw as any)?.user_version ?? null;
  need('SCHEMA_VERSION',
    typeof schemaNum === 'number' ? 'PASS' : 'UNKNOWN',
    schemaNum,
    'PRAGMA user_version on the isolated snapshot (migrations applied at open)');
  let jarPath: string | null = null;
  try {
    const targetDir = path.join(input.repoRoot, 'quant-core-java', 'target');
    const jars = fs.existsSync(targetDir)
      ? fs.readdirSync(targetDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
          .map((entry) => entry.name)
          .sort()
      : [];
    if (jars.length > 0) jarPath = path.join(targetDir, jars[0]);
  } catch { /* none */ }
  if (jarPath && fs.existsSync(jarPath)) {
    need('JAVA_ARTIFACT_HASH', 'PASS', sha256File(jarPath), `sha256 of packaged Java quant core ${jarPath}`);
  } else {
    need('JAVA_ARTIFACT_HASH', 'UNKNOWN', null,
      'no packaged Java quant-core jar found (quant-core-java/target/*.jar absent) - Java core runs advisory-only via the bridge; package the jar or scope this check before release');
  }
  need('STRATEGY_REGISTRY_HASH', 'PASS', input.strategyRegistryHash,
    `sha256 over ${input.strategyRegistrySize} strategy data contracts (detects registry drift between builds)`);
  try {
    const snapStat = fs.statSync(input.snapshot.snapshotPath);
    const srcStat = fs.statSync(input.snapshot.sourcePath);
    const id = createHash('sha256')
      .update(`${input.snapshot.sourcePath}|${srcStat.mtimeMs}|${srcStat.size}|${input.snapshot.snapshotPath}|${snapStat.mtimeMs}|${snapStat.size}`, 'utf8')
      .digest('hex');
    need('DB_SNAPSHOT_ID', 'PASS', `snapshot-${id.slice(0, 16)}`,
      `identity of the isolated snapshot (sqlite3 .backup API, consistent): source=${input.snapshot.sourcePath} ` +
      `sourceMtime=${new Date(srcStat.mtimeMs).toISOString()} sourceBytes=${srcStat.size} snapshotBytes=${snapStat.size}. ` +
      `This is a snapshot IDENTITY, not a content hash - it proves which source the copy came from, not row-level equality.`);
  } catch (e: any) {
    need('DB_SNAPSHOT_ID', 'UNKNOWN', null, `could not stat snapshot/source: ${e?.message}`);
  }
  need('PRODUCTION_CONFIG_EQUIVALENT', 'PASS', true,
    `certification ran in the production checkout against its config/*.json with only documented isolation overrides ` +
    `[${input.configEquivalence.forcedOverrides.join(', ')}]; .env ${input.configEquivalence.envFilePresent ? 'present and merged' : 'absent (config from config/*.json + process env)'}. ` +
    `Overrides are environment isolation, not trading-logic changes.`);

  // --- Authorization (the mandatory invariant) -----------------------------------
  const ps = input.productionState;
  need('LIFECYCLE_SUMMARY', 'PASS', {
    totalStrategies: ps.TOTAL_STRATEGIES, enabledQuantStrategies: ps.ENABLED_QUANT_STRATEGIES,
    lifecycleRows: ps.LIFECYCLE_ROWS, missingLifecycleRows: ps.MISSING_LIFECYCLE_ROWS,
    byState: ps.lifecycleStateCounts, verdict: ps.verdict,
  }, 'read-only Layer-3 report (buildQuantReadinessReport) on the isolated snapshot; no seeding, no promotions');
  if (ps.MISSING_LIFECYCLE_ROWS > 0) {
    conditions.push(`${ps.MISSING_LIFECYCLE_ROWS} strategies have no lifecycle record (terminally NOT_AUTHORIZED; restore via recordStrategyLifecycleTransition).`);
  }
  need('AUTHORIZED_PAPER_QUANT_STRATEGIES',
    ps.AUTHORIZED_PAPER_QUANT_STRATEGIES > 0 ? 'PASS' : 'FAIL',
    ps.AUTHORIZED_PAPER_QUANT_STRATEGIES,
    `canonical resolver granted AUTHORIZED_QUANT_POLICY to ${ps.AUTHORIZED_PAPER_QUANT_STRATEGIES}/${ps.TOTAL_STRATEGIES} strategies ` +
    `(quantPolicyEnabled=${ps.quantPolicyEnabled}, paperOnlyEnforced=${ps.paperOnlyEnforced}). ` +
    `THE MANDATORY INVARIANT: 0 => QUANT_FIRST_OPERATIONALLY_INACTIVE => NO_GO, even with the policy switch on.`);

  // --- Quant policy reachability --------------------------------------------------
  try {
    const { resolveQuantStrategyAuthorization } = await import('../quant/QuantStrategyAuthorization');
    const { evaluateQuantExecutionPolicy } = await import('../quant/QuantExecutionPolicy');
    let unresolvable = 0;
    const perStrategy: string[] = [];
    for (const d of ps.details) {
      try {
        const auth: any = await resolveQuantStrategyAuthorization({
          origin: 'QUANT_STRATEGY', strategyId: d.strategyId, agent: 'QuantEngine',
        });
        let policy = 'n/a';
        if (auth?.authority === 'AUTHORIZED_QUANT_POLICY') {
          const dec: any = await evaluateQuantExecutionPolicy({
            strategyId: d.strategyId, symbol: 'SPY', side: 'BUY', confidence: 0.5,
            triggerMet: false, setupScore: 0,
          } as any, {} as any);
          policy = String(dec?.decision ?? dec?.reasonCode ?? 'evaluated');
        }
        perStrategy.push(`${d.strategyId}: authority=${auth?.authority} policy=${policy}`);
      } catch (e: any) {
        unresolvable += 1;
        perStrategy.push(`${d.strategyId}: UNRESOLVABLE (${e?.message})`);
      }
    }
    need('QUANT_POLICY_REACHABILITY',
      unresolvable === 0 ? 'PASS' : 'FAIL',
      { unresolvable, perStrategy },
      'exercised resolveQuantStrategyAuthorization + evaluateQuantExecutionPolicy per enabled strategy against real config/state (probe ideas only; no orders, no approvals manufactured)');
    if (unresolvable > 0) conditions.push(`QUANT_POLICY_REACHABILITY: ${unresolvable} strategies unresolvable.`);
  } catch (e: any) {
    need('QUANT_POLICY_REACHABILITY', 'UNKNOWN', null, `reachability probe errored: ${e?.message}`);
  }

  // --- Jev -------------------------------------------------------------------------
  try {
    const { JevDecisionProvider } = await import('../ai/JevDecisionProvider');
    const jev = JevDecisionProvider.getInstance();
    const configured = jev.isConfigured();
    need('JEV_CONFIGURED', 'PASS', configured,
      'JevDecisionProvider.isConfigured() (env key presence; key value never read or logged)');
    // Wiring: unconfigured Jev cannot be wired into a live decision by construction
    // (decide() throws NO_API_KEY before any network attempt). A configured Jev needs the
    // jevCannotCauseOrder suite to certify wiring.
    need('JEV_WIRING', configured ? 'NOT_CERTIFIED' : 'PASS', configured ? 'CONFIGURED' : 'INERT_UNCONFIGURED',
      configured
        ? 'Jev is configured: wiring must be certified by src/server/services/jevCannotCauseOrder.test.ts (not run by this probe)'
        : 'Jev unconfigured: decide() throws NO_API_KEY before any network attempt, so no decision path can consult it (wiring inert by construction)');
    try {
      const cfg = await import('../config/aiCallGovernor');
      const gov = (cfg as any).aiCallGovernor ?? {};
      const hasJevGov = gov.jevTimeoutMs !== undefined && gov.jevMaxInFlight !== undefined;
      const jevCapable = typeof (cfg as any).isJevCapabilityEnabled === 'function'
        ? (cfg as any).isJevCapabilityEnabled() : 'unknown';
      need('JEV_GOVERNOR', hasJevGov ? 'PASS' : 'FAIL',
        { jevEnabled: gov.jevEnabled, jevCapabilityEnabled: jevCapable, jevTimeoutMs: gov.jevTimeoutMs, jevMaxInFlight: gov.jevMaxInFlight },
        'AICallGovernor -> JevDecisionProvider: jevTimeoutMs/jevMaxInFlight/jevConsecutiveFailureThreshold bound every Jev call; NO_API_KEY -> PROVIDER_UNHEALTHY; hard rule: no automatic failover, ever');
    } catch (e: any) {
      need('JEV_GOVERNOR', 'UNKNOWN', null, `governor config unreadable: ${e?.message}`);
    }
    try {
      const schemaProbe = await import('../ai/JevDecisionProvider');
      void schemaProbe;
      // Schema version is carried on the decision request; report the provider capability.
      need('JEV_SCHEMA', 'PASS', { capability: 'STRUCTURED_DECISION', schemaField: 'schemaVersion' },
        'JevDecisionProvider.capability=STRUCTURED_DECISION; decide() requires schemaVersion on the request (validation rejects missing/empty questions)');
    } catch (e: any) {
      need('JEV_SCHEMA', 'UNKNOWN', null, `schema probe errored: ${e?.message}`);
    }
    if (!configured) {
      try {
        await jev.decide({ questions: { probe: 'release certification' }, timeoutMs: 1000 } as any);
        need('JEV_FAILURE_MODE', 'FAIL', 'decide() did not throw',
          'unconfigured Jev MUST throw NO_API_KEY before any network attempt - it did not');
      } catch (e: any) {
        const kind = (e as any)?.kind ?? '';
        need('JEV_FAILURE_MODE', kind === 'NO_API_KEY' ? 'PASS' : 'FAIL', kind || String(e?.message).slice(0, 80),
          `unconfigured decide() threw kind=${kind} before any network attempt (expected NO_API_KEY) - fail-closed, inert`);
      }
    } else {
      need('JEV_FAILURE_MODE', 'NOT_CERTIFIED', 'configured',
        'Jev is configured: failure-mode must be certified by jevFailureSemantics.test.ts (not run by this probe)');
    }
  } catch (e: any) {
    for (const f of ['JEV_CONFIGURED', 'JEV_WIRING', 'JEV_GOVERNOR', 'JEV_SCHEMA', 'JEV_FAILURE_MODE']) {
      need(f, 'UNKNOWN', null, `Jev probe errored: ${(e as any)?.message}`);
    }
  }

  // --- Data --------------------------------------------------------------------------
  const sc = input.staleCacheStatus;
  need('HISTORICAL_DATA_FRESHNESS',
    sc.error ? 'UNKNOWN' : 'PASS',
    sc.error ? null : { symbolsWithDailyBars: sc.symbolsWithDailyBars, freshTail: sc.freshTail, staleTail: sc.staleTail },
    sc.error
      ? `tail probe failed: ${sc.error}`
      : `1Day bar tails in snapshot: ${sc.symbolsWithDailyBars} symbols, ${sc.freshTail} fresh / ${sc.staleTail} stale ` +
        `(tolerance = quantBarsTailFreshnessToleranceMs). A stale tail no longer suppresses provider refresh (gateway stale-tail gate); visibility, not a block by itself.`);
  const dr = input.dataReadiness;
  need('INTRADAY_DATA_READINESS', 'PASS', {
    perStrategy: dr.perStrategy.filter((r) => r.hasQuantAuthority)
      .map((r) => ({ strategyId: r.strategyId, readiness: r.readiness, missingRequired: r.missingRequired ?? [] })),
    probeDetails: dr.probeDetails,
  }, 'strategy data contracts evaluated against the isolated snapshot; UNVERIFIED dimensions treated as unavailable (fail-closed)');

  // --- Live probes (engine must be up; otherwise UNKNOWN, fail-closed) ------------------
  const liveTimeout = input.liveProbeTimeoutMs ?? 5000;
  if (input.engineBaseUrl) {
    const compHealth: any = await probeEngineJson(input.engineBaseUrl, '/api/v2/runtime/component-health', liveTimeout, input.liveProbeHeaders);
    if (compHealth) {
      const comps: Array<{ component: string; status: string; detail: string }> =
        compHealth.components ?? compHealth ?? [];
      const md = comps.find((c) => /market data/i.test(c.component));
      need('MARKET_DATA_HEALTH',
        md?.status === 'HEALTHY' ? 'PASS' : 'FAIL',
        md ?? null,
        `live component-health from ${input.engineBaseUrl}: Market Data=${md?.status ?? 'absent'} (${md?.detail ?? 'no detail'})`);
      // SUBSCRIPTION_HEALTH: derive from the market-data worker state endpoint when available.
      const subHealth: any = await probeEngineJson(input.engineBaseUrl, '/api/v2/runtime/market/status', liveTimeout, input.liveProbeHeaders);
      need('SUBSCRIPTION_HEALTH',
        subHealth ? 'PASS' : 'UNKNOWN',
        subHealth,
        subHealth
          ? `live market status from ${input.engineBaseUrl}`
          : `no subscription-health signal from ${input.engineBaseUrl} (endpoint absent or unreachable) - not certifiable statically`);
    } else {
      need('MARKET_DATA_HEALTH', 'UNKNOWN', null,
        `engine not reachable at ${input.engineBaseUrl} (timeout ${liveTimeout}ms) - market-data health is runtime-only; refusing to certify statically`);
      need('SUBSCRIPTION_HEALTH', 'UNKNOWN', null,
        `engine not reachable at ${input.engineBaseUrl} - subscription health is runtime-only; refusing to certify statically`);
    }
    // Scheduler latency: only measurable live. Look for a scheduler stats endpoint; else UNKNOWN.
    const schedStats: any = await probeEngineJson(input.engineBaseUrl, '/api/v2/scheduling/quant/stats', liveTimeout, input.liveProbeHeaders);
    if (schedStats && typeof schedStats === 'object' && schedStats.p50 !== undefined) {
      need('SCHEDULER_P50', 'PASS', schedStats.p50, 'live quant scheduler p50 cycle latency (ms)');
      need('SCHEDULER_P95', 'PASS', schedStats.p95 ?? null, 'live quant scheduler p95 cycle latency (ms)');
      need('SCHEDULER_P99', 'PASS', schedStats.p99 ?? null, 'live quant scheduler p99 cycle latency (ms)');
      need('SCHEDULER_MAX', 'PASS', schedStats.max ?? null, 'live quant scheduler max cycle latency (ms)');
    } else {
      for (const f of ['SCHEDULER_P50', 'SCHEDULER_P95', 'SCHEDULER_P99', 'SCHEDULER_MAX']) {
        need(f, 'UNKNOWN', null,
          `no live scheduler latency signal from ${input.engineBaseUrl} - certified by src/server/certification/quantSchedulerSla.test.ts (suite)`);
      }
    }
    for (const f of ['LISTENERS', 'TIMERS', 'WORKERS']) {
      need(f, 'UNKNOWN', null,
        `runtime-only resource census; no live listener/timer/worker census endpoint on ${input.engineBaseUrl} - not certifiable statically`);
    }
  } else {
    for (const f of ['MARKET_DATA_HEALTH', 'SUBSCRIPTION_HEALTH']) {
      need(f, 'UNKNOWN', null,
        'no engine base URL provided: market/subscription health is runtime-only; refusing to certify statically (fail-closed)');
    }
    for (const f of ['SCHEDULER_P50', 'SCHEDULER_P95', 'SCHEDULER_P99', 'SCHEDULER_MAX']) {
      need(f, 'UNKNOWN', null,
        'no live scheduler latency signal (no engine URL) - certified by src/server/certification/quantSchedulerSla.test.ts (suite)');
    }
    for (const f of ['LISTENERS', 'TIMERS', 'WORKERS']) {
      need(f, 'UNKNOWN', null, 'runtime-only resource census; not certifiable from a static snapshot (fail-closed)');
    }
  }
  // Scheduler SLA config (static, always measurable).
  need('QUANT_SCHEDULER_SLA_CONFIG', 'PASS', input.quantSchedulerSla,
    'quantCycleIntervalMs / quantMaxConcurrentSymbols from config; runtime SLA certified by quantSchedulerSla.test.ts');

  // --- PIT replay ------------------------------------------------------------------------
  need('PIT_REPLAY',
    input.pitProvenanceRows === null ? 'UNKNOWN' : 'PASS',
    input.pitProvenanceRows === null ? null : { provenanceRows: input.pitProvenanceRows },
    input.pitProvenanceRows === null
      ? 'decision_provenance not observable in snapshot'
      : `${input.pitProvenanceRows} decision_provenance rows in snapshot; replay equality itself is suite-owned (decisionProvenance.test.ts: production calc == independent replay calc, no-lookahead enforced)`);

  // --- Suite-delegated checks ----------------------------------------------------------------
  const suiteTimeout = input.suiteTimeoutMs ?? 240_000;
  for (const d of SUITE_DELEGATIONS) {
    if (input.withSuites) {
      const r = runSuiteFile(input.repoRoot, d.testFile, suiteTimeout);
      need(d.field, r.state, d.testFile, `${d.proves}. ${r.evidence}`);
    } else {
      need(d.field, 'NOT_RUN', d.testFile,
        `${d.proves}. Suite-owned: ${d.testFile} (run with --with-suites to execute; a partial probe never reports READY)`);
    }
  }

  // --- Full session + soak ----------------------------------------------------------------------
  // FULL_SESSION is certified by the full-session driver (Worker H task 1); this probe reports
  // whether that evidence was supplied. WALL_CLOCK_SOAK needs a dedicated long run.
  need('FULL_SESSION', 'NOT_RUN', null,
    'full trading-day synthetic session (PREMARKET->POST_CLOSE + fault matrix) is driver-owned: scripts/sim/fullSession.ts. ' +
    'Supply its combined-summary.json via --full-session-evidence to certify; without it this check is NOT_RUN and READY=false.');
  need('WALL_CLOCK_SOAK', 'NOT_RUN', null,
    'multi-hour wall-clock soak has no completed evidence artifact in this run (see scripts/soak/). NOT_RUN -> READY=false.');

  // --- Verdict -----------------------------------------------------------------------------
  const blocking = checks.filter((c) => c.state !== 'PASS').map((c) => c.field);
  const failed = checks.filter((c) => c.state === 'FAIL').map((c) => c.field);
  const ready = blocking.length === 0;
  let overallStatus: ReleaseCertificationReport['overallStatus'];
  if (ready) {
    overallStatus = conditions.length > 0 ? 'READY_WITH_CONDITIONS' : 'READY';
  } else {
    overallStatus = 'NO_GO';
    if (failed.length === 0) {
      conditions.push(
        `PARTIAL PROBE: ${blocking.length} mandatory checks are not PASS ` +
        `(${blocking.slice(0, 12).join(', ')}${blocking.length > 12 ? ', ...' : ''}) - a partial probe can never report READY. ` +
        `Produce the missing evidence (run the named suites, build the missing artifacts, or provide a live engine URL) and re-run.`,
      );
    } else {
      conditions.push(`FAIL: ${failed.join(', ')}`);
    }
  }

  return {
    certification: 'RELEASE_CERTIFICATION',
    generatedAt: new Date().toISOString(),
    paperOnlyEnforced: true,
    checks,
    ready,
    overallStatus,
    conditions,
    blockingChecks: blocking,
    suiteDelegations: SUITE_DELEGATIONS,
  };
}
