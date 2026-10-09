/**
 * Operator readiness extension routes (Mission Parts 56-57, 2026-10-07).
 *
 * - GET /api/v2/readiness/checklist          (Part 56: `argus readiness`)
 * - GET /api/v2/readiness/session-checkpoint (Part 57: `argus session-checkpoint`)
 * Both support ?format=text for operator/cron consumption, else JSON.
 *
 * READ-ONLY. This file never arms LIVE, never changes trading state, never adjusts a
 * threshold, gate, or policy, never places or blocks an order, never writes the DB.
 * Every check is an observation composed from existing read-only report builders
 * (TradingReadinessGate, liveReadinessEngine, aiQuantAvailability, AIProviderHealthCheck,
 * aiCostGovernorReport, marketDataReadiness, processTelemetry, ObservabilityStore/
 * ObservabilityMetrics) plus cheap filesystem/SQLite introspection. AI checks are
 * advisory only: AI down can never fail quant readiness (quant-first).
 *
 * Classification bands (disk free %, DB/WAL size, event-loop lag, queue depth) live in
 * config/operatorReadiness.json per the repo's no-hardcoded-thresholds rule; the memory
 * check reuses processTelemetry.classifyRss() and config/observability.json's
 * evidence-labeled RSS bands. This module never imports BrokerManager (kept out of
 * architecture.protection.test.ts's allowlist on purpose) — broker evidence comes via
 * TradingReadinessGate's own node.
 */
import { Router } from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getTradingReadinessSnapshot, type TradingReadinessSnapshot } from '../core/TradingReadinessGate';
import { evaluateLiveReadiness } from '../core/liveReadinessEngine';
import { resolveEnvTradingMode, isPaperTradingOnlyEnforced } from '../core/tradingModeEnv';
import { readEnginePid, isPidAlive } from '../app/enginePid';
import { getPipelineAgentSnapshot } from '../core/pipelineAgentSnapshot';
import { getAIProviderHealthSnapshot } from '../ai/AIProviderHealthCheck';
import { computeAiAvailability, computeQuantAvailability } from '../core/aiQuantAvailability';
import { buildAiCostGovernorReport } from '../observability/aiCostGovernorReport';
import { getMarketDataReadiness } from '../core/marketDataReadiness';
import { getProcessTelemetrySamples, getMetric } from '../observability/ObservabilityMetrics';
import { classifyRss } from '../observability/processTelemetry';
import { observabilityQueueLengthForTests } from '../observability/ObservabilityStore';
import { observabilityConfig } from '../config/observability';
import { isQuantPolicyEnabled } from '../config/quantDecisionPolicy';
import { buildQuantReadinessReport } from './v2Diagnostics';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { latestCycleIsMatch } from '../services/reconciliationOperatorSnapshot';
import { argusApplication } from '../app/ArgusApplication';
import { db, sqliteDb, dbPath } from '../db';
import * as schema from '../db/schema';
import { desc } from 'drizzle-orm';
import { buildSessionCheckpoint, formatSessionCheckpointText } from '../observability/sessionCheckpoint';

export type ReadinessStatus = 'PASS' | 'WARN' | 'FAIL';
export type ReadinessVerdict = 'READY' | 'READY_WITH_WARNINGS' | 'NOT_READY';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** Advisory checks (AI layer) inform the operator but describe a subsystem whose
   *  absence must never block quant readiness. Still surfaced as WARN, never FAIL. */
  advisory?: boolean;
}

export interface ReadinessChecklist {
  generatedAt: string;
  sha: string | null;
  verdict: ReadinessVerdict;
  checks: ReadinessCheck[];
}

interface OperatorReadinessBands {
  eventLoopLagWarnP95Ms: number;
  eventLoopLagWarnMeanMs: number;
  diskWarnFreePct: number;
  diskCriticalFreePct: number;
  dbSizeWarnMb: number;
  walSizeWarnMb: number;
  observabilityQueueWarnFraction: number;
}

const DEFAULT_BANDS: OperatorReadinessBands = {
  eventLoopLagWarnP95Ms: 500,
  eventLoopLagWarnMeanMs: 200,
  diskWarnFreePct: 15,
  diskCriticalFreePct: 5,
  dbSizeWarnMb: 4096,
  walSizeWarnMb: 256,
  observabilityQueueWarnFraction: 0.5,
};

