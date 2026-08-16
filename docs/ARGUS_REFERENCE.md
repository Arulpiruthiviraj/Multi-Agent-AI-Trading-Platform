# Argus reference

Lists only. Narrative: [ARGUS.md](ARGUS.md). Do not enable Quant/LIVE flags to “see if it works.”

## Strategies

**CORE** (`evaluateAll` default): `MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`.

**Experimental** (UNVALIDATED; live env in `config/quantExperimentalStrategies.json`): `SMC_LIQUIDITY_SWEEP`, `VWAP_VOLUME_STRUCTURE`, `OPENING_RANGE_BREAKOUT`, `VWAP_MEAN_REVERSION`, `DONCHIAN_CHANNEL_BREAKOUT`, `MA_CROSSOVER`, `OSCILLATOR_MOMENTUM`, `BOLLINGER_VOLATILITY`, `PREVIOUS_PERIOD_BREAKOUT`, `CANDLESTICK_REVERSAL`, `GAP_CONTINUATION`, `FIBONACCI_PULLBACK`, `VOLUME_CONFIRMATION`, `SR_BOUNCE`, `RELATIVE_STRENGTH_ROTATION`.

Aliases: `config/quantStrategyTaxonomy.json` (760). TechnicalAgent and `BacktestEngine.run()` use **other** rule sets.

## Indicators (quant layer)

SMA/EMA, DMI/ADX (double-smoothed; distinct from unused `calculateADX`), BOS/CHoCH, RSI, MACD, StochRSI, ROC, Williams %R, CCI, divergence as **feature not trade**, ATR%, HV, BB **width%** (not band prices), Keltner, session VWAP, RVOL, OBV, MFI, CMF, A/D, pivots, Fib, OR (unavailable on daily bars), Donchian prior channel, candles/gaps, SMC patterns. Ichimoku: missing.

## Risk gates (order)

`emergency_stop`, `daily_loss`, `consecutive_loss`, `portfolio_drawdown`, `order_rate_limit`, `market_hours`, `data_freshness`, `news_veto`, `price_validity`, `order_notional_cap`, `symbol_concentration`, `open_positions_cap`, `sector_concentration`, `correlation_exposure`, `sufficient_size`, `sell_position_exists`, `argus_capital_allocation`, `daily_buy_notional`.

Numbers: `config/tradingSafety.json`. Restricted-live caps in that file.

## Agents / weights

`config/agentWeights.json`: Technical 0.25, News 0.25, Fundamental 0.20, Kronos 0.20, Macro 0.15, Quant 0.15. Debate weight 0.35 (does not count toward min-2). Unlisted 1.0. Risk-exit agent `PortfolioManager`.

## AI

Router: Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible/Ollama. Local Chronos `127.0.0.1:8008`. OpenAlice: `OPENALICE_ENABLED` + MCP URL; refuse trading MCP. No provider: Anthropic, Mistral, OpenRouter, Kimi, Grok, Groq keys.

## Events (`config/eventNames.json`)

MARKET_DATA, CALCULATION_COMPLETED, TRADE_IDEA_GENERATED, CHIEF_APPROVED_IDEA, RISK_ASSESSMENT_COMPLETED, ORDER_EXECUTED, LEARNED_NEW_RULE, OPENALICE_*, CHIEF_CONSENSUS_*, RISK_ASSESSMENT_STARTED, ORDER_SUBMITTED/ACCEPTED/FILLED, CAPITAL_CHECK, AGENT_DISAGREEMENT, POSITION_*, MODEL_*, DIAGNOSTIC_CREATED, DATA_STALE, MODEL_UNAVAILABLE, MODEL_FALLBACK, CAPITAL_BLOCK, RISK_BLOCK, PORTFOLIO_UPDATE (not persisted).

Also emitted (not all catalogued): `MARKET_DATA_UPDATED`, `MARKET_REGIME_DETECTED`, Kronos types.

## Database (44 tables)

