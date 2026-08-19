# Argus portfolio and exit forensics

How Argus currently decides to **sell**. Terminology matches code, not marketing copy.

**CODE-VERIFIED** — `src/server/services/PortfolioMonitor.ts`, `PipelineFlatten.ts`, `PortfolioRebalance.ts`, `config/runtimeIntervals.json` (`portfolioMonitorMs` 60000), `settings.take_profit_pct` default 15, `trailing_stop_pct` default 5.

`portfolio` is **recon-hydrated current state**, not OMS-inserted at fill. Exits need a live IEX price (`getLatestPrice`); else no idea (`NO_PRICE`).

Copy may say “Scaling out.” The emit is a **full-position SELL idea** (whole position through RiskEngine/OMS), not a partial scale. **CODE-VERIFIED**.

---

## PnL used for generic exits

```
PnL% = (currentLivePrice - averagePrice) / averagePrice * 100
```

Compared to **average cost**, not a session high.  

`settings.trailingStopPct` named trailing is a **fixed cost-basis stop** (e.g. −5% from average). It is **not** a peak-trailing stop. Do not call it a trailing stop in the high-water-mark sense.

---

## 1. Profit-taking (TARGET_REACHED)

| Field | Value |
|---|---|
| Trigger | `PnL > takeProfitPct` (default 15) when **no** quant stop/target/thesis on the opening lot |
| Consensus | Risk-exit: **skips** min-2 / debate |
| RiskEngine | Full 24 gates (SELL) |
| OMS | Normal |
| Evidence | `EXIT_CODE=TARGET_REACHED` in reasoning; `agent: PortfolioManager` |

---

## 2. Stop-loss / “trailing” backstop (HARD_STOP)

| Field | Value |
|---|---|
| Trigger | `PnL < -trailingStopPct` (default 5) vs **average cost** |
| Name in code | `EXIT_CODE=HARD_STOP` on the generic path |
| Not | Peak trail |

---

## 3. Trailing behavior

**There is no peak-based trailing implementation in PortfolioMonitor.**  

On **quant lots**, a second branch may emit `EXIT_CODE=TRAILING_STOP` when cost-basis PnL < −trailingStopPct **in addition to** strategy stop/target — still cost-basis, despite the code string. **CODE-VERIFIED** `PortfolioMonitor.ts`.

---

## 4. Quant exits (HARD_STOP / target on stored prices)

Opening BUY may store `quant_stop_price`, `quant_target_price`, `quant_strategy_id`, `quant_invalidation_json` from ChiefTrader `supportingQuantDetail`.

- Live price ≤ `quantStopPrice` → `EXIT_CODE=HARD_STOP` (strategy stop)  
- Live price ≥ `quantTargetPrice` → target path (see source branch)  
- Confidence `quantStopExitConfidence` 0.95 / `quantExitIdeaConfidence` 0.85  

If those columns are null, generic take-profit / cost-basis stop apply.

---

## 5. Thesis exits (THESIS_INVALIDATION)

`evaluateThesisInvalidation` vs stored JSON + live daily bars. If bars too thin, **returns null** (no fabricated invalidation). Confidence `thesisInvalidationExitConfidence` 0.9.

---

## 6. PortfolioManager exits

Same as §1–5. Agent string is `agentWeights.riskExitAgent` = `PortfolioManager`. ChiefTrader `isRiskExit` short-circuits approval.

Overlay cooldown `canEmitPortfolioExitIdea` may suppress a **new** idea; previous SELL still must clear Risk/OMS. Event `PORTFOLIO_DECISION_RECORDED`.

---

## 7. Technical SELL signals

TechnicalAgent (and others) can emit SELL ideas on `TRADE_IDEA_GENERATED`. Those **are not** risk-exits: they need normal consensus (min 2, threshold 0.75) unless they somehow carry the PortfolioManager agent (they do not).

---

## 8. Manual exits

- Operator flatten/liquidate: `PipelineFlatten` → `CHIEF_APPROVED_IDEA` `ManualOverride` → **RiskEngine still runs** (no `broker.closePosition`).  
- Execute override: `POST /api/v2/trading/execute-override` — **full RiskEngine**, never OMS-direct. **CODE-VERIFIED** CLAUDE.md.  
- Rebalance: `PortfolioRebalance` directional idea through the same pipeline when drift > `rebalanceMinDriftPctOfEquity` (1%).

---

## 9. Risk exits (gates vs ideas)

RiskEngine **does not flatten** on a failed BUY. Kill switch / `TRADING_PAUSED` blocks **new** orders including SELL if state is not `TRADING_ENABLED`. Autobot-off does **not** block SELL.

Daily-loss / drawdown gates reject **proposals**; they are not themselves PortfolioMonitor ticks.

---

## Resulting P&L records

| Record | When |
|---|---|
| `trades` SELL FILLED + `profit_loss` | OMS after close |
| `portfolio` row gone or qty 0 | After recon hydrate |
| `daily_trading_summary.realized_pnl` | If summary writer ran (**PARTIAL**) |
| `transactions.outcome` WIN/LOSS | Lifecycle tracker (**PARTIAL** if stale processes skipped updates historically) |

Organic closed paper FILLED SELL P&L was **0** as of the 2026-08-18 CLAUDE.md snapshot — documentation does not create fills.