function loadBands(): OperatorReadinessBands {
  try {
    const raw = loadRepoConfigJson<Partial<OperatorReadinessBands>>('operatorReadiness.json');
    return { ...DEFAULT_BANDS, ...raw };
  } catch {
    return DEFAULT_BANDS;
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function pass(id: string, label: string, detail: string): ReadinessCheck {
  return { id, label, status: 'PASS', detail };
}
function warn(id: string, label: string, detail: string, advisory = false): ReadinessCheck {
  return { id, label, status: 'WARN', detail, ...(advisory ? { advisory: true as const } : {}) };
}
function fail(id: string, label: string, detail: string): ReadinessCheck {
  return { id, label, status: 'FAIL', detail };
}

/** Pure verdict computation — exported for unit tests. */
export function computeReadinessVerdict(checks: ReadinessCheck[]): ReadinessVerdict {
  if (checks.some((c) => c.status === 'FAIL')) return 'NOT_READY';
  if (checks.some((c) => c.status === 'WARN')) return 'READY_WITH_WARNINGS';
  return 'READY';
}

function checkRunningSha(): ReadinessCheck {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) {
      return pass('sha', 'Running SHA', `${sha.slice(0, 12)} (${sha})`);
    }
    return warn('sha', 'Running SHA', `git rev-parse HEAD returned unparseable output: ${sha.slice(0, 64)}`);
  } catch (e: unknown) {
    return warn('sha', 'Running SHA', `git rev-parse HEAD unavailable (${errMsg(e)}) — cannot verify which commit is running`);
  }
}

function checkSchemaMigrations(): ReadinessCheck {
  let journalEntries = 0;
  let latestTag: string | null = null;
  try {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), 'drizzle', 'meta', '_journal.json'), 'utf8'),
    ) as { entries?: Array<{ tag?: string }> };
    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    journalEntries = entries.length;
    latestTag = entries.length > 0 ? entries[entries.length - 1]?.tag ?? null : null;
  } catch {
    journalEntries = 0;
  }
  let applied: number | null = null;
  try {
    const row = sqliteDb.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as
      | { n: number }
      | undefined;
    applied = typeof row?.n === 'number' ? row.n : null;
  } catch (e: unknown) {
    return fail('schema', 'Schema / migrations', `migration table unreadable: ${errMsg(e)}`);
  }
  if (applied === null) return fail('schema', 'Schema / migrations', 'migration count query returned no rows');
  const tagPart = latestTag ? `, latest tag ${latestTag}` : '';
  if (journalEntries > 0 && applied < journalEntries) {
    return fail(
      'schema',
      'Schema / migrations',
      `migrations behind: ${applied} applied but journal expects ${journalEntries}${tagPart}`,
    );
  }
  if (journalEntries === 0) {
    return warn('schema', 'Schema / migrations', `${applied} migrations applied (journal unreadable — latest tag unverified)`);
  }
  return pass('schema', 'Schema / migrations', `${applied}/${journalEntries} applied${tagPart}`);
}

function checkTradingMode(): ReadinessCheck {
  try {
    const { mode, source } = resolveEnvTradingMode();
    if (mode === 'PAPER') return pass('tradingMode', 'Trading mode', `mode=PAPER (source: ${source})`);
    return fail('tradingMode', 'Trading mode', `mode=${mode} (source: ${source}) — readiness requires PAPER`);
  } catch (e: unknown) {
    return fail('tradingMode', 'Trading mode', `could not resolve trading mode: ${errMsg(e)}`);
  }
}

function checkLiveNoGo(): ReadinessCheck {
  try {
    const report = evaluateLiveReadiness();
    if (report.result === 'LIVE_NO_GO') {
      return pass('liveNoGo', 'LIVE_NO_GO', `evaluateLiveReadiness() = LIVE_NO_GO (${report.failedMandatory.length} failed mandatory gates)`);
    }
    return fail('liveNoGo', 'LIVE_NO_GO', `evaluateLiveReadiness() = ${report.result} — live is not NO_GO`);
  } catch (e: unknown) {
    return fail('liveNoGo', 'LIVE_NO_GO', `live readiness evaluation failed: ${errMsg(e)}`);
  }
}

