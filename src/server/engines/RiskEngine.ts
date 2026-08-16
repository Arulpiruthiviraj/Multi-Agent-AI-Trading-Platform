/**
 * ==========================================================
 * Module: RiskEngine.ts
 *
 * Purpose:
 * Evaluates trade proposals against real account equity, current
 * risk thresholds, and active portfolio positions.
 *
 * Responsibilities:
 * - Validate available buying power.
 * - Size positions using fractional risk rules.
 * - Block execution if volatility or drawdowns exceed limits.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { db } from '../db';
import * as schema from '../db/schema';
import { desc, isNotNull, and, eq, gte } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { tradingEngine } from './TradingEngine';
import { marketDataWorker } from '../services/MarketDataWorker';
import { historicalDataGateway } from './backtest/HistoricalDataGateway';
import { calculatePositionSizing, CORRELATION_MIN_OVERLAP } from './PositionSizing';
import { getTradingDateStr } from '../core/TradingCalendar';
import { applyRestrictedLiveCaps } from './RestrictedLiveMode';
import { snapshotCapital, evaluateAllocationGuard } from './CapitalAllocation';
import { evaluateDailyBuyNotional, resolveDailyBuyNotionalCap, sumDailyBuyNotional } from './DailyBuyNotional';
import { tradingSafety, portfolioRiskPctForLevel } from '../config/tradingSafety';

const STALE_PRICE_THRESHOLD_MS = tradingSafety.stalePriceThresholdMs;
let cachedMarketClock: { isOpen: boolean; fetchedAt: number } | null = null;
const MARKET_CLOCK_CACHE_MS = tradingSafety.marketClockCacheMs;

const MAX_CONSECUTIVE_LOSSES = tradingSafety.maxConsecutiveLosses;

const CORRELATION_LOOKBACK_MS = tradingSafety.correlationLookbackMs;
const closesCache: Map<string, { closes: number[]; fetchedAt: number }> = new Map();

// Real daily closes over a 90-day window, backed by ohlcv_bars (with an opportunistic real
// Alpaca backfill if the cache is thin). Returns null - never a fabricated series - whenever
// real history for this symbol isn't available (no Alpaca credentials, symbol never traded,
// API failure). Cached in-memory for the market-clock cache's duration to avoid re-querying
// the DB/Alpaca on every single risk evaluation within the same minute.
async function getRecentCloses(symbol: string): Promise<number[] | null> {
    const cached = closesCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < MARKET_CLOCK_CACHE_MS) return cached.closes;

    const end = Date.now();
    const start = end - CORRELATION_LOOKBACK_MS;
    try {
        let bars = await historicalDataGateway.getBars(symbol, '1Day', start, end);
        if (bars.length < CORRELATION_MIN_OVERLAP) {
            await historicalDataGateway.ensureBars(symbol, '1Day', start, end);
            bars = await historicalDataGateway.getBars(symbol, '1Day', start, end);
        }
        if (bars.length < CORRELATION_MIN_OVERLAP) return null;
        const closes = bars.map(b => b.close);
        closesCache.set(symbol, { closes, fetchedAt: Date.now() });
        return closes;
    } catch (e) {
        return null;
    }
}

// Real consecutive-loss circuit breaker - reads actual realized P&L from the last few FILLED
// SELL trades (now populated by OrderManagement.ts). Returns true only when there IS real trade
// history and the most recent MAX_CONSECUTIVE_LOSSES of it were all losses.
async function hasConsecutiveLosses(): Promise<boolean> {
    const recentClosed = await db.select().from(schema.trades)
        .where(and(eq(schema.trades.status, 'FILLED'), isNotNull(schema.trades.profitLoss)))
        .orderBy(desc(schema.trades.timestamp))
        .limit(MAX_CONSECUTIVE_LOSSES);
    if (recentClosed.length < MAX_CONSECUTIVE_LOSSES) return false;
    return recentClosed.every(t => (t.profitLoss ?? 0) < 0);
}

export type MarketClockStatus = 'open' | 'closed' | 'unconfigured' | 'unavailable';

/**
 * Alpaca /v2/clock.
 *   unconfigured — no API keys: skip (no clock source; paper tests rely on this).
 *   unavailable  — keys present but HTTP/network failed: FAIL CLOSED (do not treat as open).
 *   open/closed  — real clock payload. Failures are never cached as open.
 */