users, sessions, settings, kill_switch_events, broker_connections, ai_providers, ai_models, ai_usage, trades, fills, daily_trading_summary, reconciliation_events, portfolio_snapshots, portfolio, learned_rules, agent_predictions, agent_performance_stats, agent_confidence_calibration, explainability_reports, agent_memory, event_traces, memory_rules, news_articles, news_clusters, news_providers, kronos_predictions, agent_routing_overrides, ohlcv_bars, backtest_runs, prediction_engine_weights, escalation_decisions, transactions, consensus_decisions, consensus_evidence, ai_calls, risk_assessments, risk_gate_results, prediction_outcomes, training_examples, openalice_verifications, external_data_cache, quant_assessments, quant_strategy_backtests, quant_backtest_decision_log.

## Env (important)

Alpaca keys (ticks/history). `PAPER_TRADING_ONLY` = quote WS only. IBKR path/URL. Questrade env **unread for orders**. AUTH_* / ENCRYPTION_SECRET. `QUANT_*` flags default false. `OPENALICE_*`. `ARGUS_SKIP_*`. `PORT` unused. Full list: `.env.example`.

JSON config (fail boot if required keys missing): `tradingSafety`, `eventNames`, `agentWeights`, `markets`, `smcConfluence`, `thesisInvalidation`, `noTradeReasons`, `bullBearResearch`, `quantExperimentalStrategies`, `quantStrategyTaxonomy`.

## Frontend tabs (21)

dashboard, command, observatory, arena, scanner, opportunities, portfolio, agents, news, intelligence, learning, memory, activity, diagnostics, audit, documentation, evaluation, validation, deployment, kronos, settings. Mixed REAL/MOCK — `FINAL_ANALYSIS.md`.

## File map

| Feature | Path |
|---|---|
| Boot | `server.ts`, `SystemBootstrap.ts`, `scripts/devWithOpenAlice.ts` |
| Ticks | `MarketDataWorker.ts` |
| Ideas | `TechnicalAgent.ts`, `NewsEngine.ts`, `FundamentalAgent.ts`, `MacroAgent.ts`, `QuantSignalAgent.ts`, `KronosForecastAgent.ts`, `PortfolioMonitor.ts` |
| Consensus | `ChiefTraderAgent.ts`, `EvidenceAggregator.ts` |
| Risk | `RiskEngine.ts`, `PositionSizing.ts`, `CapitalAllocation.ts`, `DailyBuyNotional.ts`, `RestrictedLiveMode.ts` |
| Orders | `OrderManagement.ts`, `src/brokers/*` |
| Quant | `src/server/quant/**` |
| AI | `AIRouter.ts`, `AIOutputValidator.ts`, `parseResearchNote.ts` |
| Recon | `PortfolioReconciliation.ts` |
| Backtest | `BacktestEngine.ts`, `HistoricalDataGateway.ts`, `WalkForwardValidator.ts` |
| UI | `src/App.tsx` |
| Schema | `src/server/db/schema.ts` |

## Tests

~128 Vitest files (safety path). 1 Playwright spec (`e2e/moduleToggleParity.spec.ts`) — seed wizard **and** tour. Almost no `App.tsx` unit tests.

## Doc vs code (do not flatten)

| Claim | Reality |
|---|---|
| 45 tables | **44** |
| FINAL_ANALYSIS recon-pause unused | **Fixed** — `TRADING_PAUSED` hits `emergency_stop` |
| No timeouts | Alpaca + AIRouter timeouts exist |
| Coinbase unimplemented | Real adapter; paper refuses |
| `docs/architecture/` layout | Historical files now `docs/archive/historical/` |
| AGENTS.md ATR sizing | **Not** live RiskEngine |
| Readiness 53% vs 69% | Dated passes — do not average |

## Issues (short)

P0: no OOS edge; LIVE NO-GO; `/signals` fake path.  
P1: Autobot-off ticks; Alpaca paper URL authenticate quirk; IBKR no listing gate; SQLite one writer; mocked UI; AI replay unavailable.  
P2: direction-blind news veto; hardcoded TechnicalAgent; long-only BT vs live shorts.

## Archive

Dated reports (do not treat as current wiring): `docs/archive/historical/`. Disconnected Python: `archive/python-platform/`.