function checkSingleEngine(): ReadinessCheck {
  try {
    const claimed = readEnginePid();
    if (claimed === null) return pass('singleEngine', 'Single engine', 'no engine pid claim file — no competing claim');
    if (claimed === process.pid) return pass('singleEngine', 'Single engine', `pid claim ${claimed} = this process`);
    if (isPidAlive(claimed)) {
      return fail(
        'singleEngine',
        'Single engine',
        `ANOTHER LIVE ENGINE holds the pid claim (pid ${claimed} alive; this process is ${process.pid})`,
      );
    }
    return warn('singleEngine', 'Single engine', `stale pid claim file (pid ${claimed} not alive)`);
  } catch (e: unknown) {
    return warn('singleEngine', 'Single engine', `pid claim unreadable: ${errMsg(e)}`);
  }
}

function checkBroker(snapshot: TradingReadinessSnapshot): ReadinessCheck {
  const node = snapshot.nodes.find((n) => n.id === 'broker');
  if (!node) return warn('broker', 'Broker', 'broker readiness node missing from TradingReadinessGate snapshot');
  if (node.ready) return pass('broker', 'Broker', node.detail);
  return fail('broker', 'Broker', node.detail);
}

function checkMarketData(snapshot: TradingReadinessSnapshot): ReadinessCheck {
  const node = snapshot.nodes.find((n) => n.id === 'marketData');
  let freshness = '';
  try {
    const md = getMarketDataReadiness();
    freshness = ` — ${md.detail}`;
    if (node?.ready && md.ready) return pass('marketData', 'Market data', `${node.detail}${freshness}`);
  } catch {
    /* fall through to snapshot-only verdict */
  }
  if (node?.ready) return pass('marketData', 'Market data', node.detail);
  // Stale/degraded market data is WARN (explicit Part 56 contract), never FAIL.
  return warn('marketData', 'Market data', `${node?.detail ?? 'no market-data node'}${freshness}`);
}

function checkTradingState(snapshot: TradingReadinessSnapshot): ReadinessCheck {
  try {
    const pipeline = getPipelineAgentSnapshot();
    const state = pipeline.tradingState ?? 'UNKNOWN';
    if (state === 'TRADING_ENABLED') return pass('tradingState', 'Trading state', 'TRADING_ENABLED');
    const entry = snapshot.nodes.find((n) => n.id === 'entryGeneration');
    const context = entry ? ` — ${entry.detail}` : '';
    // A paused state is operator-fixable and expected to block entries; it is a warning on
    // a pre-session checklist, not a hard failure (FAIL set is explicit in the contract).
    return warn('tradingState', 'Trading state', `${state}${context}`);
  } catch (e: unknown) {
    return warn('tradingState', 'Trading state', `trading state unreadable: ${errMsg(e)}`);
  }
}

async function checkReconciliation(): Promise<ReadinessCheck> {
  try {
    const [latest] = await db
      .select()
      .from(schema.reconciliationEvents)
      .orderBy(desc(schema.reconciliationEvents.id))
      .limit(1);
    if (!latest) return warn('reconciliation', 'Reconciliation', 'no reconciliation cycles recorded yet');
    if (latestCycleIsMatch(latest)) return pass('reconciliation', 'Reconciliation', 'latest cycle MATCH, no mismatches');
    let mismatchCount = 0;
    try {
      mismatchCount = JSON.parse(String(latest.mismatches ?? '[]')).length;
    } catch {
      mismatchCount = 0;
    }
    return warn('reconciliation', 'Reconciliation', `latest cycle MISMATCH (${mismatchCount} mismatch row(s)) — see argus reconciliation-status`);
  } catch (e: unknown) {
    return warn('reconciliation', 'Reconciliation', `reconciliation history unreadable: ${errMsg(e)}`);
  }
}