export async function readMarketClock(): Promise<MarketClockStatus> {
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return 'unconfigured';
    if (cachedMarketClock && Date.now() - cachedMarketClock.fetchedAt < MARKET_CLOCK_CACHE_MS) {
        return cachedMarketClock.isOpen ? 'open' : 'closed';
    }
    try {
        const isPaper = tradingEngine.state.tradingMode !== 'LIVE';
        const base = isPaper ? 'paper-api.alpaca.markets' : 'api.alpaca.markets';
        const res = await fetch(`https://${base}/v2/clock`, {
            headers: {
                'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY
            }
        });
        if (!res.ok) {
            console.error(`[Risk Engine] Alpaca market clock HTTP ${res.status} — fail-closed`);
            return 'unavailable';
        }
        const clock = await res.json();
        cachedMarketClock = { isOpen: !!clock.is_open, fetchedAt: Date.now() };
        return cachedMarketClock.isOpen ? 'open' : 'closed';
    } catch (e) {
        console.error('[Risk Engine] Failed to fetch Alpaca market clock — fail-closed', e);
        return 'unavailable';
    }
}

/** Test-only: RiskEngine.test.ts must not inherit a 60s clock cache across cases. */
export function resetMarketClockCacheForTests(): void {
    cachedMarketClock = null;
}

interface GateResult {
    gate: string;
    passed: boolean;
    detail: any;
}

export class RiskEngine {
    private static instance: RiskEngine;

    // Real fix for two TOCTOU races (portfolio_drawdown's peak-equity read-then-write, and
    // order_rate_limit's count-then-insert): RiskAgent.assessRisk() invokes evaluateRisk()
    // fire-and-forget with no queue, so two CHIEF_APPROVED_IDEA events arriving close together
    // (a real scenario - both ChiefTraderAgent's own consensus approval and the manual-override
    // route in v2System.ts emit this event) could previously run two evaluateRisk() calls
    // concurrently, letting both read the same storedPeakEquity/recentOrderCount before either
    // had written its own result. This promise-chain mutex serializes only evaluateRisk()
    // invocations on this singleton - it never touches order placement, market-data ingestion,
    // agent signal generation, or portfolio reconciliation, none of which call this method.
    // Both racy resources are portfolio-wide/global state, not per-symbol, so there is no
    // correctness benefit to a finer-grained lock: every OTHER gate's own logic (price_validity,
    // market_hours, news_veto, etc.) is unaffected by serialization either way, since it has no
    // shared-mutable-state race to begin with. Deliberately does not change RiskAgent's own
    // fire-and-forget call site - callers await the same public method exactly as before; the
    // ordering guarantee (FIFO by invocation time) and full-completion-before-next-starts
    // guarantee are new, transparent side effects of this queue, not a new contract to adopt.
    private evaluationQueue: Promise<void> = Promise.resolve();

    private constructor() {}

    public static getInstance(): RiskEngine {
        if (!RiskEngine.instance) {
            RiskEngine.instance = new RiskEngine();
        }
        return RiskEngine.instance;
    }

