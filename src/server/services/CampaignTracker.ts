/**
 * Goal-oriented daily campaign & strategy attribution tracker.
 *
 * Additive, Autobot-independent for *tracking*. When campaign_enabled and the daily P&L
 * progress reaches 1.0 under LOCK_AND_IDLE or TRAIL_STOPS_ONLY, sets an in-memory BUY soft-lock
 * that ideaGenerationGate consults — NEW entry ideas only. Does NOT:
 * - call placeOrder / OMS / BrokerManager
 * - invent a kill-switch state or a second pause mechanism
 * - lower consensus thresholds
 * - invent parallel sizing (budget stays settings.budget → CapitalAllocation → argus_capital_allocation)
 *
 * TRAIL_STOPS_ONLY: emits CAMPAIGN_TARGET_REACHED with the action; PortfolioMonitor already owns
 * trailingStopPct exits — this module does not invent trail math. BUY soft-lock matches LOCK_AND_IDLE
 * so new entries pause while exits remain allowed when TRADING_ENABLED.
 *
 * CONTINUE: attribution only; no BUY lock.
 */
import { and, eq } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { getTradingDateStr } from '../core/TradingCalendar';
import {
  clearCampaignBuyLockState,
  getCampaignBuyLockDate,
  isCampaignBuyLocked,
  resetCampaignBuyLockForTests,
  setCampaignBuyLock,
  setCampaignBuyLockedForTests as setBuyLockForTests,
} from '../core/campaignBuyLock';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { db } from '../db';
import * as schema from '../db/schema';
import { snapshotCapital } from '../engines/CapitalAllocation';
import {
  resolveOpeningStrategyId,
  UNATTRIBUTED_STRATEGY_ID as ATTR_UNATTRIBUTED,
} from './campaignStrategyAttribution';
import {
  emitCampaignEffortTelemetry,
  getCampaignEffortSnapshot,
  type CampaignEffortSnapshot,
} from './campaignEffortTelemetry';
import { campaignWatchlistBoostWorker } from './CampaignWatchlistBoost';
import { campaignOpeningSurgeWorker } from './CampaignOpeningSurge';

export { isCampaignBuyLocked } from '../core/campaignBuyLock';

export const UNATTRIBUTED_STRATEGY_ID = ATTR_UNATTRIBUTED;

export type DailyTargetType = 'DOLLAR' | 'PERCENT';
export type TargetAchievedAction = 'LOCK_AND_IDLE' | 'TRAIL_STOPS_ONLY' | 'CONTINUE';

export type CampaignBadge = 'PURSUING GOAL' | 'TARGET LOCKED' | 'CAPITAL PRESERVED' | 'DISABLED';

export interface StrategyPerformanceRow {
  quantStrategyId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
}

export interface CampaignStatus {
  enabled: boolean;
  tradingDate: string;
  budget: number;
  dailyTargetAmount: number;
  dailyTargetType: DailyTargetType;
  targetAchievedAction: TargetAchievedAction;
  closePositionsBeforeMarketClose: boolean;
  targetDollars: number;
  dailyRealized: number;
  dailyUnrealized: number;
  dailyTotal: number;
  progress: number;
  buyLocked: boolean;
  badge: CampaignBadge;
  strategies: StrategyPerformanceRow[];
  /**
   * Observability-only capital deployment (Campaign Audit "capital deployment efficiency" ask,
   * bounded to display, never sizing): reuses the argus_capital_allocation gate's own math
   * (CapitalAllocation.snapshotCapital) against settings.budget + local portfolio + pending BUYs,
   * so the number shown matches what the real gate enforces - no parallel sizing calc invented.
   */
  deployedCapital: number;
  idleCapital: number;
  capitalUtilizationPct: number;
  effort: CampaignEffortSnapshot;
}

interface StrategyAgg {
  realizedPnl: number;
  unrealizedPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
}

const NON_ORGANIC_ENV = new Set(['REPLAY', 'BACKTEST', 'DIAGNOSTIC', 'SIMULATION', 'TELEMETRY_PULSE', 'HISTORICAL_REPLAY']);