async function checkPositionsOrders(): Promise<ReadinessCheck> {
  let positions = 0;
  try {
    const holdings = await argusApplication.positions();
    positions = Array.isArray(holdings) ? holdings.length : 0;
  } catch (e: unknown) {
    return warn('positionsOrders', 'Positions / orders', `position snapshot unreadable: ${errMsg(e)}`);
  }
  let tradesToday: number | null = null;
  try {
    const row = sqliteDb
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE substr(timestamp, 1, 10) = date('now')")
      .get() as { n: number } | undefined;
    tradesToday = typeof row?.n === 'number' ? row.n : null;
  } catch {
    tradesToday = null;
  }
  return pass(
    'positionsOrders',
    'Positions / orders',
    `open positions: ${positions}, trades recorded today (UTC): ${tradesToday === null ? 'unknown' : tradesToday}`,
  );
}

export async function checkStrategyAuthorization(): Promise<ReadinessCheck> {
  try {
    const policyOn = isQuantPolicyEnabled();
    const paperOnly = isPaperTradingOnlyEnforced();
    if (!policyOn) return warn('strategyAuthorization', 'Strategy authorization', 'quant execution policy disabled — consensus path only (quant-first degraded)');
    if (paperOnly) {
      const report = await buildQuantReadinessReport();
      if (report.summary.authorizedQuantPolicy === 0) {
        return fail('strategyAuthorization', 'Strategy authorization',
          `QUANT_FIRST_OPERATIONALLY_INACTIVE: no strategy has quant-policy authority; missing lifecycle=${report.summary.notAuthorizedMissingLifecycle}, ineligible=${report.summary.notEligible}, consensus-only=${report.summary.requiresConsensus}`);
      }
      return pass('strategyAuthorization', 'Strategy authorization',
        `quant-policy authority present: ${report.summary.quantPolicyEligibleIds.join(', ')}; signal, data, calibration and risk eligibility require separate checks`);
    }
    return warn('strategyAuthorization', 'Strategy authorization', 'paper-only lock NOT enforced — quant authorization will fail closed');
  } catch (e: unknown) {
    return warn('strategyAuthorization', 'Strategy authorization', `authorization config unreadable: ${errMsg(e)}`);
  }
}

async function checkQuantPolicy(): Promise<ReadinessCheck> {
  try {
    const q = await computeQuantAvailability();
    if (q.state === 'QUANT_HEALTHY') return pass('quantPolicy', 'Quant policy', q.detail ?? 'QUANT_HEALTHY');
    return warn('quantPolicy', 'Quant policy', `${q.state}${q.detail ? ` — ${q.detail}` : ''}`);
  } catch (e: unknown) {
    return warn('quantPolicy', 'Quant policy', `quant availability unreadable: ${errMsg(e)}`);
  }
}

async function checkAiOptionality(): Promise<ReadinessCheck> {
  try {
    const a = await computeAiAvailability();
    const detail = `${a.state}: ${a.healthyProviderCount}/${a.registeredProviderCount} providers healthy — advisory only, quant unaffected`;
    if (a.state === 'AI_HEALTHY') return pass('aiOptionality', 'AI optionality', detail);
    // AI down/degraded is WARN + advisory: it must never fail quant readiness (quant-first).
    return warn('aiOptionality', 'AI optionality', detail, true);
  } catch (e: unknown) {
    return warn('aiOptionality', 'AI optionality', `AI availability unreadable (${errMsg(e)}) — advisory only`, true);
  }
}

async function checkJevHealth(): Promise<ReadinessCheck> {
  try {
    const providers = await getAIProviderHealthSnapshot();
    const jev = providers.filter(
      (p) => /jev/i.test(p.providerId) || /jev/i.test(p.providerName),
    );
    if (jev.length === 0) return warn('jevHealth', 'Jev health', 'Jev provider not registered — advisory only', true);
    const healthy = jev.filter((p) => p.status === 'HEALTHY');
    const detail = jev.map((p) => `${p.providerId}:${p.status}`).join(', ');
    if (healthy.length === jev.length) return pass('jevHealth', 'Jev health', detail);
    return warn('jevHealth', 'Jev health', `${detail} — advisory only`, true);
  } catch (e: unknown) {
    return warn('jevHealth', 'Jev health', `Jev health unreadable (${errMsg(e)}) — advisory only`, true);
  }
}

