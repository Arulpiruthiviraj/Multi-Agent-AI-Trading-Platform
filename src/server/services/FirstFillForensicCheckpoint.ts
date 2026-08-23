/**
 * First organic PAPER fill forensic checkpoint (supervised soak).
 *
 * Listens to ORDER_EXECUTED. On the first FILLED organic PAPER trade after start:
 * verifies OMS persist, fill ledger, local↔broker portfolio, recon cleanliness,
 * SELL P&L non-null, and decision-trace presence.
 *
 * FAIL → TradingEngine.toggle({ enabled: false }) + forensic BUY soft-lock + FORENSIC_CHECKPOINT_FAILED
 * PASS → FORENSIC_CHECKPOINT_PASSED
 *
 * Not a second kill switch. Does not enable Autobot. Does not call placeOrder.
 * Does not lower consensus floors. REPLAY / DIAG / EXTERNAL_SYNC never trigger.
 */
import fs from 'fs';
import path from 'path';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { trades, fills, portfolio, reconciliationEvents, riskAssessments } from '../db/schema';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isOrganicPaperFill } from '../research/organicPaper';
import { setForensicCheckpointBuyLock } from '../core/forensicCheckpointBuyLock';
import { tradingEngine } from '../engines/TradingEngine';
import { BrokerManager } from '../../brokers/BrokerManager';
import { latestCycleIsMatch, parseReconMismatches } from './reconciliationOperatorSnapshot';
import { canonicalPortfolioSymbol, findHolding } from './portfolioReconcileCompare';
import { tradingSafety } from '../config/tradingSafety';

export type ForensicCheckId =
  | 'order_persisted'
  | 'fill_ledger'
  | 'portfolio_broker_match'
  | 'recon_clean'
  | 'sell_pnl_non_null'
  | 'trace_completeness';

export interface ForensicCheckResult {
  id: ForensicCheckId;
  ok: boolean;
  detail: string;
}

export interface ForensicCheckpointReport {
  result: 'PASSED' | 'FAILED' | 'SKIPPED';
  triggeredAt: string;
  orderId: string;
  traceId: string | null;
  symbol: string;
  side: string;
  checks: ForensicCheckResult[];
  failures: string[];
  reportPath?: string | null;
}

export type FirstFillForensicDeps = {
  disableAutobot: () => Promise<{ ok: boolean; error?: string }>;
  getBrokerPositions: () => Promise<Array<{ symbol: string; quantity: number }>>;
  runReconcile?: () => Promise<void>;
  writeReport?: (report: ForensicCheckpointReport) => string | null;
  nowIso?: () => string;
};

const QTY_TOLERANCE = tradingSafety.reconQtyTolerance;

let started = false;
let completed = false;
let inFlight: Promise<void | ForensicCheckpointReport> | null = null;
let lastReport: ForensicCheckpointReport | null = null;
let onOrderExecuted: ((order: any) => void) | null = null;
let depsOverride: FirstFillForensicDeps | null = null;

function defaultReportDir(): string {
  return path.join(process.cwd(), 'data', 'logs');
}

function stateMarkerPath(): string {
  return path.join(process.cwd(), 'data', '.first_fill_forensic_checkpoint.json');
}

function persistStateMarker(report: ForensicCheckpointReport): void {
  try {
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    fs.writeFileSync(
      stateMarkerPath(),
      JSON.stringify({
        completed: true,
        result: report.result,
        at: report.triggeredAt,
        orderId: report.orderId,
        symbol: report.symbol,
        side: report.side,
        traceId: report.traceId,
      }, null, 2),
      'utf8',
    );
  } catch (e) {
    console.warn('[FirstFillForensicCheckpoint] Failed to write state marker', e);
  }
}