let targetReachedEmittedForDate: string | null = null;

export function clearCampaignBuyLock(reason: string = 'manual'): void {
  const previous = clearCampaignBuyLockState();
  if (previous) {
    try {
      eventBus.emit(EVENTS.CAMPAIGN_DAY_RESET, {
        previousTradingDate: previous,
        reason,
        at: new Date().toISOString(),
      });
    } catch {
      /* fail-open for UI telemetry */
    }
  }
}

/** Test-only: force or clear the in-memory BUY lock without DB. */
export function setCampaignBuyLockedForTests(locked: boolean, tradingDate?: string): void {
  setBuyLockForTests(locked, tradingDate);
  if (!locked) targetReachedEmittedForDate = null;
}

export function resetCampaignTrackerStateForTests(): void {
  resetCampaignBuyLockForTests();
  targetReachedEmittedForDate = null;
}

export function resolveCampaignTargetDollars(
  budget: number,
  dailyTargetAmount: number,
  dailyTargetType: string,
): number {
  const amount = Number.isFinite(dailyTargetAmount) ? dailyTargetAmount : 0;
  if (amount <= 0) return 0;
  if (String(dailyTargetType).toUpperCase() === 'PERCENT') {
    const b = Number.isFinite(budget) && budget > 0 ? budget : 0;
    return b * (amount / 100);
  }
  return amount;
}

function normalizeStrategyId(raw: string | null | undefined): string {
  const id = (raw ?? '').trim();
  return id.length > 0 ? id : UNATTRIBUTED_STRATEGY_ID;
}

function isOrganicFillEnv(env: string | null | undefined): boolean {
  if (!env) return true;
  return !NON_ORGANIC_ENV.has(String(env).toUpperCase());
}

function ensureAgg(map: Map<string, StrategyAgg>, strategyId: string): StrategyAgg {
  let row = map.get(strategyId);
  if (!row) {
    row = { realizedPnl: 0, unrealizedPnl: 0, tradesCount: 0, winsCount: 0, lossesCount: 0 };
    map.set(strategyId, row);
  }
  return row;
}

export async function computeDayStrategyAttribution(tradingDate: string = getTradingDateStr()): Promise<{
  strategies: Map<string, StrategyAgg>;
  dailyRealized: number;
  dailyUnrealized: number;
}> {
  const strategies = new Map<string, StrategyAgg>();
  const trades = await db.select().from(schema.trades).where(eq(schema.trades.status, 'FILLED'));

  for (const t of trades) {
    if (!isOrganicFillEnv(t.executionEnvironment)) continue;
    const stamp = t.filledAt ?? t.timestamp;
    if (!stamp) continue;
    if (getTradingDateStr(new Date(stamp)) !== tradingDate) continue;

    const cutoff = t.filledAt ?? t.timestamp;
    let strategyId = normalizeStrategyId(t.quantStrategyId);
    if (t.side === 'SELL') {
      strategyId = await resolveOpeningStrategyId(t.symbol, cutoff);
    }

    const agg = ensureAgg(strategies, strategyId);
    agg.tradesCount += 1;

    if (t.side === 'SELL' && t.profitLoss != null && Number.isFinite(t.profitLoss)) {
      agg.realizedPnl += t.profitLoss;
      if (t.profitLoss > 0) agg.winsCount += 1;
      else if (t.profitLoss < 0) agg.lossesCount += 1;
    }
  }

  // Lazy import avoids circular load with MarketDataWorker → ideaGenerationGate.
  const { marketDataWorker } = await import('./MarketDataWorker');
  const holdings = await db.select().from(schema.portfolio);
  for (const h of holdings) {
    if (!h.quantity || h.quantity <= 0) continue;
    const live = marketDataWorker.getLatestPrice(h.symbol);
    let mark: number | null = null;
    if (live != null && Number.isFinite(live) && live > 0) {
      mark = live;
    } else if (h.unrealizedPnL != null && Number.isFinite(h.unrealizedPnL) && Number.isFinite(h.averagePrice)) {
      mark = h.averagePrice + (h.unrealizedPnL / h.quantity);
    }
    if (mark == null || !Number.isFinite(mark)) continue;
    const unrealized = (mark - h.averagePrice) * h.quantity;
    const cutoff = h.lastUpdated ?? new Date().toISOString();
    const strategyId = await resolveOpeningStrategyId(h.symbol, cutoff);
    ensureAgg(strategies, strategyId).unrealizedPnl += unrealized;
  }

  let dailyRealized = 0;
  let dailyUnrealized = 0;
  for (const row of strategies.values()) {
    dailyRealized += row.realizedPnl;
    dailyUnrealized += row.unrealizedPnl;
  }

  return { strategies, dailyRealized, dailyUnrealized };
}

