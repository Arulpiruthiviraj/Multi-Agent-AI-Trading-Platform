# ARGUS_ELITE_TRADER_ARCHITECTURE.md

Goal: **behave** like a selective trader (patience, NO_TRADE, regime, adversarial review, measured edge) — not look like one.

## Target flow (additive; RiskEngine still last hard gate before OMS)

```
Market data → deterministic Quant / MarketContext / Regime
  → existing agents in parallel (already timer/event driven)
  → TradeThesis (numbers from engines)
  → optional Bull/Bear structured notes (flag off)
  → existing ChiefTrader debate (HOLD can veto)
  → EV gate (Quant already refuses non-positive / no sample)
  → RiskEngine → sizing → OMS → broker
  → PortfolioMonitor + thesis invalidation
  → journal / prediction-vs-reality (replay already honest about missing PIT AI)
```

## Independence of evidence

Do not add votes. GroupedScores already blends correlated oscillators. AI models sharing the same tape are **one** research dimension, not N.

## Capital constitution (already live)

`CapitalAllocation` + RiskEngine `argus_capital_allocation`: Argus allocation (`settings.budget`) is not broker cash. Do not duplicate a second kill switch.

## Readiness

This architecture does **not** raise `ARGUS_REAL_MONEY_READINESS.md`. OOS still failed. Paper book in this env still empty. LIVE **NO-GO**.
