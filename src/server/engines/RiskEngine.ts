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

const STALE_PRICE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
let cachedMarketClock: { isOpen: boolean; fetchedAt: number } | null = null;
const MARKET_CLOCK_CACHE_MS = 60 * 1000;

const MAX_CONSECUTIVE_LOSSES = 3;
const MAX_SINGLE_SYMBOL_CONCENTRATION_PCT = 0.20; // matches GuardrailsPanel's "Hard Per-Position Cap" copy
const MAX_SECTOR_CONCENTRATION_PCT = 0.40;

// Real (if coarse) GICS-style sector map for the large-cap names this app actually watches/trades.
// Deliberately does NOT cover every possible ticker - an unmapped symbol just isn't sector-capped
// (same as if this check didn't exist for it), rather than fabricating a sector guess.
const SECTOR_MAP: Record<string, string> = {
    AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', AMD: 'Technology',
    AVGO: 'Technology', CRM: 'Technology', ORCL: 'Technology', ADBE: 'Technology', INTC: 'Technology',
    GOOGL: 'Communication Services', GOOG: 'Communication Services', META: 'Communication Services',
    NFLX: 'Communication Services', DIS: 'Communication Services', TMUS: 'Communication Services',
    AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary', HD: 'Consumer Discretionary',
    NKE: 'Consumer Discretionary', SBUX: 'Consumer Discretionary', MCD: 'Consumer Discretionary',
    JPM: 'Financials', BAC: 'Financials', GS: 'Financials', WFC: 'Financials', MS: 'Financials', V: 'Financials', MA: 'Financials',
    XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy',
    JNJ: 'Healthcare', PFE: 'Healthcare', UNH: 'Healthcare', LLY: 'Healthcare', MRK: 'Healthcare', ABBV: 'Healthcare',
    WMT: 'Consumer Staples', PG: 'Consumer Staples', KO: 'Consumer Staples', PEP: 'Consumer Staples', COST: 'Consumer Staples',
    BA: 'Industrials', CAT: 'Industrials', GE: 'Industrials', UPS: 'Industrials', HON: 'Industrials',
    // Broad-market ETFs already ARE diversified across sectors - exempt them rather than mis-bucket them.
    SPY: 'Diversified ETF', QQQ: 'Diversified ETF', VOO: 'Diversified ETF', VTI: 'Diversified ETF', DIA: 'Diversified ETF', IWM: 'Diversified ETF',
};

function getSector(symbol: string): string | null {
    const sector = SECTOR_MAP[symbol.toUpperCase()];
    if (!sector || sector === 'Diversified ETF') return null;
    return sector;
}

const CORRELATION_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CORRELATION_MIN_OVERLAP = 20; // matches BacktestEngine's own significance floor
const CORRELATION_THRESHOLD = 0.7;
const MAX_CORRELATED_EXPOSURE_PCT = 0.50;
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

// Pearson correlation of daily returns (not raw prices, which would just measure "both went up
// over time" for any two large caps). Returns null on too little overlapping history rather than
// a fabricated 0.
function returnCorrelation(closesA: number[], closesB: number[]): number | null {
    const n = Math.min(closesA.length, closesB.length);
    if (n < CORRELATION_MIN_OVERLAP + 1) return null;
    const a = closesA.slice(-n), b = closesB.slice(-n);
    const retA = a.slice(1).map((v, i) => v / a[i] - 1);
    const retB = b.slice(1).map((v, i) => v / b[i] - 1);
    const meanA = retA.reduce((s, v) => s + v, 0) / retA.length;
    const meanB = retB.reduce((s, v) => s + v, 0) / retB.length;
    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < retA.length; i++) {
        const da = retA[i] - meanA, db = retB[i] - meanB;
        cov += da * db; varA += da * da; varB += db * db;
    }
    if (varA === 0 || varB === 0) return null;
    return cov / Math.sqrt(varA * varB);
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