async function checkAiGovernor(): Promise<ReadinessCheck> {
  try {
    const r = await buildAiCostGovernorReport();
    const detail = `enabled=${r.enabled}, ${Object.keys(r.ledger).length} provider bucket(s), ${r.recentShadowDecisions.length} recent shadow decision(s)`;
    if (r.enabled) return pass('aiGovernor', 'AI governor', detail);
    return warn('aiGovernor', 'AI governor', `AI cost governor disabled — ${detail}`);
  } catch (e: unknown) {
    return warn('aiGovernor', 'AI governor', `AI governor report failed: ${errMsg(e)}`);
  }
}

function checkQueues(bands: OperatorReadinessBands): ReadinessCheck {
  let pending = 0;
  try {
    // Read-only queue.length accessor; the ForTests suffix is historical (no production
    // accessor exists and this module must not change observability plumbing).
    pending = observabilityQueueLengthForTests();
  } catch {
    pending = 0;
  }
  let dropped = 0;
  try {
    dropped = getMetric('events_dropped_queue_full');
  } catch {
    dropped = 0;
  }
  const maxQueue = observabilityConfig.maxQueueSize;
  const warnAt = Math.floor(maxQueue * bands.observabilityQueueWarnFraction);
  const detail = `observability events pending ${pending}/${maxQueue} (warn at ${warnAt}), dropped-queue-full ${dropped}`;
  if (dropped > 0) return warn('queues', 'Queues', `${detail} — events are being dropped`);
  if (pending > warnAt) return warn('queues', 'Queues', `${detail} — backlog deep`);
  return pass('queues', 'Queues', detail);
}

function checkDisk(bands: OperatorReadinessBands): ReadinessCheck {
  try {
    const dataDir = join(process.cwd(), 'data');
    const st = statfsSync(existsSync(dataDir) ? dataDir : process.cwd());
    const totalGb = (st.blocks * st.bsize) / 1073741824;
    const freeGb = (st.bfree * st.bsize) / 1073741824;
    const freePct = st.blocks > 0 ? (st.bfree / st.blocks) * 100 : 0;
    const detail = `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(1)} GB (${freePct.toFixed(1)}%)`;
    if (freePct < bands.diskCriticalFreePct) return fail('disk', 'Disk space', `DISK CRITICAL — ${detail}`);
    if (freePct < bands.diskWarnFreePct) return warn('disk', 'Disk space', `disk low — ${detail}`);
    return pass('disk', 'Disk space', detail);
  } catch (e: unknown) {
    return warn('disk', 'Disk space', `disk stats unreadable: ${errMsg(e)}`);
  }
}