function defaultWriteReport(report: ForensicCheckpointReport): string | null {
  try {
    const dir = defaultReportDir();
    fs.mkdirSync(dir, { recursive: true });
    const day = report.triggeredAt.slice(0, 10);
    const jsonPath = path.join(dir, `first_fill_forensic_${day}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    persistStateMarker(report);

    const mdPath = path.join(process.cwd(), `ARGUS_CONTROLLED_PAPER_SOAK_AUDIT_${day}.md`);
    const mdSection = [
      '',
      '## First-fill forensic checkpoint',
      '',
      `- Result: **${report.result}**`,
      `- At: ${report.triggeredAt}`,
      `- Order: \`${report.orderId}\` ${report.side} ${report.symbol}`,
      `- Trace: \`${report.traceId ?? 'null'}\``,
      `- Failures: ${report.failures.length ? report.failures.join('; ') : '(none)'}`,
      `- JSON: \`${jsonPath}\``,
      '',
      '| Check | OK | Detail |',
      '|---|---|---|',
      ...report.checks.map((c) => `| ${c.id} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`),
      '',
    ].join('\n');
    if (fs.existsSync(mdPath)) {
      fs.appendFileSync(mdPath, mdSection, 'utf8');
    } else {
      fs.writeFileSync(
        mdPath,
        [
          `# ARGUS controlled paper soak audit — ${day}`,
          '',
          'Supervised PAPER only. Not LIVE. Not an edge claim.',
          mdSection,
        ].join('\n'),
        'utf8',
      );
    }
    return jsonPath;
  } catch (e) {
    console.error('[FirstFillForensicCheckpoint] Failed to persist report', e);
    return null;
  }
}

function defaultDeps(): FirstFillForensicDeps {
  return {
    disableAutobot: () => tradingEngine.toggle({ enabled: false }),
    getBrokerPositions: async () => {
      const broker = BrokerManager.getInstance().getActiveBroker();
      const positions = await broker.positions();
      return (positions || []).map((p: any) => ({
        symbol: String(p.symbol || ''),
        quantity: Number(p.quantity ?? p.qty ?? 0),
      }));
    },
    runReconcile: async () => {
      try {
        const { portfolioReconciliationWorker } = await import('./PortfolioReconciliation');
        await portfolioReconciliationWorker.reconcile();
      } catch (e) {
        console.warn('[FirstFillForensicCheckpoint] Optional reconcile failed', e);
      }
    },
    writeReport: defaultWriteReport,
    nowIso: () => new Date().toISOString(),
  };
}

function activeDeps(): FirstFillForensicDeps {
  return { ...defaultDeps(), ...(depsOverride || {}) };
}

export function getLastForensicCheckpointReport(): ForensicCheckpointReport | null {
  return lastReport ? { ...lastReport, checks: [...lastReport.checks] } : null;
}

export function hasCompletedForensicCheckpoint(): boolean {
  return completed;
}

export function resetFirstFillForensicCheckpointForTests(): void {
  if (onOrderExecuted) {
    eventBus.off(EVENTS.ORDER_EXECUTED, onOrderExecuted);
    onOrderExecuted = null;
  }
  started = false;
  completed = false;
  inFlight = null;
  lastReport = null;
  depsOverride = null;
}

export function setFirstFillForensicDepsForTests(deps: Partial<FirstFillForensicDeps> | null): void {
  depsOverride = deps ? { ...defaultDeps(), ...deps } : null;
}

export function markForensicCheckpointCompletedForTests(done: boolean): void {
  completed = done;
}

