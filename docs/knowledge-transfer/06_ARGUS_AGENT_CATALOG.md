# 06 — Agent catalog

Classification: voter = emits `TRADE_IDEA_GENERATED` consumed by ChiefTrader.

| Name | File | Role | Default | Live | Backtest | Flag | Status |
|---|---|---|---|---|---|---|---|
| TechnicalAgent | `services/TechnicalAgent.ts` | RSI/MACD/BB ideas | MARKET_DATA | Yes | No (separate TA in BacktestEngine.run) | — | IMPLEMENTED + VERIFIED unit |
| NewsAgent | `news/NewsEngine.ts` | News ideas | Autobot ~10s | Yes | No | keys | IMPLEMENTED BUT UNVERIFIED accuracy (44.6%/242) |
| FundamentalAgent | `FundamentalAgent.ts` | AV + LLM | Autobot ~60s | Yes | No | ALPHAVANTAGE | CONFIGURATION-DEPENDENT |
| MacroAgent | `MacroAgent.ts` | AV + LLM | Autobot ~75s | Yes | No | ALPHAVANTAGE | CONFIGURATION-DEPENDENT |
| QuantEngine | `QuantSignalAgent.ts` | StrategyEngine | Off | If env | findStrategy | QUANT_ENGINE_ENABLED | FEATURE-FLAGGED UNVALIDATED |
| KronosEngine | `KronosForecastAgent.ts` | Chronos | If /health | Yes | No | local svc | EXTERNAL-DEPENDENCY-DEPENDENT |
| PortfolioManager | `PortfolioMonitor.ts` | SELL ideas | Autobot 60s | Yes | No | — | IMPLEMENTED + VERIFIED tests |
| ChiefTrader | `ChiefTraderAgent.ts` | Consensus | Always | Yes | No | — | IMPLEMENTED + VERIFIED |
| RiskAgent | `RiskAgent.ts` | Forward to RiskEngine | Always | Yes | No | — | IMPLEMENTED + VERIFIED |
| MarketRegimeAgent | `MarketRegimeAgent.ts` | LLM regime emit | Timer | **Not voter** | No | — | DEAD as voter; SIMULATED without Gemini |
| AdvancedQuantEngines | `engines/AdvancedQuantEngines.ts` | Compute | — | **Not voter** | No | — | DEAD as voter |
| ExplainabilityAgent | `ExplainabilityAgent.ts` | Narrative | Side | No | No | — | IMPLEMENTED side path |
| ReflectionEngine | `ReflectionEngine.ts` | Weights + rules | ~60s | Debate prompt only | No | — | IMPLEMENTED; rules not live RiskEngine |
| ManualOverride | `PipelineFlatten.ts` | Flatten ideas | User | Yes still RiskEngine | No | — | IMPLEMENTED |
| Bull/Bear | `parseResearchNote.ts` | Qualitative | Off | Debate notes | No | QUANT_BULL_BEAR_ENABLED | FEATURE-FLAGGED; numerics nulled |
| SentimentAgent / OrderFlowAgent | — | UI names | — | No | No | — | MISSING / MOCKED labels |

**No LangGraph.** Parallel idea generation; ChiefTrader sequential window. Bottleneck: LLM debate + Alpaca REST.

Temperature: decision calls **0.2** via AIRouter. Timeout 20s. Retry: provider failover in router, not infinite hang.
