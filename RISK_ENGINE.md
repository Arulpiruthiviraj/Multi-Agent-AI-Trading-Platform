# Argus - RISK ENGINE

Documentation for the risk management and position-sizing engine, verified directly against `src/server/engines/RiskEngine.ts` on 2026-08-08. This file previously described a different, more elaborate implementation (a `RiskEngine.assessRisk()` method with `applyVetoChecks()`, take-profit multipliers, volatility-spike circuit breakers, a `getSymbolExposure()` helper, etc.) that does not exist in this codebase. Everything below is the actual current implementation.

---

## 🎯 Purpose

`RiskEngine` is a hard-coded mathematical gate — no LLM calls, no heuristics — that runs after `ChiefTraderAgent` approves a consensus idea and before any order is placed. It:

- ✅ Computes a real ATR-based stop distance from real market data (with an honestly-flagged fallback when there isn't enough history yet)
- ✅ Enforces a per-trade risk-capital cap based on the configured risk level
- ✅ Enforces a daily-loss circuit breaker and a consecutive-loss circuit breaker, both computed from real trade history
- ✅ Enforces a 30% single-symbol concentration cap against the broker's actual portfolio
- ✅ Vetoes trades on symbols with a recent high-impact news event
- 🔴 Does **not** enforce take-profit or trailing-stop settings — those are handled (with hardcoded, non-configurable thresholds) by a different module, `PortfolioMonitorWorker` — see the note at the bottom of this document.

**Key principle, still accurate**: agents propose, `RiskEngine` disposes. No trade reaches `OrderManagementService` without an `approved:true` `RISK_ASSESSMENT_COMPLETED` event.

---

## 🏗️ Architecture

```
ChiefTraderAgent approves an idea
        ↓
eventBus.emitChiefApproval({traceId, symbol, side, confidence, reasoning, agentsContext, currentPrice?})
        ↓
RiskAgent.assessRisk()
   resolves currentPrice: approval.currentPrice, else marketDataWorker.getLatestPrice(symbol), else undefined
        ↓
RiskEngine.evaluateRisk(proposal)
   0. No live price?                          → veto, no fabricated fallback
   1. Fetch broker.portfolio() (real broker call)
   2. Fetch settings (riskLevel, maxTradeSize, dailyLossLimit)
   3. Daily-loss / consecutive-loss circuit breakers (from real `trades` rows)
   4. High-impact news veto (from real `news_clusters` rows)
   5. ATR stop distance (real, from live bars) or flagged 5% fallback
   6. Position sizing: min(risk-cap shares, max-trade-size shares, buying-power shares, concentration-cap shares)
   7. Final checks (SELL requires an existing position; zero/negative quantity vetoes)
        ↓
eventBus.emitRiskAssessment({approved, maxQuantity, currentPrice, stopLossPrice, atr?, usedFallbackStop, reasoning, ...})
        ↓
   [OrderManagementService — only proceeds if approved && maxQuantity > 0]
```

---

## 📐 ATR Calculation (real, current implementation)

`RiskEngine` calls `TechnicalIndicators.calculateATR(highs, lows, closes, 14)` (`src/server/engines/TechnicalIndicators.ts`), which is a correct Wilder's-smoothing implementation:

```
True Range (TR) = max(High - Low, |High - PrevClose|, |Low - PrevClose|)
First ATR       = SimpleAverage(TR, 14)
Subsequent ATR  = ((PreviousATR × 13) + CurrentTR) / 14
```

**The bars fed into this come from a real 1-minute OHLC aggregator**, `MarketDataWorker.getBars(symbol, 30)` (`src/server/services/MarketDataWorker.ts`), which is built from actual Alpaca trade prints (`msg.T === 't'` messages) — not fabricated. Each incoming trade updates the current minute's high/low/close/volume; on a minute boundary the bar is pushed into a rolling history (max 60 bars kept).

**Fallback behavior**: if fewer than 15 closes exist yet (e.g. right after startup, or for a symbol with no recent trade flow), `RiskEngine` uses a flat `currentPrice * 0.05` stop distance instead, and sets `usedFallbackStop: true` in the emitted assessment. This is explicit and inspectable — it is never silently presented as an ATR-based figure.

```ts
// src/server/engines/RiskEngine.ts (current, abbreviated)
const bars = marketDataWorker.getBars(proposal.symbol, 30);
let atr: number | null = null;
if (bars && bars.closes.length >= 15) {
    const computed = TechnicalIndicators.calculateATR(bars.highs, bars.lows, bars.closes, 14);
    if (computed > 0) atr = computed;
}
const usedFallbackStop = atr === null;
const riskPerShare = atr !== null ? atr * 1.5 : currentPrice * 0.05;
const stopLossPrice = proposal.side === 'BUY' ? currentPrice - riskPerShare : currentPrice + riskPerShare;
```

---

## 💻 Real Implementation Walkthrough

**Location**: `src/server/engines/RiskEngine.ts`

```ts
class RiskEngine {
    private static readonly CONSECUTIVE_LOSS_LIMIT = 3;
    private static readonly MAX_CONCENTRATION_PCT = 0.30;
    private static readonly NEWS_IMPACT_THRESHOLD = 80;
    private static readonly NEWS_LOOKBACK_MS = 4 * 60 * 60 * 1000; // 4 hours

    async evaluateRisk(proposal) {
        // 0. Refuse without a real price - no hardcoded fallback (a prior version defaulted to $150)
        if (!proposal.currentPrice || proposal.currentPrice <= 0) return this.veto(...);

        // 1. Real broker portfolio
        const portfolio = await BrokerManager.getInstance().getActiveBroker().portfolio();

        // 2. Real settings row
        const riskLevel = settings.riskLevel; // Low 1%, Balanced/Medium 2%, Aggressive 3%
        const dailyLossLimit = Math.abs(settings.dailyLossLimit || 5000);

        // 3. Circuit breakers - recomputed from the trades table on every call,
        //    not from an in-memory counter that would reset on restart or drift
        //    from the actual ledger.
        const recentTrades = await db.select().from(schema.trades)
            .orderBy(desc(schema.trades.timestamp)).limit(200).all();
        const todaysRealizedLoss = sum of recentTrades[today].profitLoss;
        if (todaysRealizedLoss <= -dailyLossLimit) return this.veto("Daily loss limit breached...");

        let consecutiveLosses = 0;
        for (const t of recentTrades) {
            if (typeof t.profitLoss !== 'number') continue;
            if (t.profitLoss < 0) { consecutiveLosses++; continue; }
            break;
        }
        if (consecutiveLosses >= 3) return this.veto("3 consecutive losing trades...");

        // 4. News veto - queries newsClusters.impactScore (NOT newsArticles, which has
        //    no impactScore column - a prior version queried the wrong table and could
        //    never actually veto anything).
        const recentClusters = await db.select().from(schema.newsClusters)
            .orderBy(desc(schema.newsClusters.createdAt)).limit(50).all();
        // filter: impactScore > 80, within last 4h, symbol present in cluster.symbols JSON

        // 5. ATR stop distance (see above)

        // 6. Position sizing
        const maxRiskAmount = portfolio.equity * riskPct;
        const maxSharesByRisk = floor(maxRiskAmount / riskPerShare);
        const maxSharesByCapital = floor(settings.maxTradeSize / currentPrice);
        const maxSharesByBuyingPower = floor(portfolio.buyingPower / currentPrice);
        const existingPositionValue = portfolio.positions.find(symbol)?.marketValue || 0;
        const remainingConcentrationBudget = max(0, portfolio.equity * 0.30 - existingPositionValue);
        const maxSharesByConcentration = floor(remainingConcentrationBudget / currentPrice);

        if (side === 'BUY' && existingPositionValue > 0 && maxSharesByConcentration <= 0)
            return this.veto("Concentration limit reached...");

        let maxQuantity = min(maxSharesByRisk, maxSharesByCapital, maxSharesByBuyingPower,
                                side === 'BUY' ? maxSharesByConcentration : Infinity);

        // 7. Final checks
        if (maxQuantity <= 0) return this.veto("Insufficient buying power or risk limits exceeded...");
        if (side === 'SELL') {
            if (!existingPosition) return this.veto("Cannot sell - no existing position...");
            maxQuantity = min(maxQuantity, existingPosition.quantity);
        }

        return this.approve({ maxQuantity, currentPrice, stopLossPrice, atr, usedFallbackStop, reasoning });
    }
}
```

---

## 📊 Risk Levels & Allocation (as actually coded)

| Risk Level | % of Equity per Trade |
|------------|------------------------|
| **Conservative** | 1.0% |
| **Balanced / Medium** (default) | 2.0% |
| **Aggressive** | 3.0% |

`RiskAgent.ts` also carried an independent `maxPortfolioRiskPct` mapping (`Low: 0.01, Medium: 0.015, High: 0.03`) — that specific mapping lived in the code path that was replaced by the implementation above; the mapping documented in this table is what `RiskEngine.evaluateRisk()` actually uses today. If you see both figures in the codebase, `RiskEngine.ts` is the authoritative source — verify against it directly.

There is no `Aggressive: 5.0%` tier and no `Low/Medium/High/Aggressive` 4-tier take-profit/stop-loss ratio system as a prior revision of this doc claimed — those numbers were invented, not implemented.

---

## 🛡️ Circuit Breakers — what's real

| Circuit breaker | Implemented? | Source of truth |
|---|---|---|
| Daily loss limit | ✅ Real | Recomputed each call from `trades.profitLoss` for the current date |
| Consecutive loss limit (3 in a row) | ✅ Real | Recomputed each call from the most recent `trades` rows with non-null `profitLoss` |
| Symbol concentration (30%) | ✅ Real | Real `portfolio.positions[].marketValue` vs. real equity |
| High-impact news veto | ✅ Real | `news_clusters.impactScore > 80` within 4h, matched by symbol |
| Take profit / trailing stop | 🔴 **Not enforced here** | See note below |
| Volatility-spike position reduction | 🔵 **Not implemented** | No code path reduces size based on an ATR spike relative to its own average |

### Important: take-profit / trailing-stop is a different module, and it ignores your settings

`settings.takeProfitPct` and `settings.trailingStopPct` are real, persisted, and shown in `GuardrailsPanel.tsx` — but **`RiskEngine` never reads them**, and neither does anything else that actually closes a position, except `PortfolioMonitorWorker` (`src/server/services/PortfolioMonitor.ts`), which uses **hardcoded** `+5%` / `-3%` thresholds regardless of what's configured:

```ts
// PortfolioMonitor.ts, current code — ignores settings.takeProfitPct/trailingStopPct entirely
if (PnL > 5.0) { /* emit SELL idea, "Target profit reached" */ }
else if (PnL < -3.0) { /* emit SELL idea, "Hard stop hit" */ }
```

If you change the take-profit/trailing-stop sliders in the UI expecting them to change exit behavior, they currently do not.

---

## 🎛️ Configuration

### Real settings fields (from `settings` table, `src/server/db/schema.ts`)

```ts
riskLevel: text('risk_level')            // 'Low' | 'Balanced'/'Medium' | 'Aggressive' (maps as above)
maxTradeSize: real('max_trade_size')      // dollar cap per trade
dailyLossLimit: real('daily_loss_limit')  // dollar circuit breaker
takeProfitPct: real('take_profit_pct')    // persisted, NOT enforced by RiskEngine
trailingStopPct: real('trailing_stop_pct')// persisted, NOT enforced by RiskEngine
```

### Frontend Configuration (`GuardrailsPanel.tsx`)

The UI sliders for these settings are real and do persist to the DB via the settings endpoints. Be aware that the take-profit/trailing-stop sliders specifically have no effect on `RiskEngine` or the actual exit logic, per the note above.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [BROKER_ENGINE.md](./BROKER_ENGINE.md) — execution details, including which brokers actually work
- [DATA_FLOW.md](./DATA_FLOW.md) — full pipeline trace