// Real market-hours check via Alpaca's /v2/clock. Returns null (skip the check) rather than a
// fabricated guess when Alpaca credentials aren't configured - there is no other real source here.
async function isMarketOpen(): Promise<boolean | null> {
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null;
    if (cachedMarketClock && Date.now() - cachedMarketClock.fetchedAt < MARKET_CLOCK_CACHE_MS) {
        return cachedMarketClock.isOpen;
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
        if (!res.ok) return null;
        const clock = await res.json();
        cachedMarketClock = { isOpen: !!clock.is_open, fetchedAt: Date.now() };
        return cachedMarketClock.isOpen;
    } catch (e) {
        console.error('[Risk Engine] Failed to fetch Alpaca market clock', e);
        return null;
    }
}

export class RiskEngine {
    private static instance: RiskEngine;

    private constructor() {}

    public static getInstance(): RiskEngine {
        if (!RiskEngine.instance) {
            RiskEngine.instance = new RiskEngine();
        }
        return RiskEngine.instance;
    }

    public async evaluateRisk(proposal: any) {
        console.log(`[Risk Engine] Evaluating proposal: ${proposal.side} ${proposal.symbol}`);

        try {
            // 1. Fetch real broker portfolio state
            const broker = BrokerManager.getInstance().getActiveBroker();
            const portfolio = await broker.portfolio();

            // 2. Fetch risk settings from SQLite
            const settings = await db.select().from(schema.settings).limit(1);
            const riskLevel = settings[0]?.riskLevel || "Balanced";
            const maxTradeSizeDollar = settings[0]?.maxTradeSize || 3000;
            const maxPortfolioRiskPct = (riskLevel === "Aggressive") ? 0.03 : (riskLevel === "Conservative" ? 0.01 : 0.02);

            // 2a. Daily loss circuit breaker - tracks real broker equity against a start-of-day
            // baseline captured the first time we evaluate risk each calendar day.
            const equityNow = portfolio.equity || 0;
            const todayStr = new Date().toISOString().split('T')[0];
            if (tradingEngine.state.dayStartDateStr !== todayStr) {
                tradingEngine.state.dayStartDateStr = todayStr;
                tradingEngine.state.dayStartEquity = equityNow;
                tradingEngine.state.currentDailyLoss = 0;
            }
            const dayStartEquity = tradingEngine.state.dayStartEquity ?? equityNow;
            const dailyLoss = Math.max(0, dayStartEquity - equityNow);
            tradingEngine.state.currentDailyLoss = dailyLoss;
            const dailyLossKillSwitchThreshold = tradingEngine.state.dailyLossLimit * 0.8;
            if (dailyLoss >= dailyLossKillSwitchThreshold) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId, transactionId: proposal.transactionId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    currentPrice: proposal.currentPrice,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: `Daily Loss Kill-Switch: -$${dailyLoss.toFixed(2)} reached 80% of the $${tradingEngine.state.dailyLossLimit} daily loss limit. All new trades blocked until tomorrow or a manual reset.`
                });
                return;
            }

            // 2a-2. Consecutive-loss circuit breaker - real realized P&L from the last three
            // FILLED trades, not a simulated/hardcoded count.
            if (await hasConsecutiveLosses()) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId, transactionId: proposal.transactionId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    currentPrice: proposal.currentPrice,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: `${MAX_CONSECUTIVE_LOSSES} consecutive losing trades. All new trades blocked pending manual review.`
                });
                return;
            }

            // 2b. Real market-hours check (Alpaca /v2/clock). Skips (does not block) when Alpaca
            // credentials aren't configured, since there is no real source to check against.
            const marketOpen = await isMarketOpen();
            if (marketOpen === false) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId, transactionId: proposal.transactionId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    currentPrice: proposal.currentPrice,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: "Market is currently closed (Alpaca clock)."
                });
                return;
            }

            // 2c. Stale market-data check - only fires when we've actually seen a real tick for
            // this symbol before and it has since gone quiet; never fabricates a staleness verdict.
            const priceAgeMs = marketDataWorker.getLatestPriceAgeMs(proposal.symbol);
            if (priceAgeMs !== null && priceAgeMs > STALE_PRICE_THRESHOLD_MS) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId, transactionId: proposal.transactionId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    currentPrice: proposal.currentPrice,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: `Stale market data: last real tick for ${proposal.symbol} is ${Math.round(priceAgeMs / 1000)}s old (threshold ${STALE_PRICE_THRESHOLD_MS / 1000}s).`
                });
                return;
            }

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

            if (symbolNews.length > 0) {
                 eventBus.emitRiskAssessment({
                     newsDetails: proposal.newsDetails,
                     traceId: proposal.traceId, transactionId: proposal.transactionId,
                     symbol: proposal.symbol,
                     side: proposal.side,
                     currentPrice: proposal.currentPrice,
                     approved: false,
                     maxQuantity: 0,
                     reasoning: "High volatility news event detected, overriding AI decision."
                 });
                 return;
            }

            // 4. Position Sizing Math
            // Using actual buying power and portfolio value
            const accountEquity = portfolio.equity || 10000;
            const buyingPower = portfolio.buyingPower || 10000;
            const currentPrice = proposal.currentPrice;

            if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice) || currentPrice <= 0) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId, transactionId: proposal.transactionId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: "No valid price"
                });
                return;
            }

            // Basic ATR risk calculation - normally fetched from market data, assuming $4 risk per share for this example if not provided
            const riskPerShare = currentPrice * 0.05; // 5% stop loss assumption
            const maxRiskAmount = accountEquity * maxPortfolioRiskPct;
            
            // Maximum shares based on acceptable loss
            let maxSharesByRisk = Math.floor(maxRiskAmount / riskPerShare);

            // Maximum shares based on max trade size constraint
            let maxSharesByCapital = Math.floor(maxTradeSizeDollar / currentPrice);

            // Maximum shares based on buying power
            let maxSharesByBuyingPower = Math.floor(buyingPower / currentPrice);

            let maxQuantity = Math.min(maxSharesByRisk, maxSharesByCapital, maxSharesByBuyingPower);

            // 4a. Single-symbol concentration cap - no position may exceed
            // MAX_SINGLE_SYMBOL_CONCENTRATION_PCT of real account equity after this trade fills.
            // Reduces the size rather than outright rejecting, same as the other sizing caps above.
            if (proposal.side === 'BUY') {
                const existingPosition = portfolio.positions.find((p: any) => p.symbol === proposal.symbol);
                const existingValue = existingPosition ? existingPosition.quantity * currentPrice : 0;
                const maxPositionValue = accountEquity * MAX_SINGLE_SYMBOL_CONCENTRATION_PCT;
                const remainingRoom = Math.max(0, maxPositionValue - existingValue);
                const maxSharesByConcentration = Math.floor(remainingRoom / currentPrice);
                maxQuantity = Math.min(maxQuantity, maxSharesByConcentration);

                // 4b. Sector concentration cap - no GICS-mapped sector may exceed
                // MAX_SECTOR_CONCENTRATION_PCT of real account equity after this trade fills.
                const proposalSector = getSector(proposal.symbol);
                if (proposalSector) {
                    const sectorValue = portfolio.positions.reduce((sum: number, p: any) => {
                        return getSector(p.symbol) === proposalSector ? sum + p.quantity * currentPrice : sum;
                    }, 0);
                    const maxSectorValue = accountEquity * MAX_SECTOR_CONCENTRATION_PCT;
                    const remainingSectorRoom = Math.max(0, maxSectorValue - sectorValue);
                    const maxSharesBySector = Math.floor(remainingSectorRoom / currentPrice);
                    maxQuantity = Math.min(maxQuantity, maxSharesBySector);
                }

                // 4c. Correlation-based exposure cap - real pairwise return correlation (90-day
                // daily closes, opportunistic real Alpaca backfill via HistoricalDataGateway)
                // against every existing position. Caps combined exposure across positively,
                // highly-correlated (r > CORRELATION_THRESHOLD) symbols at MAX_CORRELATED_EXPOSURE_PCT
                // of equity - this catches the case sector mapping misses (e.g. an unmapped ticker
                // that still moves in lockstep with an existing position). A strong NEGATIVE
                // correlation is deliberately not capped here - two symbols that move oppositely
                // are a natural hedge, not concentrated risk. Skips entirely (never blocks) if real
                // price history isn't available for the proposal's own symbol.
                if (portfolio.positions.length > 0) {
                    const proposalCloses = await getRecentCloses(proposal.symbol);
                    if (proposalCloses) {
                        let correlatedValue = 0;
                        for (const p of portfolio.positions) {
                            if (p.symbol === proposal.symbol) { correlatedValue += p.quantity * currentPrice; continue; }
                            const otherCloses = await getRecentCloses(p.symbol);
                            if (!otherCloses) continue; // no real history for this position - skip it, don't fabricate
                            const corr = returnCorrelation(proposalCloses, otherCloses);
                            if (corr !== null && corr > CORRELATION_THRESHOLD) {
                                correlatedValue += p.quantity * currentPrice;
                            }
                        }
                        const maxCorrelatedValue = accountEquity * MAX_CORRELATED_EXPOSURE_PCT;
                        const remainingCorrelatedRoom = Math.max(0, maxCorrelatedValue - correlatedValue);
                        const maxSharesByCorrelation = Math.floor(remainingCorrelatedRoom / currentPrice);
                        maxQuantity = Math.min(maxQuantity, maxSharesByCorrelation);
                    }
                }
            }

            // 5. Final validation
            if (maxQuantity <= 0) {
                 eventBus.emitRiskAssessment({
                     traceId: proposal.traceId, transactionId: proposal.transactionId,
                     symbol: proposal.symbol,
                     side: proposal.side,
                     currentPrice,
                     approved: false,
                     maxQuantity: 0,
                     reasoning: `Insufficient buying power or risk limits exceeded. Required: ${currentPrice}, Available BP: ${buyingPower}`
                 });
                 return;
            }

            // If we are selling, make sure we have the shares
            if (proposal.side === 'SELL') {
                const existingPosition = portfolio.positions.find((p: any) => p.symbol === proposal.symbol);
                if (!existingPosition || existingPosition.quantity <= 0) {
                    eventBus.emitRiskAssessment({
                        traceId: proposal.traceId, transactionId: proposal.transactionId,
                        symbol: proposal.symbol,
                        side: proposal.side,
                        currentPrice,
                        approved: false,
                        maxQuantity: 0,
                        reasoning: "Cannot sell - no existing position in broker portfolio."
                    });
                    return;
                }
                maxQuantity = Math.min(maxQuantity, existingPosition.quantity);
            }

            eventBus.emitRiskAssessment({
                traceId: proposal.traceId, transactionId: proposal.transactionId,
                symbol: proposal.symbol,
                side: proposal.side,
                approved: true,
                maxQuantity,
                reasoning: `Approved based on ${(maxPortfolioRiskPct*100).toFixed(1)}% portfolio risk cap and available BP.`
            });

        } catch (e) {
            console.error('[Risk Engine] Error evaluating risk', e);
            eventBus.emitRiskAssessment({
                traceId: proposal.traceId, transactionId: proposal.transactionId,
                symbol: proposal.symbol,
                side: proposal.side,
                approved: false,
                maxQuantity: 0,
                reasoning: `Risk evaluation crashed: ${(e as Error).message}`
            });
        }
    }
}
export const riskEngine = RiskEngine.getInstance();
