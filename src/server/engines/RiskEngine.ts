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
import { EVENTS } from '../core/eventNames';
import { db } from '../db';
import * as schema from '../db/schema';
import { desc, isNotNull, and, eq, gte, like, or } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { tradingEngine } from './TradingEngine';
import { marketDataWorker } from '../services/MarketDataWorker';
import { historicalDataGateway } from './backtest/HistoricalDataGateway';
import { calculatePositionSizing, CORRELATION_MIN_OVERLAP } from './PositionSizing';
import { runWithObservabilityContext } from '../observability/ObservabilityContext';
import { getTradingDateStr, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { evaluateExtendedHoursExecutionPolicy, isExtendedHoursSession } from '../risk/ExtendedHoursExecutionPolicy';
import { getCachedAvgDailyVolumeShares } from '../risk/ExtendedHoursLiquidityCache';
import { applyRestrictedLiveCaps } from './RestrictedLiveMode';
import { applySubordinateAssetNotionalCap } from '../multiAsset/ideaEligibility';
import { snapshotCapital, evaluateAllocationGuard } from './CapitalAllocation';
import { reservePendingCapital, snapshotReservedNotional } from './PendingCapitalReservations';
import { evaluateDailyBuyNotional, resolveDailyBuyNotionalCap, sumDailyBuyNotional } from './DailyBuyNotional';
import { campaignVelocityMaxTradeDollars } from '../services/campaignIntraday';
import { tradingSafety, portfolioRiskPctForLevel, isExtendedHoursExecutionEnabled } from '../config/tradingSafety';
import { alpacaFetch } from '../core/alpacaTls';
import { INVALID_ACCOUNT_EQUITY, isPositiveFiniteMoney } from './AccountEquity';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import {
  evaluateDailyTradeLimit,
  evaluateDuplicateSignal,
  evaluatePostLossCooldown,
  evaluateSameSymbolCooldown,
} from '../risk/OvertradingGuards';
import { clusterCoversSymbol, newsImpactOnVetoScale } from '../news/newsClusterMatch';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { evaluateQuoteFreshness } from '../core/marketDataQuality';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { performance } from 'node:perf_hooks';
import { getActiveReplaySession, replayVisibleBars } from '../replay/ReplayContext';
import { classifyMarketSession, sessionAllowsFills } from '../replay/marketSession';
import { replaySafety } from '../replay/replaySafety';
import { newsVisibleAt } from '../replay/HistoricalNewsProvider';

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
    const replay = getActiveReplaySession();
    if (replay) {
        const bars = replayVisibleBars(symbol);
        if (bars.length < CORRELATION_MIN_OVERLAP) return null;
        return bars.map((b) => b.close);
    }
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
    const recentClosed = (await db.select().from(schema.trades)
        .where(and(eq(schema.trades.status, 'FILLED'), isNotNull(schema.trades.profitLoss)))
        .orderBy(desc(schema.trades.timestamp))
        .limit(MAX_CONSECUTIVE_LOSSES * 4))
        .filter((t: any) => t.executionEnvironment !== 'REPLAY' && t.executionEnvironment !== 'BACKTEST' && !String(t.traceId || '').startsWith(replaySafety.replayTracePrefix))
        .slice(0, MAX_CONSECUTIVE_LOSSES);
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
        // Bound the clock call: native fetch without a signal can hang indefinitely, which
        // stalls RiskEngine.evaluationQueue (serialized) and leaves transactions stuck OPEN
        // until the socket dies. Timeout → catch → 'unavailable' (fail-closed), same as HTTP
        // errors. Uses tradingSafety.alpacaRequestTimeoutMs (config JSON, not a TS literal).
        const res = await alpacaFetch(`https://${base}/v2/clock`, {
            headers: {
                'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY
            },
            signal: AbortSignal.timeout(tradingSafety.alpacaRequestTimeoutMs),
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
// Alpaca daily-bar timestamps mark the start of the trading day in exchange-local time (midnight
// ET), not market open (9:30am ET). classifyMarketSession() is an intraday minute-of-day
// classifier and would read every 1Day bar as CLOSED regardless of the simulated historical date
// (ARGUS_2024_ZERO_TRADE_FORENSIC_AUDIT.md finding #2: 198/198 real risk_assessments rows from a
// real 1Day 2024 replay run failed only this gate). A daily bar existing at all already proves the
// exchange was open that day, so there is no intraday time-of-day left to classify against.
export function isDailyReplayFrequency(frequency: string | undefined | null): boolean {
    return /^1?d(ay)?$/i.test(frequency ?? '');
}

export function resetMarketClockCacheForTests(): void {
    cachedMarketClock = null;
}

interface GateResult {
    gate: string;
    passed: boolean;
    detail: any;
}

/**
 * Real bug fix: the invalid_account_equity early-return below used to leave every gate AFTER it
 * in config/riskGateOrder.json completely unrecorded for that assessment - 17 of 24 gates missing
 * from risk_gate_results, contradicting this file's own "every gate is recorded" comment (and
 * CLAUDE.md's documented invariant). Most of those 17 gates genuinely cannot run a real check
 * without valid equity (portfolio_drawdown, order_notional_cap, concentration/correlation caps,
 * capital allocation, daily buy notional all need it) - so this does NOT fabricate a pass/fail for
 * them. It records each as an explicit, honestly-labeled SKIPPED entry so the audit trail is
 * complete (all 24 gate names present for every real assessment) without inventing a result.
 * sell_position_exists is excluded here - it's already a documented BUY/SELL-conditional
 * exception (config/riskGateOrder.json's own $comment), not something this fix should force in.
 */
const RISK_GATE_ORDER: string[] = loadRepoConfigJson<{ gates: string[] }>('riskGateOrder.json').gates;
const GATES_SKIPPED_ON_INVALID_EQUITY: string[] = RISK_GATE_ORDER
    .slice(RISK_GATE_ORDER.indexOf(INVALID_ACCOUNT_EQUITY) + 1)
    .filter(gate => gate !== 'sell_position_exists');

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
        const run = this.evaluationQueue.then(() => {
            if (proposal?.traceId) {
                return runWithObservabilityContext(
                    { decisionId: proposal.traceId, correlationId: proposal.traceId, symbol: proposal.symbol },
                    () => this.evaluateRiskSerialized(proposal),
                );
            }
            return this.evaluateRiskSerialized(proposal);
        });
        // Never let one evaluation's rejection break the queue for evaluations queued after it -
        // evaluateRiskSerialized already has its own internal top-level try/catch, so a rejection
        // reaching here would only be a truly unexpected error; the queue must still advance.
        this.evaluationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async evaluateRiskSerialized(proposal: any) {
        console.log(`[Risk Engine] Evaluating proposal: ${proposal.side} ${proposal.symbol}`);
        eventBus.emit(EVENTS.RISK_ASSESSMENT_STARTED, { traceId: proposal.traceId, transactionId: proposal.transactionId, symbol: proposal.symbol, side: proposal.side });

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
        //
        // Perf instrumentation (docs/audits/ARGUS_JAVA_PYTHON_NODE_PERFORMANCE_BOUNDARY_AUDIT.md's
        // Phase 0): recordGate is the one call every gate already passes through uniformly, so
        // timing the gap between consecutive calls gives a real per-gate cost breakdown with no
        // change to any gate's own logic. DEBUG level, same convention QuantCoreServer.java uses
        // for its own high-frequency tick log - never floods INFO-level logs by default.
        const evalStartedAtMs = performance.now();
        let lastGateTimestampMs = evalStartedAtMs;
        const gateTimingsUs: Record<string, number> = {};
        const gateResults: GateResult[] = [];
        let sequence = 0;
        const recordGate = (gate: string, passed: boolean, detail: any) => {
            const nowMs = performance.now();
            gateTimingsUs[gate] = Math.round((nowMs - lastGateTimestampMs) * 1000);
            lastGateTimestampMs = nowMs;
            gateResults.push({ gate, passed, detail });
            eventBus.emit(EVENTS.RISK_GATE_EVALUATED, { transactionId: proposal.transactionId, traceId: proposal.traceId, symbol: proposal.symbol, gate, sequence: sequence++, passed, detail });
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
            const replay = getActiveReplaySession();
            const tradingState = replay ? 'TRADING_ENABLED' : tradingEngine.state.tradingState;
            recordGate('emergency_stop', tradingState === 'TRADING_ENABLED', { tradingState, emergencyStopActive: tradingEngine.state.emergencyStopActive, replay: !!replay });
            const emergencyStopReason = tradingState === 'EMERGENCY_STOP'
                ? "Emergency stop is active. All new trades are blocked until resumed."
                : "Trading is paused. All new trades are blocked until resumed.";

            // Autobot toggle (tradingEngine.state.enabled / UI autoBotConfig.enabled) is NOT a
            // second kill switch. emergency_stop still owns TRADING_PAUSED / EMERGENCY_STOP.
            // New BUY risk requires Autobot on; SELL/exits still run while TRADING_ENABLED so
            // PortfolioMonitor can flatten existing paper positions.
            const autobotOn = replay ? replaySafety.allowBuysInReplay : tradingEngine.state.enabled === true;
            const autobotBlocksBuy = proposal.side === 'BUY' && !autobotOn;
            recordGate('autobot_enabled', !autobotBlocksBuy, {
                enabled: tradingEngine.state.enabled,
                side: proposal.side,
                note: proposal.side === 'SELL'
                    ? 'SELL/exit is not blocked by Autobot-off; emergency_stop still applies.'
                    : undefined,
            });
            const autobotReason = 'AUTOBOT_DISABLED: Autobot is off. New BUY risk is blocked. SELL/exits still require TRADING_ENABLED.';

            const nowMs = replay ? replay.clock.now() : Date.now();
            // Replay knows its own replayId, so it can push the filter into the query itself
            // instead of pulling every trade ever recorded (across all history, not just this run)
            // into JS on every single risk evaluation - a real, measured contributor to a replay
            // slowing down over a long run (grows with total accumulated trades table size, not
            // just this run's length). The live (non-replay) branch is untouched - same full fetch,
            // same JS filter - to avoid any live-path behavior change.
            const tradeRows = replay
                ? await db.select().from(schema.trades).where(
                    or(like(schema.trades.traceId, `%${replay.replayId}%`), like(schema.trades.reasoning, `%${replay.replayId}%`)),
                  )
                : (await db.select().from(schema.trades)).filter((t: any) => t.executionEnvironment !== 'REPLAY' && t.executionEnvironment !== 'BACKTEST' && !String(t.traceId || '').startsWith(replaySafety.replayTracePrefix));
            const sameSymbol = evaluateSameSymbolCooldown({ side: proposal.side, symbol: proposal.symbol, nowMs, trades: tradeRows });
            recordGate(sameSymbol.gate, sameSymbol.passed, sameSymbol.detail);
            const postLoss = evaluatePostLossCooldown({ side: proposal.side, nowMs, trades: tradeRows });
            recordGate(postLoss.gate, postLoss.passed, postLoss.detail);
            const dailyTrades = evaluateDailyTradeLimit({ side: proposal.side, nowMs, trades: tradeRows });
            recordGate(dailyTrades.gate, dailyTrades.passed, dailyTrades.detail);
            // duplicate_signal rows use wall-clock createdAt. Replay nowMs is historical (bar T),
            // so `gte(createdAt, T-60s)` would match years of live/prior assessments and false-block
            // MODE B. Scope to this replayId + wall clock, or skip (replay already dedupes via openStops).
            let duplicate: { gate: string; passed: boolean; detail: Record<string, unknown>; reason: string };
            if (replay) {
              duplicate = {
                gate: 'duplicate_signal',
                passed: true,
                detail: { skipped: true, reason: 'replay_session_uses_openStops_dedup', replayId: replay.replayId },
                reason: 'n/a',
              };
            } else {
              const dupAssessments = await db.select().from(schema.riskAssessments)
                .where(gte(schema.riskAssessments.createdAt, new Date(nowMs - tradingSafety.duplicateSignalWindowMs).toISOString()));
              duplicate = evaluateDuplicateSignal({
                side: proposal.side,
                symbol: proposal.symbol,
                nowMs,
                assessments: dupAssessments as any,
              });
            }
            recordGate(duplicate.gate, duplicate.passed, duplicate.detail);

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
                // Order-notional cap from settings. Fallback is tradingSafety.defaultMaxTradeSizeDollars
                // (not InternalPaper seed cash / paperInitialCapital).
                maxTradeSizeDollar: settings[0]?.maxTradeSize || tradingSafety.defaultMaxTradeSizeDollars,
                maxOpenPositions: settings[0]?.maxOpenPositions ?? 10,
                dailyLossLimitDollars: tradingEngine.state.dailyLossLimit,
            });
            // Replay session owns research capital — do not leak live settings.budget into MODE B.
            let maxTradeSizeDollar = restrictedLiveCaps.maxTradeSizeDollar;
            let maxOpenPositions = restrictedLiveCaps.maxOpenPositions;
            let dailyLossLimitDollars = restrictedLiveCaps.dailyLossLimitDollars;
            if (replay) {
                maxTradeSizeDollar = Math.min(
                    maxTradeSizeDollar,
                    Number(replay.config.maxPositionSize) > 0 ? replay.config.maxPositionSize : replay.config.allocationBudget,
                    replay.config.allocationBudget,
                );
                dailyLossLimitDollars = Number(replay.config.maxDailyLoss) > 0
                    ? replay.config.maxDailyLoss
                    : dailyLossLimitDollars;
            }

            // Campaign capital velocity: size against remaining Argus allocation and slot budget
            // (2–3 concurrent names). Still cannot exceed Gate 23; never loosens maxTradeSize.
            const campaignBudget = Number(settings[0]?.budget ?? 0);
            if (settings[0]?.campaignEnabled && Number.isFinite(campaignBudget) && campaignBudget > 0) {
                const holdingsForAlloc = await db.select().from(schema.portfolio);
                const pendingBuyRows = await db.select().from(schema.trades).where(eq(schema.trades.side, 'BUY'));
                const pendingBuys = pendingBuyRows.filter(
                    (t) => t.status && !['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(String(t.status)),
                );
                const snap = snapshotCapital({
                    allocated: campaignBudget,
                    positions: holdingsForAlloc.map((h) => ({ quantity: h.quantity, averagePrice: h.averagePrice })),
                    pendingBuys: pendingBuys.map((t) => ({
                        quantity: t.quantity, price: t.price, side: t.side, status: t.status ?? undefined,
                    })),
                });
                maxTradeSizeDollar = campaignVelocityMaxTradeDollars({
                    maxTradeSizeDollar,
                    budget: campaignBudget,
                    remainingAllocation: snap.remaining,
                });
                maxOpenPositions = Math.min(
                    maxOpenPositions,
                    tradingSafety.campaignMaxConcurrentPositions,
                );
            }

            if (!isPositiveFiniteMoney(portfolio.equity)) {
                recordGate(INVALID_ACCOUNT_EQUITY, false, { equity: portfolio.equity, buyingPower: portfolio.buyingPower });
                for (const gate of GATES_SKIPPED_ON_INVALID_EQUITY) {
                    recordGate(gate, false, { status: 'SKIPPED_INVALID_ACCOUNT_EQUITY', reason: 'Not evaluated - trading already fail-closed on invalid_account_equity before this gate could run.' });
                }
                approved = false;
                maxQuantity = 0;
                // Real bug found and fixed this pass: this branch used to always report
                // INVALID_ACCOUNT_EQUITY as the rejection reason, even when an earlier gate
                // (emergency_stop, autobot_enabled, same_symbol_cooldown, post_loss_cooldown,
                // daily_trade_limit, duplicate_signal - all already recorded above) had already
                // failed first. That contradicted this module's own "first gate to fail in this
                // order" contract and misdirected incident triage (e.g. reporting a bad equity
                // read during a broker outage instead of the real cause: trading already paused).
                const earlyFirstFailure = gateResults.find(g => !g.passed);
                const rejectionGate = earlyFirstFailure?.gate ?? INVALID_ACCOUNT_EQUITY;
                reasoning = rejectionGate === 'emergency_stop' ? emergencyStopReason
                    : rejectionGate === 'autobot_enabled' ? autobotReason
                    : rejectionGate === 'same_symbol_cooldown' ? sameSymbol.reason
                    : rejectionGate === 'post_loss_cooldown' ? postLoss.reason
                    : rejectionGate === 'daily_trade_limit' ? dailyTrades.reason
                    : rejectionGate === 'duplicate_signal' ? duplicate.reason
                    : 'INVALID_ACCOUNT_EQUITY: broker equity is missing or not positive. No placeholder balance is used.';
                await this.persistThenPublishAssessment(proposal, {
                    approved: false, maxQuantity: 0, reasoning,
                    rejectionGate,
                    accountEquity: undefined, buyingPower: portfolio.buyingPower,
                    gateResults,
                });
                return;
            }
            recordGate(INVALID_ACCOUNT_EQUITY, true, { equity: portfolio.equity });
            accountEquity = portfolio.equity;
            buyingPower = isPositiveFiniteMoney(portfolio.buyingPower) ? portfolio.buyingPower : 0;

            // 2a. Daily loss circuit breaker - tracks real broker equity against a start-of-day
            // baseline captured the first time we evaluate risk each calendar day. Uses the real
            // exchange trading day (America/New_York), not UTC - UTC midnight is 7-8 PM New York
            // time, which would reset this baseline mid-session instead of at the real start of
            // the trading day.
            const equityNow = accountEquity;
            const todayStr = getTradingDateStr(new Date(nowMs));
            if (tradingEngine.state.dayStartDateStr !== todayStr) {
                tradingEngine.state.dayStartDateStr = todayStr;
                tradingEngine.state.dayStartEquity = equityNow;
                tradingEngine.state.currentDailyLoss = 0;
            }
            const dayStartEquity = tradingEngine.state.dayStartEquity ?? equityNow;
            const dailyLoss = Math.max(0, dayStartEquity - equityNow);
            tradingEngine.state.currentDailyLoss = dailyLoss;
            const dailyLossKillSwitchThreshold = dailyLossLimitDollars * tradingSafety.dailyLossKillSwitchFraction;
            const dailyLossPassed = dailyLoss < dailyLossKillSwitchThreshold;
            recordGate('daily_loss', dailyLossPassed, { dailyLoss, threshold: dailyLossKillSwitchThreshold, limit: dailyLossLimitDollars, restrictedLiveModeActive: restrictedLiveCaps.restricted, replay: !!replay });
            const dailyLossReason = `Daily Loss Kill-Switch: -$${dailyLoss.toFixed(2)} reached ${tradingSafety.dailyLossKillSwitchFraction * 100}% of the $${dailyLossLimitDollars}${restrictedLiveCaps.restricted ? ' (restricted live mode cap)' : ''}${replay ? ' (replay config)' : ''} daily loss limit. All new trades blocked until tomorrow or a manual reset.`;

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
            //
            // Real defect found and fixed (2026-08-24 readiness audit): this gate was the only one
            // in this function with no replay branch - every sibling gate above (emergency_stop,
            // autobot_enabled, duplicate_signal, ...) explicitly isolates replay from live state, but
            // this one unconditionally read AND WROTE the shared settings.peakEquity row regardless
            // of whether equityNow came from the live broker or a replay's own isolated
            // HistoricalReplayBroker. A replay's own equity curve is already tracked independently
            // (FullArgusReplayEngine.ts ratchets session.peakEquity on every bar, seeded from that
            // run's own config.initialCapital) - reusing that existing isolated field, rather than
            // inventing a parallel one, means a replay session with equity above the live peak can
            // no longer silently overwrite the live drawdown reference, and a replay's own (possibly
            // very different) starting capital can no longer be measured against a stale live peak.
            const maxDrawdownPct = settings[0]?.maxPortfolioDrawdownPct ?? 0.15;
            let peakEquity: number;
            if (replay) {
                if (replay.peakEquity == null || equityNow > replay.peakEquity) replay.peakEquity = equityNow;
                peakEquity = replay.peakEquity;
            } else {
                const storedPeakEquity = settings[0]?.peakEquity ?? null;
                peakEquity = (storedPeakEquity === null || equityNow > storedPeakEquity) ? equityNow : storedPeakEquity;
                if (peakEquity !== storedPeakEquity) {
                    try { await db.update(schema.settings).set({ peakEquity }).run(); } catch (e) { console.error('[Risk Engine] Failed to persist new peak equity', e); }
                }
            }
            const drawdownPct = peakEquity > 0 ? Math.max(0, (peakEquity - equityNow) / peakEquity) : 0;
            const drawdownPassed = drawdownPct < maxDrawdownPct;
            recordGate('portfolio_drawdown', drawdownPassed, { drawdownPct, maxDrawdownPct, peakEquity, equityNow, replay: !!replay });
            const drawdownReason = `Portfolio drawdown ${(drawdownPct * 100).toFixed(1)}% from peak equity $${peakEquity.toFixed(2)} exceeds the configured ${(maxDrawdownPct * 100).toFixed(0)}% limit. All new trades blocked pending manual review.`;

            // 2a-4. Order-rate limit - counts real risk_assessments rows created in the last 60
            // seconds (any symbol/side), not just this symbol's. Catches a runaway agent/loop
            // bug generating far more proposals than any real strategy should, independent of
            // whether any individual proposal would otherwise pass every other gate.
            const maxOrdersPerMinute = settings[0]?.maxOrdersPerMinute ?? 5;
            // createdAt is wall-clock; never use historical replay nowMs as the SQL lower bound.
            const orderRateWindowStartMs = replay ? Date.now() - 60 * 1000 : nowMs - 60 * 1000;
            const oneMinuteAgo = new Date(orderRateWindowStartMs).toISOString();
            const recentAssessmentsRaw = await db.select().from(schema.riskAssessments)
                .where(gte(schema.riskAssessments.createdAt, oneMinuteAgo));
            const recentAssessments = replay
                ? recentAssessmentsRaw.filter((a: any) => String(a.traceId || '').includes(replay.replayId))
                : recentAssessmentsRaw.filter((a: any) => !String(a.traceId || '').startsWith(replaySafety.replayTracePrefix));
            const recentOrderCount = recentAssessments.length;
            // MAX-speed replay can evaluate many bars within one wall-clock minute; rate limit is a
            // live runaway guard, not a historical path constraint.
            const orderRatePassed = replay ? true : recentOrderCount < maxOrdersPerMinute;
            recordGate('order_rate_limit', orderRatePassed, { recentOrderCount, maxOrdersPerMinute, replay: !!replay, skipped: !!replay });
            const orderRateReason = `Order rate limit exceeded: ${recentOrderCount} risk assessments in the last 60s (limit ${maxOrdersPerMinute}). Possible runaway signal loop - new trades blocked until the rate subsides.`;

            // 2b. Alpaca /v2/clock. Unconfigured → skip. Closed or clock outage → block.
            // Previously `null !== false` passed the gate on REST failure (outage treated as open).
            // Daily (1Day) replay bars get a separate, narrower path - see isDailyReplayFrequency's
            // own comment. This is not a blanket bypass: intraday frequencies (1m/5m/15m/1h) still
            // go through the real minute-of-day classifier below.
            const isDailyFrequency = replay ? isDailyReplayFrequency(replay.config.frequency) : false;
            const marketClock = replay
                ? (isDailyFrequency
                    ? 'open'
                    : (sessionAllowsFills(classifyMarketSession(nowMs, replay.config.timezone, replay.config.extendedHours), replay.config.extendedHours) ? 'open' : 'closed'))
                : await readMarketClock();
            // Session-Aware Trading Architecture Phase 5 (2026-09-05): extendedHoursEnabled is
            // false for every replay evaluation and false live unless the operator has explicitly
            // set EXTENDED_HOURS_EXECUTION_ENABLED - in both of those (today, universal) cases
            // liveSessionForExtendedHours stays 'CLOSED' and extendedHoursAllowsFills stays false,
            // so marketHoursPassed below is IDENTICAL to its pre-existing expression. This only
            // ever adds a new way to PASS (never a new way to fail) gate 12, and only when the
            // operator has opted in.
            const extendedHoursEnabled = !replay && isExtendedHoursExecutionEnabled();
            const liveSessionForExtendedHours = extendedHoursEnabled
                ? classifyMarketSession(nowMs, TRADING_TIMEZONE, true)
                : ('CLOSED' as const);
            const extendedHoursAllowsFills = extendedHoursEnabled && sessionAllowsFills(liveSessionForExtendedHours, true);
            const marketHoursPassed = marketClock === 'open' || marketClock === 'unconfigured' || extendedHoursAllowsFills;
            recordGate('market_hours', marketHoursPassed, {
                marketClock, skipped: marketClock === 'unconfigured', replay: !!replay, dailyBarSessionAssumed: isDailyFrequency,
                extendedHoursEnabled, extendedHoursSession: extendedHoursEnabled ? liveSessionForExtendedHours : undefined,
            });
            const marketHoursReason = marketClock === 'unavailable'
                ? 'Alpaca market clock unavailable (HTTP/network failure). Fail-closed: new trades blocked until the clock can be read.'
                : 'Market is currently closed (Alpaca clock).';

            // 2c. Stale market-data check - only fires when we've actually seen a real tick for
            // this symbol before and it has since gone quiet; never fabricates a staleness verdict.
            const priceAgeMs = replay ? 0 : marketDataWorker.getLatestPriceAgeMs(proposal.symbol);
            const freshness = replay
                ? { passed: true, priceAgeMs: 0, thresholdMs: STALE_PRICE_THRESHOLD_MS, grade: 'replay_bar', reason: 'Replay uses last completed bar at T; daily age is not live-tick staleness.' }
                : evaluateQuoteFreshness({ priceAgeMs, staleThresholdMs: STALE_PRICE_THRESHOLD_MS });
            recordGate('data_freshness', freshness.passed, {
              priceAgeMs: freshness.priceAgeMs,
              thresholdMs: freshness.thresholdMs,
              grade: (freshness as any).grade,
              replay: !!replay,
            });
            const staleDataReason = freshness.reason;

            // 3. News risk validation - impactScore lives on news_clusters, not news_articles
            // (news_articles has no impactScore column at all, so this always evaluated to
            // "no high-impact news" regardless of real news). Limited to a 4-hour window so a
            // stale high-impact cluster doesn't veto trades indefinitely.
            const fourHoursAgo = new Date(nowMs - tradingSafety.newsVetoWindowMs).toISOString();
            let symbolNews: any[] = [];
            if (replay) {
                const pitNews = newsVisibleAt(replay.news, replay.cutoff, proposal.symbol);
                symbolNews = pitNews.filter((n) => n.publishedAt >= nowMs - tradingSafety.newsVetoWindowMs && typeof n.sentiment === 'number' && n.sentiment < -0.99);
            } else {
                const recentClusters = await db.select().from(schema.newsClusters)
                    .where(gte(schema.newsClusters.updatedAt, fourHoursAgo));
                symbolNews = recentClusters.filter((n: any) =>
                    clusterCoversSymbol(n.symbols, proposal.symbol) &&
                    typeof n.impactScore === 'number' &&
                    newsImpactOnVetoScale(n.impactScore) > tradingSafety.newsVetoMinImpactScore
                );
            }
            recordGate('news_veto', symbolNews.length === 0, { matchingClusters: symbolNews.length, replay: !!replay });
            const newsVetoReason = "High volatility news event detected, overriding AI decision.";

            // 4. Position Sizing Math - using actual buying power and portfolio value
            const currentPrice = proposal.currentPrice;
            const tickerOk = !!looksLikeListedTicker(proposal.symbol);
            const priceNumericOk = typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0;
            const priceValid = tickerOk && priceNumericOk;
            const priceValidityReasonCode = !tickerOk
              ? 'INVALID_SYMBOL'
              : priceNumericOk
                ? 'OK'
                : currentPrice == null
                  ? 'MISSING_PRICE'
                  : typeof currentPrice !== 'number'
                    ? 'NON_NUMERIC_PRICE'
                    : Number.isNaN(currentPrice)
                      ? 'NAN_PRICE'
                      : !Number.isFinite(currentPrice)
                        ? 'NON_FINITE_PRICE'
                        : currentPrice <= 0
                          ? 'NON_POSITIVE_PRICE'
                          : 'INVALID_PRICE';
            recordGate('price_validity', priceValid, {
              currentPrice,
              reasonCode: priceValidityReasonCode,
            });
            const priceValidityReason = priceValid
              ? 'OK'
              : `No valid price (${priceValidityReasonCode})`;

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
                const maxOpenPositionsForSizing = maxOpenPositions;
                openPositionsCapReasonHolder.text = `Maximum open positions (${maxOpenPositionsForSizing}) already reached; cannot open a new position in ${proposal.symbol} until an existing position is closed.`;
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
                    maxTradeSizeDollar: applySubordinateAssetNotionalCap({
                        symbol: proposal.symbol,
                        currentPrice,
                        maxTradeSizeDollar,
                    }),
                    maxPortfolioRiskPct,
                    existingPositions: portfolio.positions.map((p: any) => ({ symbol: p.symbol, quantity: p.quantity })),
                    maxOpenPositions: maxOpenPositionsForSizing,
                    getRecentCloses,
                    sizingMode,
                    percentOfEquityPct,
                    failClosedUnknownInputs: tradingEngine.state.tradingMode === 'LIVE' && !replay,
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
                // Replay uses allocationBudget from ReplayConfig; live uses settings.budget.
                const rawBudget = replay
                    ? replay.config.allocationBudget
                    : (settings[0]?.budget ?? tradingEngine.state.budget);
                const allocated = isPositiveFiniteMoney(rawBudget) ? rawBudget : Number.NaN;
                // Same replay-scoped-query fix as the same_symbol_cooldown fetch above - avoids a
                // second unscoped full-table fetch per risk evaluation for replay runs.
                const allTrades = replay
                    ? await db.select().from(schema.trades).where(like(schema.trades.traceId, `%${replay.replayId}%`))
                    : (await db.select().from(schema.trades)).filter((t: any) =>
                        t.executionEnvironment !== 'REPLAY' && !String(t.traceId || '').startsWith(replaySafety.replayTracePrefix)
                      );
                const pendingBuys = (allTrades || []).filter((t: any) =>
                    t.side === 'BUY' && t.status && !['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(t.status)
                );
                const capitalSnap = snapshotCapital({
                    allocated: isPositiveFiniteMoney(allocated) ? allocated : 0,
                    positions: portfolio.positions || [],
                    pendingBuys,
                });
                const requestedNotional = proposal.side === 'BUY' ? maxQuantity * currentPrice : 0;
                // Real concurrency gap closed (docs/audits/archive/ARGUS_CAPITAL_AUDIT_REPORT.md):
                // the DB-backed pendingBuys above cannot see a same-instant sibling BUY approval
                // still awaiting OMS's async trades-row insert - fold in the in-memory reservation
                // for exactly that window (excludes this evaluation's own traceId so a retried
                // evaluation for the same idea never double-counts itself).
                const reservedInFlight = snapshotReservedNotional(proposal.traceId);
                const capitalSnapWithInFlight = reservedInFlight > 0
                    ? { ...capitalSnap, reservedPendingBuys: capitalSnap.reservedPendingBuys + reservedInFlight, used: capitalSnap.used + reservedInFlight, remaining: Math.max(0, capitalSnap.remaining - reservedInFlight) }
                    : capitalSnap;
                const capitalGuard = evaluateAllocationGuard(capitalSnapWithInFlight, proposal.side, requestedNotional);
                recordGate('argus_capital_allocation', capitalGuard.passed, capitalGuard);
                if (proposal.side === 'BUY' && capitalGuard.passed) {
                    reservePendingCapital(proposal.traceId, requestedNotional);
                }
                eventBus.emit(EVENTS.CAPITAL_CHECK, {
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

            // Gate 25 (Session-Aware Trading Architecture Phase 5, 2026-09-05). Placed after every
            // pre-existing gate so it can NEVER change which gate is reported as the first failure
            // for any scenario that already failed an earlier gate - it only ever matters when
            // gates 1-24 all pass AND this is a genuine, operator-enabled extended-hours attempt.
            // Every input below is only actually computed when extendedHoursEnabled is true - a
            // broker/adapter (real or a test double) is never asked for anything beyond what it
            // already had to support before this gate existed, in the (today, universal) disabled
            // case. evaluateExtendedHoursExecutionPolicy() itself would ignore these anyway when
            // disabled, but computing them unconditionally would mean calling broker.getCapabilities()
            // - a real broker-adapter method most callers never needed before - on every single
            // risk evaluation regardless of whether this feature is even on.
            const extendedHoursNotional = extendedHoursEnabled && Number.isFinite(maxQuantity) && Number.isFinite(currentPrice) ? maxQuantity * currentPrice : null;
            // ADV is only ever read (and its background cache refresh only ever triggered) for a
            // genuine extended-hours session attempt - never for every regular-session order just
            // because the flag happens to be on, matching every other input here's own cost discipline.
            const inExtendedHoursSession = extendedHoursEnabled && isExtendedHoursSession(liveSessionForExtendedHours);
            const extendedHoursResult = evaluateExtendedHoursExecutionPolicy({
                session: liveSessionForExtendedHours,
                extendedHoursExecutionEnabled: extendedHoursEnabled,
                brokerCapabilities: extendedHoursEnabled ? (broker.getCapabilities?.() ?? null) : null,
                quoteAgeMs: extendedHoursEnabled ? marketDataWorker.getLatestPriceAgeMs(proposal.symbol) : null,
                spreadBps: extendedHoursEnabled ? marketDataWorker.getLatestSpreadBps(proposal.symbol, tradingSafety.extendedHoursMaxQuoteAgeMs) : null,
                avgDailyVolumeShares: inExtendedHoursSession ? getCachedAvgDailyVolumeShares(proposal.symbol) : null,
                notionalDollars: extendedHoursNotional,
            });
            recordGate('extended_hours_execution_policy', extendedHoursResult.passed, extendedHoursResult.detail);
            const extendedHoursReason = extendedHoursResult.reason;

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
                    : firstFailure!.gate === 'autobot_enabled' ? autobotReason
                    : firstFailure!.gate === 'same_symbol_cooldown' ? sameSymbol.reason
                    : firstFailure!.gate === 'post_loss_cooldown' ? postLoss.reason
                    : firstFailure!.gate === 'daily_trade_limit' ? dailyTrades.reason
                    : firstFailure!.gate === 'duplicate_signal' ? duplicate.reason
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
                    : firstFailure!.gate === 'extended_hours_execution_policy' ? extendedHoursReason
                    : firstFailure!.gate === INVALID_ACCOUNT_EQUITY ? 'INVALID_ACCOUNT_EQUITY: broker equity is missing or not positive. No placeholder balance is used.'
                    : `Rejected by gate: ${firstFailure!.gate}`;
            } else {
                reasoning = `Approved based on ${(maxPortfolioRiskPct*100).toFixed(1)}% portfolio risk cap and available BP.`;
            }

            if (!approved && firstFailure) {
                const { buildDiagnostic } = await import('../diagnostics/buildDiagnostic');
                const { GATE_FIX } = await import('../diagnostics/catalog');
                if (firstFailure.gate === 'argus_capital_allocation') {
                    const d = firstFailure.detail || {};
                    eventBus.emit(EVENTS.CAPITAL_BLOCK, buildDiagnostic('CAP-001', {
                        requested: d.requestedNotional ?? '',
                        remaining: d.remaining ?? '',
                        allocated: d.allocated ?? '',
                        used: d.used ?? '',
                        brokerBuyingPower: buyingPower ?? '',
                        technicalMessage: reasoning,
                    }));
                } else {
                    eventBus.emit(EVENTS.RISK_BLOCK, buildDiagnostic('RSK-001', {
                        gate: firstFailure.gate,
                        reasoning,
                        recommendedFix: GATE_FIX[firstFailure.gate] || 'Inspect the failed gate; do not bypass RiskEngine.',
                    }));
                }
            }

            await this.persistThenPublishAssessment(proposal, { approved, maxQuantity, reasoning, rejectionGate: firstFailure?.gate ?? null, accountEquity, buyingPower, gateResults });
        } catch (e) {
            console.error('[Risk Engine] Error evaluating risk', e);
            approved = false;
            maxQuantity = 0;
            reasoning = `Risk evaluation crashed: ${(e as Error).message}`;
            await this.persistThenPublishAssessment(proposal, { approved: false, maxQuantity: 0, reasoning, rejectionGate: 'system_error', accountEquity, buyingPower, gateResults });
        } finally {
            const totalDurationUs = Math.round((performance.now() - evalStartedAtMs) * 1000);
            observeSafe(() => {
                structuredLogger.debug('risk_gate_timing', {
                    category: 'PERFORMANCE',
                    eventType: 'RISK_GATE_TIMING_US',
                    traceId: proposal.traceId,
                    decisionId: proposal.traceId,
                    symbol: proposal.symbol,
                    totalDurationUs,
                    gateTimingsUs,
                });
            });
        }
    }

    private async persistThenPublishAssessment(proposal: any, result: { approved: boolean, maxQuantity: number, reasoning: string, rejectionGate: string | null, accountEquity?: number, buyingPower?: number, gateResults: GateResult[] }) {
        const persisted = await this.persistAssessment(proposal, result);
        if (!persisted) {
            eventBus.emit(EVENTS.RISK_BLOCK, {
                gate: 'risk_assessment_persist',
                reasoning: 'RISK_ASSESSMENT_PERSIST_FAILED: assessment was not written; OMS will not execute.',
                recommendedFix: 'Inspect SQLite risk_assessments insert errors. Do not bypass RiskEngine.',
            });
            return;
        }
        eventBus.emitRiskAssessment({
            traceId: proposal.traceId, transactionId: proposal.transactionId,
            symbol: proposal.symbol,
            side: proposal.side,
            currentPrice: proposal.currentPrice,
            approved: result.approved,
            maxQuantity: result.maxQuantity,
            reasoning: result.reasoning,
            rejectionGate: result.rejectionGate,
            newsDetails: proposal.newsDetails,
            selectedQuantStrategy: proposal.selectedQuantStrategy ?? null,
            quantStopPrice: proposal.quantStopPrice ?? null,
            quantTargetPrice: proposal.quantTargetPrice ?? null,
            quantInvalidationJson: proposal.quantInvalidationJson ?? null,
        });
    }

    private async persistAssessment(proposal: any, result: { approved: boolean, maxQuantity: number, reasoning: string, rejectionGate: string | null, accountEquity?: number, buyingPower?: number, gateResults: GateResult[] }): Promise<boolean> {
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
            return true;
        } catch (e) {
            console.error('[Risk Engine] Failed to persist risk assessment', e);
            return false;
        }
    }
}
export const riskEngine = RiskEngine.getInstance();