    public async evaluateRisk(proposal: any): Promise<void> {
        const run = this.evaluationQueue.then(() => this.evaluateRiskSerialized(proposal));
        // Never let one evaluation's rejection break the queue for evaluations queued after it -
        // evaluateRiskSerialized already has its own internal top-level try/catch, so a rejection
        // reaching here would only be a truly unexpected error; the queue must still advance.
        this.evaluationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async evaluateRiskSerialized(proposal: any) {
        console.log(`[Risk Engine] Evaluating proposal: ${proposal.side} ${proposal.symbol}`);
        eventBus.emit('RISK_ASSESSMENT_STARTED', { traceId: proposal.traceId, transactionId: proposal.transactionId, symbol: proposal.symbol, side: proposal.side });

        // Phase 2 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md, confirmed design change): every gate
        // is now evaluated unconditionally, in the same order as before, instead of returning on
        // the first failure. The final approve/reject outcome and reported reasoning are
        // unchanged (still driven by whichever gate fails FIRST in this order) - what changes is
        // that every gate's real pass/fail is now recorded, even ones after the first failure,
        // so a rejected trade still has a complete, honest gate-by-gate record instead of
        // "not evaluated" gates being indistinguishable from passed ones. This does mean a
        // rejected proposal now always pays the cost of every gate's real DB/network calls
        // (portfolio, settings, consecutive-loss query, market clock, news query, and - for BUY -
        // correlation history per existing position) rather than short-circuiting early.
        const gateResults: GateResult[] = [];
        let sequence = 0;
        const recordGate = (gate: string, passed: boolean, detail: any) => {
            gateResults.push({ gate, passed, detail });
            eventBus.emit('RISK_GATE_EVALUATED', { transactionId: proposal.transactionId, traceId: proposal.traceId, symbol: proposal.symbol, gate, sequence: sequence++, passed, detail });
        };

        let approved = false;
        let maxQuantity = 0;
        let reasoning = '';
        let accountEquity: number | undefined;
        let buyingPower: number | undefined;

        try {
            // 0. Trading kill switch - checked first, always evaluated and recorded, unlike the
            // old RiskAgent pre-check that bypassed RiskEngine (and thus this gate ladder)
            // entirely on a rejection. Blocks on BOTH non-enabled states - TRADING_PAUSED is a
            // softer halt than EMERGENCY_STOP (no forced order cancellation) but it still means
            // no new trades, which is the entire point of pausing.
            const tradingState = tradingEngine.state.tradingState;
            recordGate('emergency_stop', tradingState === 'TRADING_ENABLED', { tradingState, emergencyStopActive: tradingEngine.state.emergencyStopActive });
            const emergencyStopReason = tradingState === 'EMERGENCY_STOP'
                ? "Emergency stop is active. All new trades are blocked until resumed."
                : "Trading is paused. All new trades are blocked until resumed.";

            // 1. Fetch real broker portfolio state
            const broker = BrokerManager.getInstance().getActiveBroker();
            const portfolio = await broker.portfolio();

            // 2. Fetch risk settings from SQLite
            const settings = await db.select().from(schema.settings).limit(1);
            const riskLevel = settings[0]?.riskLevel || "Balanced";
            const maxPortfolioRiskPct = portfolioRiskPctForLevel(riskLevel);

            // Phase 13 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real, hardcoded ceilings that
            // apply automatically for real live trading, independent of whatever the settings row
            // currently says. Never loosens anything - a no-op identity function whenever
            // tradingMode isn't 'LIVE' (i.e. every paper-trading call, which is every call in this
            // environment today). See RestrictedLiveMode.ts's own header for the full rationale.
            const restrictedLiveCaps = applyRestrictedLiveCaps({
                tradingMode: tradingEngine.state.tradingMode,
                maxTradeSizeDollar: settings[0]?.maxTradeSize || 3000,
                maxOpenPositions: settings[0]?.maxOpenPositions ?? 10,
                dailyLossLimitDollars: tradingEngine.state.dailyLossLimit,
            });
            const maxTradeSizeDollar = restrictedLiveCaps.maxTradeSizeDollar;

            accountEquity = portfolio.equity || 10000;
            buyingPower = portfolio.buyingPower || 10000;

            // 2a. Daily loss circuit breaker - tracks real broker equity against a start-of-day
            // baseline captured the first time we evaluate risk each calendar day. Uses the real
            // exchange trading day (America/New_York), not UTC - UTC midnight is 7-8 PM New York
            // time, which would reset this baseline mid-session instead of at the real start of
            // the trading day.
            const equityNow = portfolio.equity || 0;
            const todayStr = getTradingDateStr();
            if (tradingEngine.state.dayStartDateStr !== todayStr) {
                tradingEngine.state.dayStartDateStr = todayStr;
                tradingEngine.state.dayStartEquity = equityNow;
                tradingEngine.state.currentDailyLoss = 0;
            }
            const dayStartEquity = tradingEngine.state.dayStartEquity ?? equityNow;
            const dailyLoss = Math.max(0, dayStartEquity - equityNow);
            tradingEngine.state.currentDailyLoss = dailyLoss;
            const dailyLossKillSwitchThreshold = restrictedLiveCaps.dailyLossLimitDollars * tradingSafety.dailyLossKillSwitchFraction;
            const dailyLossPassed = dailyLoss < dailyLossKillSwitchThreshold;
            recordGate('daily_loss', dailyLossPassed, { dailyLoss, threshold: dailyLossKillSwitchThreshold, limit: restrictedLiveCaps.dailyLossLimitDollars, restrictedLiveModeActive: restrictedLiveCaps.restricted });
            const dailyLossReason = `Daily Loss Kill-Switch: -$${dailyLoss.toFixed(2)} reached ${tradingSafety.dailyLossKillSwitchFraction * 100}% of the $${restrictedLiveCaps.dailyLossLimitDollars}${restrictedLiveCaps.restricted ? ' (restricted live mode cap)' : ''} daily loss limit. All new trades blocked until tomorrow or a manual reset.`;

            // 2a-2. Consecutive-loss circuit breaker - real realized P&L from the last three
            // FILLED trades, not a simulated/hardcoded count.
            const consecutiveLossesBad = await hasConsecutiveLosses();
            recordGate('consecutive_loss', !consecutiveLossesBad, { maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES, triggered: consecutiveLossesBad });
            const consecutiveLossReason = `${MAX_CONSECUTIVE_LOSSES} consecutive losing trades. All new trades blocked pending manual review.`;

            // 2a-3. Portfolio drawdown circuit breaker - distinct from the daily-loss check
            // above (which resets every calendar day): tracks a real, persisted peak equity
            // high-water-mark across the account's whole life and blocks once real equity falls
            // more than maxPortfolioDrawdownPct below that peak. The peak only ever moves up
            // (a new real high), so a slow multi-day bleed that never trips the daily-loss
            // threshold on any single day still gets caught here.
            const maxDrawdownPct = settings[0]?.maxPortfolioDrawdownPct ?? 0.15;
            const storedPeakEquity = settings[0]?.peakEquity ?? null;
            const peakEquity = (storedPeakEquity === null || equityNow > storedPeakEquity) ? equityNow : storedPeakEquity;
            if (peakEquity !== storedPeakEquity) {
                try { await db.update(schema.settings).set({ peakEquity }).run(); } catch (e) { console.error('[Risk Engine] Failed to persist new peak equity', e); }
            }
            const drawdownPct = peakEquity > 0 ? Math.max(0, (peakEquity - equityNow) / peakEquity) : 0;
            const drawdownPassed = drawdownPct < maxDrawdownPct;
            recordGate('portfolio_drawdown', drawdownPassed, { drawdownPct, maxDrawdownPct, peakEquity, equityNow });
            const drawdownReason = `Portfolio drawdown ${(drawdownPct * 100).toFixed(1)}% from peak equity $${peakEquity.toFixed(2)} exceeds the configured ${(maxDrawdownPct * 100).toFixed(0)}% limit. All new trades blocked pending manual review.`;

            // 2a-4. Order-rate limit - counts real risk_assessments rows created in the last 60
            // seconds (any symbol/side), not just this symbol's. Catches a runaway agent/loop
            // bug generating far more proposals than any real strategy should, independent of
            // whether any individual proposal would otherwise pass every other gate.
            const maxOrdersPerMinute = settings[0]?.maxOrdersPerMinute ?? 5;
            const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
            const recentAssessments = await db.select().from(schema.riskAssessments)
                .where(gte(schema.riskAssessments.createdAt, oneMinuteAgo));
            const recentOrderCount = recentAssessments.length;
            const orderRatePassed = recentOrderCount < maxOrdersPerMinute;
            recordGate('order_rate_limit', orderRatePassed, { recentOrderCount, maxOrdersPerMinute });
            const orderRateReason = `Order rate limit exceeded: ${recentOrderCount} risk assessments in the last 60s (limit ${maxOrdersPerMinute}). Possible runaway signal loop - new trades blocked until the rate subsides.`;

            // 2b. Alpaca /v2/clock. Unconfigured → skip. Closed or clock outage → block.
            // Previously `null !== false` passed the gate on REST failure (outage treated as open).
            const marketClock = await readMarketClock();
            const marketHoursPassed = marketClock === 'open' || marketClock === 'unconfigured';
            recordGate('market_hours', marketHoursPassed, { marketClock, skipped: marketClock === 'unconfigured' });
            const marketHoursReason = marketClock === 'unavailable'
                ? 'Alpaca market clock unavailable (HTTP/network failure). Fail-closed: new trades blocked until the clock can be read.'
                : 'Market is currently closed (Alpaca clock).';

            // 2c. Stale market-data check - only fires when we've actually seen a real tick for
            // this symbol before and it has since gone quiet; never fabricates a staleness verdict.
            const priceAgeMs = marketDataWorker.getLatestPriceAgeMs(proposal.symbol);
            const stale = priceAgeMs !== null && priceAgeMs > STALE_PRICE_THRESHOLD_MS;
            recordGate('data_freshness', !stale, { priceAgeMs, thresholdMs: STALE_PRICE_THRESHOLD_MS });
            const staleDataReason = `Stale market data: last real tick for ${proposal.symbol} is ${Math.round((priceAgeMs || 0) / 1000)}s old (threshold ${STALE_PRICE_THRESHOLD_MS / 1000}s).`;

            // 3. News risk validation - impactScore lives on news_clusters, not news_articles
            // (news_articles has no impactScore column at all, so this always evaluated to
            // "no high-impact news" regardless of real news). Limited to a 4-hour window so a
            // stale high-impact cluster doesn't veto trades indefinitely.
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
            const recentClusters = await db.select().from(schema.newsClusters)
                .where(gte(schema.newsClusters.updatedAt, fourHoursAgo));
            const symbolNews = recentClusters.filter((n: any) =>
                n.symbols && n.symbols.includes(proposal.symbol) &&
                n.impactScore && n.impactScore > 80
            );
            recordGate('news_veto', symbolNews.length === 0, { matchingClusters: symbolNews.length });
            const newsVetoReason = "High volatility news event detected, overriding AI decision.";

            // 4. Position Sizing Math - using actual buying power and portfolio value
            const currentPrice = proposal.currentPrice;
            const priceValid = typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0;
            recordGate('price_validity', priceValid, { currentPrice });
            const priceValidityReason = "No valid price";

            let sufficientSizePassed = false;
            let sellPositionPassed = true; // only meaningful for SELL - stays true (n/a) for BUY
            const sufficientSizeReasonHolder = { text: '' };
            const openPositionsCapReasonHolder = { text: '' };
            const sellPositionReason = "Cannot sell - no existing position in broker portfolio.";

            if (priceValid) {
                // Phase 2A (FINAL_ANALYSIS.md's 4-phase remediation plan): the actual sizing math
                // (order-notional/single-symbol/open-positions/sector/correlation caps,
                // sufficient-size) is now a pure, shared function (PositionSizing.ts) so
                // BacktestEngine can use the byte-for-byte identical logic instead of its
                // previous flat-10%-of-initial-cash rule - a real, previously-documented
                // inconsistency (FINAL_ANALYSIS.md 15.9).
                const maxOpenPositions = restrictedLiveCaps.maxOpenPositions;
                openPositionsCapReasonHolder.text = `Maximum open positions (${maxOpenPositions}) already reached; cannot open a new position in ${proposal.symbol} until an existing position is closed.`;
                sufficientSizeReasonHolder.text = `Insufficient buying power or risk limits exceeded. Required: ${currentPrice}, Available BP: ${buyingPower}`;

                // E2B - feature-flagged, defaults to 'FIXED_DOLLAR' (today's exact behavior) for
                // anyone who hasn't opted into PERCENT_OF_EQUITY sizing via settings.
                const sizingMode = (settings[0]?.positionSizingMode as 'FIXED_DOLLAR' | 'PERCENT_OF_EQUITY') || 'FIXED_DOLLAR';
                const percentOfEquityPct = settings[0]?.percentOfEquityPct ?? 2;

                const sizingResult = await calculatePositionSizing({
                    side: proposal.side,
                    symbol: proposal.symbol,
                    currentPrice,
                    accountEquity,
                    buyingPower,
                    maxTradeSizeDollar,
                    maxPortfolioRiskPct,
                    existingPositions: portfolio.positions.map((p: any) => ({ symbol: p.symbol, quantity: p.quantity })),
                    maxOpenPositions,
                    getRecentCloses,
                    sizingMode,
                    percentOfEquityPct,
                });
                maxQuantity = sizingResult.maxQuantity;
                for (const g of sizingResult.gates) recordGate(g.gate, g.passed, g.detail);
                sufficientSizePassed = sizingResult.gates.find(g => g.gate === 'sufficient_size')?.passed ?? false;

                // If we are selling, make sure we have the shares
                if (proposal.side === 'SELL') {
                    const existingPosition = portfolio.positions.find((p: any) => p.symbol === proposal.symbol);
                    sellPositionPassed = !!existingPosition && existingPosition.quantity > 0;
                    recordGate('sell_position_exists', sellPositionPassed, { existingQuantity: existingPosition?.quantity ?? 0 });
                    if (sellPositionPassed) {
                        maxQuantity = Math.min(maxQuantity, existingPosition.quantity);
                    }
                }

                // Argus allocation is a hard authority ceiling, distinct from broker buying power.
                // settings.budget (same field the Autobot "Allocated Budget Limit" writes) is the
                // slice Argus may commit. Broker equity of $2,000 never authorizes a $101 BUY
                // against a $100 allocation. Pending BUY notionals count as reserved.
                const allocated = Number(
                    settings[0]?.budget ?? tradingEngine.state.budget ?? 0
                );
                const allTrades = await db.select().from(schema.trades);
                const pendingBuys = (allTrades || []).filter((t: any) =>
                    t.side === 'BUY' && t.status && !['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(t.status)
                );
                const capitalSnap = snapshotCapital({
                    allocated: Number.isFinite(allocated) ? allocated : 0,
                    positions: portfolio.positions || [],
                    pendingBuys,
                });
                const requestedNotional = proposal.side === 'BUY' ? maxQuantity * currentPrice : 0;
                const capitalGuard = evaluateAllocationGuard(capitalSnap, proposal.side, requestedNotional);
                recordGate('argus_capital_allocation', capitalGuard.passed, capitalGuard);
                eventBus.emit('CAPITAL_CHECK', {
                    traceId: proposal.traceId,
                    transactionId: proposal.transactionId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    ...capitalGuard,
                    brokerEquity: accountEquity,
                    brokerBuyingPower: buyingPower,
                });

                const dailyCap = resolveDailyBuyNotionalCap(tradingEngine.state.tradingMode);
                const alreadyToday = sumDailyBuyNotional(allTrades || []);
                const dailyGuard = evaluateDailyBuyNotional({
                    cap: dailyCap,
                    side: proposal.side,
                    alreadyDeployed: alreadyToday,
                    requestedNotional,
                });
                recordGate('daily_buy_notional', dailyGuard.passed, dailyGuard);
            } else {
                recordGate('sufficient_size', false, { skipped: true, reason: 'invalid price - sizing not evaluated' });
                recordGate('argus_capital_allocation', false, { skipped: true, reason: 'invalid price - allocation not evaluated' });
                recordGate('daily_buy_notional', false, { skipped: true, reason: 'invalid price - daily buy notional not evaluated' });
            }

            const capitalRejectReason = (gateResults.find(g => g.gate === 'argus_capital_allocation')?.detail as any)?.reason
                || 'Rejected by Argus capital allocation guard.';
            const dailyBuyNotionalReason = (gateResults.find(g => g.gate === 'daily_buy_notional')?.detail as any)?.reason
                || 'Rejected by daily buy notional cap.';

            // Final verdict: first gate to fail, in evaluation order, determines the reported
            // reason - identical priority to the old early-exit order, but now every gate's real
            // result (not just the first failure) has already been recorded above.
            const firstFailure = gateResults.find(g => !g.passed);
            approved = !firstFailure;
            if (!approved) {
                maxQuantity = 0;
                reasoning = firstFailure!.gate === 'emergency_stop' ? emergencyStopReason
                    : firstFailure!.gate === 'daily_loss' ? dailyLossReason
                    : firstFailure!.gate === 'consecutive_loss' ? consecutiveLossReason
                    : firstFailure!.gate === 'portfolio_drawdown' ? drawdownReason
                    : firstFailure!.gate === 'order_rate_limit' ? orderRateReason
                    : firstFailure!.gate === 'market_hours' ? marketHoursReason
                    : firstFailure!.gate === 'data_freshness' ? staleDataReason
                    : firstFailure!.gate === 'news_veto' ? newsVetoReason
                    : firstFailure!.gate === 'price_validity' ? priceValidityReason
                    : firstFailure!.gate === 'open_positions_cap' ? openPositionsCapReasonHolder.text
                    : firstFailure!.gate === 'sufficient_size' ? sufficientSizeReasonHolder.text
                    : firstFailure!.gate === 'sell_position_exists' ? sellPositionReason
                    : firstFailure!.gate === 'argus_capital_allocation' ? capitalRejectReason
                    : firstFailure!.gate === 'daily_buy_notional' ? dailyBuyNotionalReason
                    : `Rejected by gate: ${firstFailure!.gate}`;
            } else {
                reasoning = `Approved based on ${(maxPortfolioRiskPct*100).toFixed(1)}% portfolio risk cap and available BP.`;
            }

            if (!approved && firstFailure) {
                const { buildDiagnostic } = await import('../diagnostics/buildDiagnostic');
                const { GATE_FIX } = await import('../diagnostics/catalog');
                if (firstFailure.gate === 'argus_capital_allocation') {
                    const d = firstFailure.detail || {};
                    eventBus.emit('CAPITAL_BLOCK', buildDiagnostic('CAP-001', {
                        requested: d.requestedNotional ?? '',
                        remaining: d.remaining ?? '',
                        allocated: d.allocated ?? '',
                        used: d.used ?? '',
                        brokerBuyingPower: buyingPower ?? '',
                        technicalMessage: reasoning,
                    }));
                } else {
                    eventBus.emit('RISK_BLOCK', buildDiagnostic('RSK-001', {
                        gate: firstFailure.gate,
                        reasoning,
                        recommendedFix: GATE_FIX[firstFailure.gate] || 'Inspect the failed gate; do not bypass RiskEngine.',
                    }));
                }
            }

            eventBus.emitRiskAssessment({
                traceId: proposal.traceId, transactionId: proposal.transactionId,
                symbol: proposal.symbol,
                side: proposal.side,
                currentPrice: proposal.currentPrice,
                approved,
                maxQuantity,
                reasoning,
                newsDetails: proposal.newsDetails,
                // Phase 16B - only meaningful (and only ever consumed by OrderManagement) on a
                // real approval; forwarded unconditionally here regardless of approved/rejected
                // since RiskEngine never bypasses or reinterprets it either way.
                selectedQuantStrategy: proposal.selectedQuantStrategy ?? null,
                quantStopPrice: proposal.quantStopPrice ?? null,
                quantTargetPrice: proposal.quantTargetPrice ?? null,
                quantInvalidationJson: proposal.quantInvalidationJson ?? null,
            });

            await this.persistAssessment(proposal, { approved, maxQuantity, reasoning, rejectionGate: firstFailure?.gate ?? null, accountEquity, buyingPower, gateResults });
        } catch (e) {
            console.error('[Risk Engine] Error evaluating risk', e);
            approved = false;
            maxQuantity = 0;
            reasoning = `Risk evaluation crashed: ${(e as Error).message}`;
            eventBus.emitRiskAssessment({
                traceId: proposal.traceId, transactionId: proposal.transactionId,
                symbol: proposal.symbol,
                side: proposal.side,
                approved: false,
                maxQuantity: 0,
                reasoning,
            });
            await this.persistAssessment(proposal, { approved: false, maxQuantity: 0, reasoning, rejectionGate: 'system_error', accountEquity, buyingPower, gateResults });
        }
    }

    private async persistAssessment(proposal: any, result: { approved: boolean, maxQuantity: number, reasoning: string, rejectionGate: string | null, accountEquity?: number, buyingPower?: number, gateResults: GateResult[] }) {
        try {
            await db.insert(schema.riskAssessments).values({
                transactionId: proposal.transactionId,
                traceId: proposal.traceId,
                symbol: proposal.symbol,
                side: proposal.side,
                approved: result.approved,
                maxQuantity: result.maxQuantity,
                rejectionGate: result.rejectionGate,
                accountEquity: result.accountEquity,
                buyingPower: result.buyingPower,
                reasoning: result.reasoning,
                createdAt: new Date().toISOString(),
            });
            if (result.gateResults.length > 0) {
                await db.insert(schema.riskGateResults).values(
                    result.gateResults.map((g, i) => ({
                        traceId: proposal.traceId,
                        gateName: g.gate,
                        sequence: i,
                        passed: g.passed,
                        detail: JSON.stringify(g.detail),
                    }))
                );
            }
        } catch (e) {
            console.error('[Risk Engine] Failed to persist risk assessment', e);
        }
    }
}
export const riskEngine = RiskEngine.getInstance();