async function upsertStrategyRows(tradingDate: string, strategies: Map<string, StrategyAgg>): Promise<void> {
  const now = Date.now();
  for (const [quantStrategyId, agg] of strategies.entries()) {
    const existing = await db.select().from(schema.dailyStrategyPerformance).where(
      and(
        eq(schema.dailyStrategyPerformance.tradingDate, tradingDate),
        eq(schema.dailyStrategyPerformance.quantStrategyId, quantStrategyId),
      ),
    ).limit(1);

    const values = {
      tradingDate,
      quantStrategyId,
      realizedPnl: Number(agg.realizedPnl.toFixed(4)),
      unrealizedPnl: Number(agg.unrealizedPnl.toFixed(4)),
      tradesCount: agg.tradesCount,
      winsCount: agg.winsCount,
      lossesCount: agg.lossesCount,
      updatedAt: now,
    };

    if (existing.length > 0) {
      await db.update(schema.dailyStrategyPerformance)
        .set(values)
        .where(eq(schema.dailyStrategyPerformance.id, existing[0].id));
    } else {
      await db.insert(schema.dailyStrategyPerformance).values(values);
    }
  }
}

const NON_TERMINAL_ORDER_STATUSES_EXCLUDED = new Set(['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED']);

/**
 * Same inputs/shape the argus_capital_allocation risk gate uses (local portfolio positions +
 * pending non-terminal BUY orders vs settings.budget) - display-only, never a sizing input.
 */
async function computeCapitalDeployment(budget: number): Promise<{
  deployedCapital: number;
  idleCapital: number;
  capitalUtilizationPct: number;
}> {
  const holdings = await db.select().from(schema.portfolio);
  const pendingTrades = await db.select().from(schema.trades).where(eq(schema.trades.side, 'BUY'));
  const pendingBuys = pendingTrades.filter(
    (t) => t.status && !NON_TERMINAL_ORDER_STATUSES_EXCLUDED.has(t.status),
  );

  const snap = snapshotCapital({
    allocated: budget,
    positions: holdings.map((h) => ({ quantity: h.quantity, averagePrice: h.averagePrice })),
    pendingBuys: pendingBuys.map((t) => ({ quantity: t.quantity, price: t.price, side: t.side, status: t.status ?? undefined })),
  });

  return {
    deployedCapital: Number(snap.used.toFixed(2)),
    idleCapital: Number(snap.remaining.toFixed(2)),
    capitalUtilizationPct: budget > 0 ? Number(((snap.used / budget) * 100).toFixed(2)) : 0,
  };
}

function badgeFor(enabled: boolean, buyLocked: boolean, action: TargetAchievedAction, progress: number): CampaignBadge {
  if (!enabled) return 'DISABLED';
  if (buyLocked && action === 'TRAIL_STOPS_ONLY') return 'CAPITAL PRESERVED';
  if (buyLocked) return 'TARGET LOCKED';
  if (progress >= 1 && action === 'CONTINUE') return 'PURSUING GOAL';
  return 'PURSUING GOAL';
}