function checkDbSize(bands: OperatorReadinessBands): ReadinessCheck {
  try {
    const pageCount = (sqliteDb.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count;
    const pageSize = (sqliteDb.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size;
    if (typeof pageCount !== 'number' || typeof pageSize !== 'number') {
      return warn('db', 'DB size', 'PRAGMA page_count/page_size returned no rows');
    }
    const mb = (pageCount * pageSize) / 1048576;
    // DEF-6 closure: DB growth is now monitored on every readiness run.
    const detail = `${mb.toFixed(1)} MB (${pageCount.toLocaleString('en-US')} pages × ${pageSize} B)`;
    if (mb > bands.dbSizeWarnMb) return warn('db', 'DB size', `${detail} — above ${bands.dbSizeWarnMb} MB watch band`);
    return pass('db', 'DB size', detail);
  } catch (e: unknown) {
    return fail('db', 'DB size', `DB unreachable: ${errMsg(e)}`);
  }
}

function checkWal(bands: OperatorReadinessBands): ReadinessCheck {
  try {
    const walPath = `${dbPath}-wal`;
    if (!existsSync(walPath)) return pass('wal', 'WAL', 'no WAL file — fully checkpointed');
    const mb = statSync(walPath).size / 1048576;
    if (mb > bands.walSizeWarnMb) {
      return warn('wal', 'WAL', `${mb.toFixed(1)} MB — above ${bands.walSizeWarnMb} MB band, checkpoint may be lagging`);
    }
    return pass('wal', 'WAL', `${mb.toFixed(1)} MB`);
  } catch (e: unknown) {
    return warn('wal', 'WAL', `WAL stat failed: ${errMsg(e)}`);
  }
}

function checkMemory(): ReadinessCheck {
  try {
    const samples = getProcessTelemetrySamples();
    const latest = samples.length > 0 ? samples[samples.length - 1] : null;
    const mem = process.memoryUsage();
    const rssMb = latest && typeof latest.rss === 'number' ? latest.rss / 1048576 : mem.rss / 1048576;
    const heapMb = mem.heapUsed / 1048576;
    // Reuses the evidence-labeled bands in config/observability.json (no new thresholds).
    const level = classifyRss(rssMb);
    const detail = `rss ${rssMb.toFixed(0)} MB, heap used ${heapMb.toFixed(0)} MB (telemetry: ${level})`;
    if (level === 'CRITICAL' || level === 'WARNING') return warn('memory', 'Memory', detail);
    return pass('memory', 'Memory', detail);
  } catch (e: unknown) {
    return warn('memory', 'Memory', `memory telemetry unreadable: ${errMsg(e)}`);
  }
}

function checkEventLoop(bands: OperatorReadinessBands): ReadinessCheck {
  try {
    const samples = getProcessTelemetrySamples();
    const latest = samples.length > 0 ? samples[samples.length - 1] : null;
    if (!latest || typeof latest.eventLoopDelayMs !== 'number') {
      return warn('eventLoop', 'Event loop', 'no event-loop telemetry samples yet (processTelemetry not warmed up)');
    }
    const mean = latest.eventLoopDelayMs;
    const p95 = typeof latest.eventLoopDelayP95Ms === 'number' ? latest.eventLoopDelayP95Ms : null;
    const detail = `mean ${mean.toFixed(1)} ms${p95 !== null ? `, p95 ${p95.toFixed(1)} ms` : ''} (bands: mean ${bands.eventLoopLagWarnMeanMs} ms, p95 ${bands.eventLoopLagWarnP95Ms} ms)`;
    if ((p95 !== null && p95 > bands.eventLoopLagWarnP95Ms) || mean > bands.eventLoopLagWarnMeanMs) {
      return warn('eventLoop', 'Event loop', `event-loop lag elevated — ${detail}`);
    }
    return pass('eventLoop', 'Event loop', detail);
  } catch (e: unknown) {
    return warn('eventLoop', 'Event loop', `event-loop telemetry unreadable: ${errMsg(e)}`);
  }
}

/**
 * Trade-plan pipeline health (defect #6 split, 2026-10-08): is the premarket
 * trade-plan pipeline running and producing? Evidence is the pipeline's OWN
 * ledger (trade_plans) — never the focus-report table, so a missing report
 * cannot masquerade as a dead pipeline. Independent of checkPremarketFocusReport.
 */
async function checkTradePlanPipeline(): Promise<ReadinessCheck> {
  const id = 'tradePlanPipeline';
  const label = 'Trade-plan pipeline';
  try {
    const {
      gatherTradePlanPipelineEvidence,
      evaluateTradePlanPipeline,
      premarketRefreshWindows,
    } = await import('../premarket/premarketReadiness');
    const evidence = await gatherTradePlanPipelineEvidence();
    const result = evaluateTradePlanPipeline(evidence, new Date(), premarketRefreshWindows());
    if (result.status === 'PASS') return pass(id, label, result.detail);
    if (result.status === 'FAIL') return fail(id, label, result.detail);
    return warn(id, label, result.detail);
  } catch (e: unknown) {
    return warn(id, label, `pipeline ledger unreadable: ${errMsg(e)}`);
  }
}

/**
 * Premarket focus-report health (defect #6 split, 2026-10-08): was a focus
 * report produced for the latest completed refresh? Evidence is the
 * premarket_focus_reports table vs the pipeline's latest completed refresh
 * version. A missing/stale report is WARN (observability, never a trading
 * gate) and is independent of checkTradePlanPipeline — a stalled pipeline
 * cannot masquerade as a missing report either.
 */
async function checkPremarketFocusReport(): Promise<ReadinessCheck> {
  const id = 'premarketFocusReport';
  const label = 'Premarket focus report';
  try {
    const { gatherFocusReportEvidence, evaluateFocusReportHealth } =
      await import('../premarket/premarketReadiness');
    const evidence = await gatherFocusReportEvidence();
    const result = evaluateFocusReportHealth(evidence);
    if (result.status === 'PASS') return pass(id, label, result.detail);
    return warn(id, label, result.detail);
  } catch (e: unknown) {
    return warn(id, label, `focus report table unreadable: ${errMsg(e)}`);
  }
}

/** Build the full pre-session checklist. Read-only. */
export async function buildReadinessChecklist(): Promise<ReadinessChecklist> {
  const bands = loadBands();
  let sha: string | null = null;
  const shaCheck = checkRunningSha();
  if (shaCheck.status === 'PASS') {
    const m = shaCheck.detail.match(/\(([0-9a-f]{40})\)/i);
    sha = m ? m[1] : null;
  }

  // TradingReadinessGate's snapshot already covers process/database/market-data/broker/
  // entry-generation/technical/quant as independent nodes — reuse, don't re-derive.
  let snapshot: TradingReadinessSnapshot | null = null;
  try {
    snapshot = await getTradingReadinessSnapshot();
  } catch (e: unknown) {
    snapshot = null;
    void e;
  }

  const checks: ReadinessCheck[] = [shaCheck];
  checks.push(checkSchemaMigrations());
  checks.push(checkTradingMode());
  checks.push(checkLiveNoGo());
  checks.push(checkSingleEngine());
  if (snapshot) {
    checks.push(checkBroker(snapshot));
    checks.push(checkMarketData(snapshot));
    checks.push(checkTradingState(snapshot));
  } else {
    checks.push(fail('broker', 'Broker', 'TradingReadinessGate snapshot unavailable — cannot verify broker'));
    checks.push(warn('marketData', 'Market data', 'TradingReadinessGate snapshot unavailable'));
    checks.push(warn('tradingState', 'Trading state', 'TradingReadinessGate snapshot unavailable'));
  }
  checks.push(await checkReconciliation());
  checks.push(await checkPositionsOrders());
  checks.push(await checkStrategyAuthorization());
  checks.push(await checkQuantPolicy());
  checks.push(await checkAiOptionality());
  checks.push(await checkJevHealth());
  checks.push(await checkAiGovernor());
  checks.push(checkQueues(bands));
  checks.push(checkDisk(bands));
  checks.push(checkDbSize(bands));
  checks.push(checkWal(bands));
  checks.push(checkMemory());
  checks.push(checkEventLoop(bands));
  checks.push(await checkTradePlanPipeline());
  checks.push(await checkPremarketFocusReport());

  return {
    generatedAt: new Date().toISOString(),
    sha,
    verdict: computeReadinessVerdict(checks),
    checks,
  };
}

/** Text renderer for operator/cron runs. Pure. */
export function formatReadinessChecklistText(c: ReadinessChecklist): string {
  const tag = (s: ReadinessStatus): string => (s === 'PASS' ? '[PASS]' : s === 'WARN' ? '[WARN]' : '[FAIL]');
  const nFail = c.checks.filter((x) => x.status === 'FAIL').length;
  const nWarn = c.checks.filter((x) => x.status === 'WARN').length;
  const lines = [
    'ARGUS PRE-SESSION READINESS CHECKLIST',
    '=====================================',
    `Generated: ${c.generatedAt}`,
    `Running SHA: ${c.sha ? c.sha.slice(0, 12) : 'unknown'}`,
    '',
    ...c.checks.map(
      (x) => `${tag(x.status)} ${x.id.padEnd(22)}${x.advisory ? '(advisory) ' : ''}${x.detail}`,
    ),
    '',
    `VERDICT: ${c.verdict} (${nFail} fail, ${nWarn} warn, ${c.checks.length} checks)`,
    'Read-only diagnostic. AI checks are advisory only — AI down never fails quant readiness.',
  ];
  return lines.join('\n');
}

export const readinessExtRouter = Router();

readinessExtRouter.get('/checklist', async (req, res) => {
  try {
    const checklist = await buildReadinessChecklist();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatReadinessChecklistText(checklist));
      return;
    }
    res.json({ ok: true, ...checklist, live: 'NO-GO' });
  } catch (e: unknown) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: errMsg(e) });
  }
});

readinessExtRouter.get('/session-checkpoint', async (req, res) => {
  try {
    const report = await buildSessionCheckpoint();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatSessionCheckpointText(report));
      return;
    }
    res.json({ ok: true, ...report, live: 'NO-GO' });
  } catch (e: unknown) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: errMsg(e) });
  }
});
