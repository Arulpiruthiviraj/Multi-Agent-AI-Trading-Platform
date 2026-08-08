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
import { desc } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { marketDataWorker } from '../services/MarketDataWorker';
import { TechnicalIndicators } from './TechnicalIndicators';

export class RiskEngine {
    private static instance: RiskEngine;
    private static readonly CONSECUTIVE_LOSS_LIMIT = 3;
    private static readonly MAX_CONCENTRATION_PCT = 0.30; // matches documented 30% symbol cap
    private static readonly NEWS_IMPACT_THRESHOLD = 80;
    private static readonly NEWS_LOOKBACK_MS = 4 * 60 * 60 * 1000; // 4 hours

    private constructor() {}

    public static getInstance(): RiskEngine {
        if (!RiskEngine.instance) {
            RiskEngine.instance = new RiskEngine();
        }
        return RiskEngine.instance;
    }

    private veto(proposal: any, reasoning: string) {
        console.log(`[Risk Engine] VETO ${proposal.side} ${proposal.symbol}: ${reasoning}`);
        eventBus.emitRiskAssessment({
            newsDetails: proposal.newsDetails,
            traceId: proposal.traceId,
            symbol: proposal.symbol,
            side: proposal.side,
            approved: false,
            maxQuantity: 0,
            reasoning
        });
    }