export async function getCampaignStatus(now: Date = new Date()): Promise<CampaignStatus> {
  const tradingDate = getTradingDateStr(now);
  const settings = (await db.select().from(schema.settings).limit(1))[0];
  const enabled = !!settings?.campaignEnabled;
  const budget = Number(settings?.budget ?? 0) || 0;
  const dailyTargetAmount = Number(settings?.dailyTargetAmount ?? 0) || 0;
  const dailyTargetType = (String(settings?.dailyTargetType || 'DOLLAR').toUpperCase() === 'PERCENT'
    ? 'PERCENT'
    : 'DOLLAR') as DailyTargetType;
  const targetAchievedAction = normalizeAction(settings?.targetAchievedAction);
  const closePositionsBeforeMarketClose = !!settings?.closePositionsBeforeMarketClose;
  const targetDollars = resolveCampaignTargetDollars(budget, dailyTargetAmount, dailyTargetType);

  const { strategies, dailyRealized, dailyUnrealized } = await computeDayStrategyAttribution(tradingDate);
  const dailyTotal = dailyRealized + dailyUnrealized;
  const progress = targetDollars > 0 ? dailyTotal / targetDollars : 0;
  const buyLocked = isCampaignBuyLocked(now);
  const { deployedCapital, idleCapital, capitalUtilizationPct } = await computeCapitalDeployment(budget);

  const strategyRows: StrategyPerformanceRow[] = [...strategies.entries()]
    .map(([quantStrategyId, agg]) => ({
      quantStrategyId,
      realizedPnl: Number(agg.realizedPnl.toFixed(4)),
      unrealizedPnl: Number(agg.unrealizedPnl.toFixed(4)),
      tradesCount: agg.tradesCount,
      winsCount: agg.winsCount,
      lossesCount: agg.lossesCount,
    }))
    .sort((a, b) => (b.realizedPnl + b.unrealizedPnl) - (a.realizedPnl + a.unrealizedPnl));

  return {
    enabled,
    tradingDate,
    budget,
    dailyTargetAmount,
    dailyTargetType,
    targetAchievedAction,
    closePositionsBeforeMarketClose,
    targetDollars,
    dailyRealized: Number(dailyRealized.toFixed(4)),
    dailyUnrealized: Number(dailyUnrealized.toFixed(4)),
    dailyTotal: Number(dailyTotal.toFixed(4)),
    progress,
    buyLocked,
    badge: badgeFor(enabled, buyLocked, targetAchievedAction, progress),
    strategies: strategyRows,
    deployedCapital,
    idleCapital,
    capitalUtilizationPct,
    effort: getCampaignEffortSnapshot(now),
  };
}

function normalizeAction(raw: string | null | undefined): TargetAchievedAction {
  const v = String(raw || 'CONTINUE').toUpperCase();
  if (v === 'LOCK_AND_IDLE') return 'LOCK_AND_IDLE';
  if (v === 'TRAIL_STOPS_ONLY') return 'TRAIL_STOPS_ONLY';
  return 'CONTINUE';
}

