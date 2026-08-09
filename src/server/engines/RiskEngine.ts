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
import { BrokerManager } from '../../brokers/BrokerManager';
import { tradingEngine } from './TradingEngine';
import { marketDataWorker } from '../services/MarketDataWorker';

const STALE_PRICE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
let cachedMarketClock: { isOpen: boolean; fetchedAt: number } | null = null;
const MARKET_CLOCK_CACHE_MS = 60 * 1000;

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
            if (dailyLoss >= tradingEngine.state.dailyLossLimit) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    currentPrice: proposal.currentPrice,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: `Daily loss limit reached: -$${dailyLoss.toFixed(2)} (limit $${tradingEngine.state.dailyLossLimit}). All new trades blocked until tomorrow or a manual reset.`
                });
                return;
            }

            // 2b. Real market-hours check (Alpaca /v2/clock). Skips (does not block) when Alpaca
            // credentials aren't configured, since there is no real source to check against.
            const marketOpen = await isMarketOpen();
            if (marketOpen === false) {
                eventBus.emitRiskAssessment({
                    traceId: proposal.traceId,
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
                    traceId: proposal.traceId,
                    symbol: proposal.symbol,
                    side: proposal.side,
                    currentPrice: proposal.currentPrice,
                    approved: false,
                    maxQuantity: 0,
                    reasoning: `Stale market data: last real tick for ${proposal.symbol} is ${Math.round(priceAgeMs / 1000)}s old (threshold ${STALE_PRICE_THRESHOLD_MS / 1000}s).`
                });
                return;
            }

            // 3. News risk validation
            const recentNews = await db.select().from(schema.newsArticles).limit(20);
            const symbolNews = recentNews.filter((n: any) => 
                n.symbols && n.symbols.includes(proposal.symbol) &&
                n.impactScore && n.impactScore > 80
            );

            if (symbolNews.length > 0) {
                 eventBus.emitRiskAssessment({
                     newsDetails: proposal.newsDetails,
                     traceId: proposal.traceId,
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
                    traceId: proposal.traceId,
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

            // 5. Final validation
            if (maxQuantity <= 0) {
                 eventBus.emitRiskAssessment({
                     traceId: proposal.traceId,
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
                        traceId: proposal.traceId,
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
                traceId: proposal.traceId,
                symbol: proposal.symbol,
                side: proposal.side,
                approved: true,
                maxQuantity,
                reasoning: `Approved based on ${(maxPortfolioRiskPct*100).toFixed(1)}% portfolio risk cap and available BP.`
            });

        } catch (e) {
            console.error('[Risk Engine] Error evaluating risk', e);
            eventBus.emitRiskAssessment({
                traceId: proposal.traceId,
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