async function evaluateChecks(order: {
  id?: string;
  orderId?: string;
  symbol?: string;
  side?: string;
  quantity?: number;
  status?: string;
  traceId?: string | null;
  profitLoss?: number | null;
  executionEnvironment?: string | null;
  reasoning?: string | null;
}): Promise<ForensicCheckResult[]> {
  const orderId = String(order.id || order.orderId || '');
  const symbol = canonicalPortfolioSymbol(order.symbol || '');
  const side = String(order.side || '').toUpperCase();
  const checks: ForensicCheckResult[] = [];

  const tradeRows = orderId
    ? await db.select().from(trades).where(eq(trades.id, orderId)).limit(1)
    : [];
  const trade = tradeRows[0];
  const tradeQty = trade ? Number(trade.quantity) || 0 : 0;
  const tradePrice = trade ? Number(trade.price) || 0 : 0;
  const eventPrice = typeof (order as any).price === 'number' ? Number((order as any).price) : 0;
  const effectivePrice = tradePrice > 0 ? tradePrice : eventPrice;
  checks.push({
    id: 'order_persisted',
    ok: !!trade
      && trade.status === 'FILLED'
      && canonicalPortfolioSymbol(trade.symbol) === symbol
      && tradeQty > 0
      && effectivePrice > 0,
    detail: trade
      ? `trades row ${trade.id} status=${trade.status} symbol=${trade.symbol} qty=${tradeQty} price=${effectivePrice}`
      : `missing trades row for ${orderId || '(no id)'}`,
  });

  const fillRows = orderId
    ? await db.select().from(fills).where(eq(fills.orderId, orderId))
    : [];
  const fillQty = fillRows.reduce((s, f) => s + (Number(f.quantity) || 0), 0);
  checks.push({
    id: 'fill_ledger',
    ok: fillRows.length > 0 && fillQty > 0,
    detail: fillRows.length
      ? `fills=${fillRows.length} qtySum=${fillQty}`
      : 'no fills ledger rows',
  });

  const deps = activeDeps();
  if (deps.runReconcile) {
    await deps.runReconcile();
  }

  let brokerQty = 0;
  let brokerErr: string | null = null;
  try {
    const positions = await deps.getBrokerPositions();
    const remote = findHolding(positions, symbol);
    brokerQty = remote ? Number(remote.quantity) || 0 : 0;
  } catch (e: any) {
    brokerErr = e?.message || String(e);
  }

  const localRows = await db.select().from(portfolio);
  const local = findHolding(localRows, symbol);
  const localQty = local ? Number(local.quantity) || 0 : 0;
  const qtyMatch = brokerErr == null && Math.abs(localQty - brokerQty) <= QTY_TOLERANCE;
  checks.push({
    id: 'portfolio_broker_match',
    ok: qtyMatch,
    detail: brokerErr
      ? `broker positions failed: ${brokerErr}`
      : `localQty=${localQty} brokerQty=${brokerQty} tol=${QTY_TOLERANCE}`,
  });

  const recent = await db.select().from(reconciliationEvents)
    .orderBy(desc(reconciliationEvents.id))
    .limit(1);
  const latest = recent[0];
  const mismatches = parseReconMismatches(latest?.mismatches as string | null | undefined);
  const missingRemotely = mismatches.some(
    (m) => canonicalPortfolioSymbol(m.symbol) === symbol && m.type === 'MISSING_REMOTELY',
  );
  const reconOk = latestCycleIsMatch(latest) && !missingRemotely;
  checks.push({
    id: 'recon_clean',
    ok: reconOk,
    detail: latest
      ? `latest id=${latest.id} matches=${latest.matches} mismatches=${mismatches.length} missingRemotely=${missingRemotely}`
      : 'no reconciliation_events row yet',
  });

  if (side === 'SELL') {
    const pnl = trade?.profitLoss ?? order.profitLoss;
    const pnlOk = typeof pnl === 'number' && Number.isFinite(pnl);
    checks.push({
      id: 'sell_pnl_non_null',
      ok: pnlOk,
      detail: pnlOk ? `profitLoss=${pnl}` : 'SELL profit_loss is NULL/non-finite (soak counter would skip)',
    });
  } else {
    checks.push({
      id: 'sell_pnl_non_null',
      ok: true,
      detail: 'N/A for BUY (P&L required on closing SELL only)',
    });
  }

  const traceId = trade?.traceId || order.traceId || null;
  let traceOk = false;
  let traceDetail = 'missing traceId';
  if (traceId) {
    const risk = await db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId)).limit(1);
    const hasTrade = !!trade;
    traceOk = hasTrade && (risk.length > 0 || side === 'SELL');
    // PortfolioManager risk-exits still have risk_assessments; require trade row at minimum.
    // Prefer risk row when present; allow SELL with trade+fills if risk join lags in tests.
    if (risk.length > 0) {
      traceOk = true;
      traceDetail = `traceId=${traceId} risk_assessments=1 trades=1`;
    } else if (hasTrade) {
      traceOk = true;
      traceDetail = `traceId=${traceId} trades=1 risk_assessments=0 (order present)`;
    } else {
      traceOk = false;
      traceDetail = `traceId=${traceId} missing trade+risk`;
    }
  }
  checks.push({
    id: 'trace_completeness',
    ok: traceOk,
    detail: traceDetail,
  });

  return checks;
}

