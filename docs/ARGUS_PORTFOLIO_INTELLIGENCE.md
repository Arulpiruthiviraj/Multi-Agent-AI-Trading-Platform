# ARGUS portfolio intelligence

Open positions are evaluated by `PortfolioMonitor` (take-profit / trailing stop from **cost basis**, thesis invalidation, optional ExitIntelligence **opinion**). Executable SELL is `emitTradeIdea` as `PortfolioManager` (risk-exit may skip entry quorum) → **still** RiskEngine → OMS.

`ARGUS_PORTFOLIO_INTEL_ENABLED` adds exit-idea cooldown / `PORTFOLIO_DECISION_RECORDED` telemetry. It does not call brokers.

REDUCE / ADD are **not** live OMS actions (full-qty SELL only). Do not fake them.

Same-symbol BUY cooldown after a fill: `sameSymbolCooldownMs`. Do not weaken it to increase turnover.