    public async evaluateRisk(proposal: any) {
        console.log(`[Risk Engine] Evaluating proposal: ${proposal.side} ${proposal.symbol}`);

        try {
            // 0. We must have a real, current price. Sizing against a fabricated/stale price
            // is worse than not trading - refuse rather than guess.
            const currentPrice = proposal.currentPrice;
            if (!currentPrice || currentPrice <= 0) {
                return this.veto(proposal, `No live price data available for ${proposal.symbol}. Refusing to size a trade on a fabricated or stale price.`);
            }

            // 1. Fetch real broker portfolio state
            const broker = BrokerManager.getInstance().getActiveBroker();
            const portfolio = await broker.portfolio();

            // 2. Fetch risk settings from SQLite
            const settings = await db.select().from(schema.settings).limit(1);
            const riskLevel = settings[0]?.riskLevel || "Balanced";
            const maxTradeSizeDollar = settings[0]?.maxTradeSize || 3000;
            const dailyLossLimit = Math.abs(settings[0]?.dailyLossLimit || 5000);
            const maxPortfolioRiskPct = (riskLevel === "Aggressive") ? 0.03 : (riskLevel === "Conservative" ? 0.01 : 0.02);

            // 3. Circuit breakers - derived from real fills in the trades table, not
            // in-memory counters that reset on restart and drift from the ledger.
            const recentTrades = await db.select().from(schema.trades).orderBy(desc(schema.trades.timestamp)).limit(200).all();
            const todayStr = new Date().toISOString().slice(0, 10);
            const todaysRealizedLoss = recentTrades
                .filter(t => t.timestamp?.slice(0, 10) === todayStr && typeof t.profitLoss === 'number')
                .reduce((sum, t) => sum + (t.profitLoss as number), 0);

            if (todaysRealizedLoss <= -dailyLossLimit) {
                return this.veto(proposal, `Daily loss limit breached: $${Math.abs(todaysRealizedLoss).toFixed(2)} realized loss today vs a $${dailyLossLimit} limit. New entries paused for the session.`);
            }

            let consecutiveLosses = 0;
            for (const t of recentTrades) {
                if (typeof t.profitLoss !== 'number') continue;
                if (t.profitLoss < 0) { consecutiveLosses++; continue; }
                break;
            }
            if (consecutiveLosses >= RiskEngine.CONSECUTIVE_LOSS_LIMIT) {
                return this.veto(proposal, `${consecutiveLosses} consecutive losing trades detected. Circuit breaker paused new entries pending manual review.`);
            }

            // 4. News risk validation - high-impact clusters live on newsClusters, not
            // newsArticles (newsArticles has no impactScore column, so the old query here
            // always compared undefined > 80 and could never veto anything).
            const recentClusters = await db.select().from(schema.newsClusters).orderBy(desc(schema.newsClusters.createdAt)).limit(50).all();
            const cutoff = Date.now() - RiskEngine.NEWS_LOOKBACK_MS;
            const highImpactHit = recentClusters.find((c: any) => {
                if (!c.impactScore || c.impactScore <= RiskEngine.NEWS_IMPACT_THRESHOLD) return false;
                if (new Date(c.createdAt).getTime() < cutoff) return false;
                try {
                    const syms = JSON.parse(c.symbols || '[]');
                    return Array.isArray(syms) && syms.includes(proposal.symbol);
                } catch {
                    return false;
                }
            });

            if (highImpactHit) {
                return this.veto(proposal, `High-impact news cluster detected for ${proposal.symbol} (impact ${(highImpactHit as any).impactScore?.toFixed?.(0) ?? highImpactHit['impactScore']} > ${RiskEngine.NEWS_IMPACT_THRESHOLD}) within the last ${RiskEngine.NEWS_LOOKBACK_MS / 3600000}h. Overriding AI decision.`);
            }

            // 5. ATR-based stop distance, computed from real aggregated trade bars. Falls back
            // to a flat 5% stop only when there isn't yet enough bar history for a 14-period
            // ATR, and that fallback is reported honestly rather than presented as ATR-based.
            const bars = marketDataWorker.getBars(proposal.symbol, 30);
            let atr: number | null = null;
            if (bars && bars.closes.length >= 15) {
                const computed = TechnicalIndicators.calculateATR(bars.highs, bars.lows, bars.closes, 14);
                if (computed > 0) atr = computed;
            }
            const usedFallbackStop = atr === null;
            const riskPerShare = atr !== null ? atr * 1.5 : currentPrice * 0.05;
            const stopLossPrice = proposal.side === 'BUY' ? currentPrice - riskPerShare : currentPrice + riskPerShare;

            // 6. Position Sizing Math - using actual buying power and portfolio value
            const accountEquity = portfolio.equity || 10000;
            const buyingPower = portfolio.buyingPower || 10000;
            const maxRiskAmount = accountEquity * maxPortfolioRiskPct;

            // Maximum shares based on acceptable ATR-defined loss
            let maxSharesByRisk = Math.floor(maxRiskAmount / riskPerShare);

            // Maximum shares based on max trade size constraint
            let maxSharesByCapital = Math.floor(maxTradeSizeDollar / currentPrice);

            // Maximum shares based on buying power
            let maxSharesByBuyingPower = Math.floor(buyingPower / currentPrice);

            // Maximum shares such that this symbol doesn't exceed the concentration cap
            const existingPosition = portfolio.positions.find((p: any) => p.symbol === proposal.symbol);
            const existingPositionValue = existingPosition?.marketValue || 0;
            const remainingConcentrationBudget = Math.max(0, (accountEquity * RiskEngine.MAX_CONCENTRATION_PCT) - existingPositionValue);
            const maxSharesByConcentration = Math.floor(remainingConcentrationBudget / currentPrice);

            if (proposal.side === 'BUY' && existingPositionValue > 0 && maxSharesByConcentration <= 0) {
                return this.veto(proposal, `Concentration limit reached: ${proposal.symbol} position is already at/above ${(RiskEngine.MAX_CONCENTRATION_PCT * 100).toFixed(0)}% of equity ($${existingPositionValue.toFixed(2)} of $${accountEquity.toFixed(2)}).`);
            }

            let maxQuantity = Math.min(maxSharesByRisk, maxSharesByCapital, maxSharesByBuyingPower, proposal.side === 'BUY' ? maxSharesByConcentration : Infinity);

            // 7. Final validation
            if (maxQuantity <= 0) {
                return this.veto(proposal, `Insufficient buying power or risk limits exceeded. Price: ${currentPrice}, Available BP: ${buyingPower}, Stop distance: $${riskPerShare.toFixed(2)}/share.`);
            }

            // If we are selling, make sure we have the shares
            if (proposal.side === 'SELL') {
                if (!existingPosition || existingPosition.quantity <= 0) {
                    return this.veto(proposal, "Cannot sell - no existing position in broker portfolio.");
                }
                maxQuantity = Math.min(maxQuantity, existingPosition.quantity);
            }

            eventBus.emitRiskAssessment({
                newsDetails: proposal.newsDetails,
                traceId: proposal.traceId,
                symbol: proposal.symbol,
                side: proposal.side,
                approved: true,
                maxQuantity,
                currentPrice,
                stopLossPrice,
                atr: atr ?? undefined,
                usedFallbackStop,
                reasoning: `Approved based on ${(maxPortfolioRiskPct * 100).toFixed(1)}% portfolio risk cap, ${(RiskEngine.MAX_CONCENTRATION_PCT * 100).toFixed(0)}% concentration cap, and available BP. Stop distance: $${riskPerShare.toFixed(2)}/share (${usedFallbackStop ? 'flat 5% fallback - insufficient bar history for a 14-period ATR yet' : `1.5x 14-period ATR = $${atr!.toFixed(2)}`}).`
            });

        } catch (e) {
            console.error('[Risk Engine] Error evaluating risk', e);
            this.veto(proposal, `Risk evaluation crashed: ${(e as Error).message}`);
        }
    }
}
export const riskEngine = RiskEngine.getInstance();