export async function refreshCampaignProgress(reason: string = 'manual'): Promise<CampaignStatus> {
  const now = new Date();
  const today = getTradingDateStr(now);

  // Day-boundary unlock before computing progress.
  const lockedDate = getCampaignBuyLockDate();
  if (lockedDate && lockedDate !== today) {
    clearCampaignBuyLock('day_boundary');
    targetReachedEmittedForDate = null;
  }

  const settings = (await db.select().from(schema.settings).limit(1))[0];
  const enabled = !!settings?.campaignEnabled;

  const { strategies, dailyRealized, dailyUnrealized } = await computeDayStrategyAttribution(today);
  await upsertStrategyRows(today, strategies);

  const status = await getCampaignStatus(now);

  try {
    eventBus.emit(EVENTS.CAMPAIGN_PROGRESS_UPDATED, {
      tradingDate: today,
      reason,
      enabled,
      progress: status.progress,
      dailyRealized,
      dailyUnrealized,
      targetDollars: status.targetDollars,
      buyLocked: status.buyLocked,
      at: now.toISOString(),
    });
  } catch {
    /* fail-open */
  }

  if (!enabled || status.targetDollars <= 0) {
    if (getCampaignBuyLockDate() && !enabled) {
      clearCampaignBuyLock('campaign_disabled');
      targetReachedEmittedForDate = null;
    }
    return getCampaignStatus(now);
  }

  if (status.progress >= 1.0) {
    const action = status.targetAchievedAction;
    if (action === 'LOCK_AND_IDLE' || action === 'TRAIL_STOPS_ONLY') {
      if (getCampaignBuyLockDate() !== today) {
        setCampaignBuyLock(today, action);
      }
      if (targetReachedEmittedForDate !== today) {
        targetReachedEmittedForDate = today;
        eventBus.emit(EVENTS.CAMPAIGN_TARGET_REACHED, {
          tradingDate: today,
          action,
          progress: status.progress,
          dailyRealized: status.dailyRealized,
          dailyUnrealized: status.dailyUnrealized,
          targetDollars: status.targetDollars,
          trailOwnedBy: action === 'TRAIL_STOPS_ONLY' ? 'PortfolioMonitor.trailingStopPct' : undefined,
          at: now.toISOString(),
        });
      }
    } else if (action === 'CONTINUE' && targetReachedEmittedForDate !== today) {
      targetReachedEmittedForDate = today;
      eventBus.emit(EVENTS.CAMPAIGN_TARGET_REACHED, {
        tradingDate: today,
        action: 'CONTINUE',
        progress: status.progress,
        dailyRealized: status.dailyRealized,
        dailyUnrealized: status.dailyUnrealized,
        targetDollars: status.targetDollars,
        note: 'Target logged; continuous evaluation continues (no BUY soft-lock)',
        at: now.toISOString(),
      });
    }
  }

  emitCampaignEffortTelemetry({
    phase: 'refresh',
    reason,
    capitalUtilizationPct: status.capitalUtilizationPct,
    progress: status.progress,
  });

  return getCampaignStatus(now);
}

export class CampaignTrackerWorker {
  private started = false;
  private intervalId: NodeJS.Timeout | null = null;
  private onOrderExecuted: ((order: any) => void) | null = null;

  start() {
    if (this.started) return;
    this.started = true;

    this.onOrderExecuted = (order: any) => {
      if (!order || order.status !== 'FILLED') return;
      refreshCampaignProgress('ORDER_EXECUTED').catch((e) =>
        console.error('[CampaignTracker] refresh after ORDER_EXECUTED failed', e),
      );
    };
    eventBus.on(EVENTS.ORDER_EXECUTED, this.onOrderExecuted);

    // Light poll: day-boundary unlock + unrealized refresh (reuses portfolio cadence; not a new safety knob).
    this.intervalId = setInterval(() => {
      refreshCampaignProgress('interval').catch((e) =>
        console.error('[CampaignTracker] interval refresh failed', e),
      );
    }, runtimeIntervals.portfolioMonitorMs);

    refreshCampaignProgress('boot').catch((e) =>
      console.error('[CampaignTracker] boot refresh failed', e),
    );

    campaignWatchlistBoostWorker.start();
    campaignOpeningSurgeWorker.start();

    console.log(
      '[CampaignTracker] Started at boot (Autobot-independent for tracking). BUY soft-lock only when campaign target reached under LOCK_AND_IDLE/TRAIL_STOPS_ONLY; SELL/exits still use PortfolioMonitor when TRADING_ENABLED. Watchlist boost + opening-surge scan run only while campaign_enabled.',
    );
  }

  stop() {
    if (this.onOrderExecuted) {
      eventBus.off(EVENTS.ORDER_EXECUTED, this.onOrderExecuted);
      this.onOrderExecuted = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    campaignWatchlistBoostWorker.stop();
    campaignOpeningSurgeWorker.stop();
    this.started = false;
  }
}

export const campaignTracker = new CampaignTrackerWorker();