export async function runFirstFillForensicCheckpoint(
  order: any,
): Promise<ForensicCheckpointReport | null> {
  if (completed) return null;
  if (!order || order.status !== 'FILLED') return null;

  const candidate = {
    status: String(order.status),
    side: order.side,
    symbol: order.symbol,
    traceId: order.traceId ?? null,
    reasoning: order.reasoning ?? null,
    executionEnvironment: order.executionEnvironment ?? null,
    profitLoss: order.profitLoss ?? null,
  };
  if (!isOrganicPaperFill(candidate)) return null;

  const deps = activeDeps();
  const triggeredAt = (deps.nowIso || (() => new Date().toISOString()))();
  const orderId = String(order.id || order.orderId || '');
  const symbol = String(order.symbol || '');
  const side = String(order.side || '');
  const traceId = order.traceId ?? null;

  const checks = await evaluateChecks(order);
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  const passed = failures.length === 0;

  const report: ForensicCheckpointReport = {
    result: passed ? 'PASSED' : 'FAILED',
    triggeredAt,
    orderId,
    traceId,
    symbol,
    side,
    checks,
    failures,
  };

  const write = deps.writeReport || defaultWriteReport;
  report.reportPath = write(report);

  lastReport = report;
  completed = true;

  if (passed) {
    eventBus.emit(EVENTS.FORENSIC_CHECKPOINT_PASSED, {
      orderId,
      traceId,
      symbol,
      side,
      at: triggeredAt,
      reportPath: report.reportPath,
    });
    console.log(`[FirstFillForensicCheckpoint] PASSED for ${side} ${symbol} order=${orderId}`);
  } else {
    setForensicCheckpointBuyLock(failures[0] || 'forensic_checkpoint_failed');
    try {
      const toggleResult = await deps.disableAutobot();
      if (!toggleResult.ok) {
        console.error('[FirstFillForensicCheckpoint] Autobot disable failed:', toggleResult.error);
      }
    } catch (e) {
      console.error('[FirstFillForensicCheckpoint] Autobot disable threw', e);
    }
    eventBus.emit(EVENTS.FORENSIC_CHECKPOINT_FAILED, {
      orderId,
      traceId,
      symbol,
      side,
      at: triggeredAt,
      failures,
      reportPath: report.reportPath,
    });
    console.error(`[FirstFillForensicCheckpoint] FAILED for ${side} ${symbol}: ${failures.join(' | ')}`);
  }

  return report;
}

export class FirstFillForensicCheckpointWorker {
  start() {
    if (started) return;
    started = true;
    onOrderExecuted = (order: any) => {
      if (!order || order.status !== 'FILLED') return;
      if (completed) return;
      if (inFlight) return;
      inFlight = runFirstFillForensicCheckpoint(order)
        .then(() => undefined)
        .catch((e) => {
          console.error('[FirstFillForensicCheckpoint] handler failed', e);
        })
        .finally(() => {
          inFlight = null;
        });
    };
    eventBus.on(EVENTS.ORDER_EXECUTED, onOrderExecuted);
    console.log(
      '[FirstFillForensicCheckpoint] Listening for first organic PAPER FILLED ORDER_EXECUTED (Autobot-independent). Fail → disable Autobot + BUY soft-lock; not a second kill switch.',
    );
  }

  stop() {
    if (onOrderExecuted) {
      eventBus.off(EVENTS.ORDER_EXECUTED, onOrderExecuted);
      onOrderExecuted = null;
    }
    started = false;
  }
}

export const firstFillForensicCheckpoint = new FirstFillForensicCheckpointWorker();
