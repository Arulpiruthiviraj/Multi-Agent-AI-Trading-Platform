# LIVE_BACKTEST_PARITY_SPEC.md

**Phase 2 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md).** A formal, field-by-field comparison of what the
live trading pipeline actually does against what `BacktestEngine.ts`'s two real entry points
(`run()`, `runStrategyBacktest()`) actually simulate — re-verified against current source this
phase, not copied from any prior document's own claim about itself. Where a real, closable gap was
found, it's closed in this phase (see "Fixed this phase" below) in a way that changes **backtest**
behavior only — nothing in this phase touches live trading behavior, per the project's own
non-negotiable rule.

## 1. Indicators

| | Live | Backtest |
|---|---|---|
| RSI/MACD | `RSIEngine.ts`/`MACDEngine.ts`, real, used by both `TechnicalAgent.ts` (live) and `BacktestEngine.run()` (backtest) | Same modules, same instances (`rsiEngine`/`macdEngine` imported directly) |
| SMA/Bollinger | `BacktestEngine.run()` computes these **inline**, not via a shared module | `TechnicalAgent.ts` computes its own, separately, inline too | **Known duplication, not fixed this phase** (see "Not fixed" below) |
| Quant strategies' features | `quant/indicators/*.ts`, real, shared | `runStrategyBacktest()` calls the exact same `computeMomentumFeatures`/`computeVolumeFeatures`/`computeSupportResistanceFeatures`/`classifyRegime`/`getMarketContext` functions `QuantSignalAgent.ts` (live) calls | **Full parity** - not a duplicate implementation, the identical functions |

## 2. Data & timestamps

| | Live | Backtest |
|---|---|---|
| Bar source | Real-time Alpaca WS ticks (`MarketDataWorker.ts`) for TechnicalAgent; real daily bars (`HistoricalDataGateway`) for QuantSignalAgent | Real daily bars, same `HistoricalDataGateway`/`ohlcv_bars` cache |
| Look-ahead protection | N/A (live data arrives in real time) | Real - `ReplayClock` structurally exposes only a chronological prefix of bars per symbol; `clock.assertNotFuture()` is defense-in-depth on top of that structural guarantee. `ReplayClock.test.ts` covers this directly. |
| Corporate actions (splits) | N/A (live prices are always current, never split-corrupted) | Real, active refusal - `checkForUnadjustedCorporateActions()` halts the run (`CORPORATE_ACTION_DETECTED`) rather than silently corrupting P&L on a detected split |
| Dividends | N/A | **Not adjusted for** - bars are `adjustment=raw`; a dividend-heavy symbol over a long window will show a small real total-return understatement vs. a dividend-adjusted benchmark. **Not fixed this phase** (see below). |

## 3. Entry rules

| | Live | Backtest |
|---|---|---|
| Deterministic technical strategy | `TechnicalAgent.ts` (own inline rules) | `BacktestEngine.run()` (separately-written inline rules, same logic, not the same code) | **Duplicated, not shared - real risk, not fixed this phase** |
| Quant strategies | `quant/strategies/*.ts` `evaluate()`, called live by `QuantSignalAgent.ts` | `runStrategyBacktest()` calls the **identical** `evaluate()` functions | **Full parity** |
| Consensus (ChiefTrader, AI debate) | Real, weighted vote + optional AI debate, 0.75 threshold | **Not simulated at all** - the backtester only ever replays a single agent's deterministic signal, never the multi-agent consensus/AI-debate layer | **Structural, documented, not fixed this phase** - would require point-in-time-safe historical news/fundamentals/AI replay, explicitly out of scope until Phase 9's staged validation work exists |

## 4. Exit rules

| | Live | Backtest |
|---|---|---|
| Deterministic strategy exit | `BacktestEngine.run()`'s own inline -5%/+15%... now reads `settings.trailingStopPct`/`takeProfitPct` (fixed in the E1-E7 quant/backtest hardening pass, prior session) | `PortfolioMonitor.ts`, now reads the same settings fields | **Fixed (prior session) - both consumers derive from the same settings row** |
| Quant strategy exit | Each strategy's own explicit `stop`/`target` from `evaluate()`, including `TREND_FOLLOWING`'s real simulated trailing stop | **FIXED (Phase 16B)** - a live position opened from a QuantEngine signal is now exited by that same strategy's own stop/target when one was proposed | **Full parity as of Phase 16B** - see below |

**Fixed in Phase 16B (`ARGUS_PHASE16_READINESS_REPORT.md`).** User-confirmed direction: live exits
became strategy-aware rather than making the backtest less informative. `ChiefTraderAgent`'s
`supportingQuantDetail.proposedStop`/`proposedTarget` (already computed, previously discarded
after the approval event) is now threaded through `RiskAgent` → `RiskEngine` →
`OrderManagement.executeOrder()`, which persists it onto the opening `trades` row
(`quantStrategyId`/`quantStopPrice`/`quantTargetPrice` - new columns, migration `0024`).
`PortfolioMonitor.ts` now looks up the most recent FILLED BUY trade for each held symbol and, when
it carries a real stop/target, exits at that absolute price level instead of the generic
`settings.takeProfitPct`/`trailingStopPct` percentage thresholds. Any non-QuantEngine-sourced
position (technical/news/fundamental-originated, or a QuantEngine trade whose strategy proposed no
stop/target) is completely unaffected - falls through to the unchanged generic exit. Tests:
`PortfolioMonitor.test.ts`'s new "quant strategy-aware exits" block (4 tests: stop, target,
holds between the two, and the unaffected-fallback case).

**Phase 16 follow-up:** live `PortfolioMonitor` also re-evaluates the structured thesis snapshot
(`quant_invalidation_json`) against real bars (regime / RVOL / ADX / CHoCH / false breakout).
`runStrategyBacktest()` already exits when strategy `evaluate()` no longer supports the position
via stop/target; it does not separately re-run this live helper. Remaining structural gap:
backtest still does not simulate ChiefTrader consensus or RiskEngine gates.

## 5. Position sizing

| | Live | Backtest |
|---|---|---|
| Sizing math | `PositionSizing.calculatePositionSizing()` | The exact same function, same import, byte-identical logic (including this session's new `FIXED_DOLLAR`/`PERCENT_OF_EQUITY` modes) | **Full parity - already fixed in a prior session (§27.1), re-verified current this phase** |

## 6. Costs

| | Live | Backtest |
|---|---|---|
| Commissions | `Commissions.ts`, real SEC/FINRA fee model | Same module, same function | **Full parity** |
| Slippage | `Slippage.ts`, real dynamic volatility/participation-scaled | Same module, same function | **Full parity** |
| Partial fills | Real - `OrderManagement.ts` aggregates multiple broker-reported fills into distinct `fills` rows | **Not modeled** - the backtest fills a computed quantity in full at one simulated price per signal | **Real, one-directional gap - live can partially fill, backtest never does. Not fixed this phase** (documented, low practical impact for daily-bar backtests at the position sizes this system uses) |

## 7. Risk gates

| Gate | Live (`RiskEngine.ts`) | Backtest (before this phase) | Backtest (after this phase) |
|---|---|---|---|
| `emergency_stop` / kill switch | Real, blocks all new orders | Not simulated | Not simulated (a backtest has no live kill-switch concept to violate) |
| `daily_loss` | Real, 80% of `settings.dailyLossLimit`, real exchange-trading-day boundary | Not simulated | Not simulated this phase (see "Not fixed" below - a real trading-day-scoped equivalent is a larger addition) |
| `consecutive_loss` | Real, 3 consecutive real losing FILLED trades blocks new entries | Not simulated | Not simulated this phase (same reasoning) |
| `portfolio_drawdown` | Real, `settings.maxPortfolioDrawdownPct` (default 15%) from a real persisted high-water-mark, blocks new entries once breached | **Not simulated** | **NOW SIMULATED** - `runStrategyBacktest()` tracks its own equity-curve high-water-mark and, once drawdown from peak exceeds `settings.maxPortfolioDrawdownPct`, stops opening new positions for the remainder of the run (existing open positions are still managed/exited normally) - the exact same real threshold and the exact same "block new entries, don't force-close" behavior the live gate has. See "Fixed this phase" below. |
| `order_rate_limit` | Real, `settings.maxOrdersPerMinute` | Not simulated | Not simulated this phase (daily-bar backtests cannot generate a realistic sub-minute order rate to violate this against - low practical value) |
| `market_hours` | Real, Alpaca `/v2/clock` | N/A (daily bars have no intraday market-hours concept) | N/A, unchanged |
| `data_freshness` | Real, 5-minute staleness | N/A (backtest data is never "stale" - it's the whole point of point-in-time replay) | N/A, unchanged |
| `news_veto` | Real, `news_clusters.impactScore>80` | Not simulated (backtester never replays historical news) | Not simulated this phase - real point-in-time news replay is Phase 9 scope, not Phase 2 |
| Concentration/correlation/sizing caps | Real, `PositionSizing.ts` | Real, same shared function | Unchanged, already at full parity |

## 8. Fixed this phase

**`runStrategyBacktest()` now simulates the real portfolio-drawdown circuit breaker.** Backtest-only
change (`BacktestEngine.ts`) - reads the same `settings.maxPortfolioDrawdownPct` RiskEngine reads
live, tracks the backtest's own real equity-curve peak, and once drawdown from that peak exceeds the
threshold, stops the strategy from opening any NEW position for the rest of the run (an existing
open position is still tracked/exited normally, exactly matching live `emergency_stop`'s "block new
orders, don't force-liquidate" semantics). The result object now reports
`drawdownCircuitBreakerTriggeredAt` (bar timestamp, or `null` if never triggered) so this is visible
and auditable, not silent. **Zero live-behavior change** - `RiskEngine.ts` itself is untouched.

## 9. Not fixed this phase (explicit, prioritized per `ARGUS_PRE_IMPLEMENTATION_BASELINE.md`'s P0-P3 framework)

- ~~**P1** - Quant-strategy live exit mismatch (Section 4 above)~~ **Fixed in Phase 16B** - see
  Section 4 above.
- **P2** - `BacktestEngine.run()`'s inline SMA/RSI/MACD/Bollinger duplicated from `TechnicalAgent.ts`
  rather than shared - a real correctness risk (the two could silently drift) but not a currently
  *known* divergence; refactoring to share code is deferred per the project's own "refactor only
  where duplication creates a real correctness risk, not merely for cleanliness" rule until a real
  divergence is found or a lower-risk shared-extraction path is designed.
- **P2** - Dividend adjustment (Section 2).
- **P2** - Partial-fill simulation in the backtest (Section 6).
- **P3** - `daily_loss`/`consecutive_loss`/`order_rate_limit` gate simulation in the backtest
  (Section 7) - real but lower practical value for daily-bar backtests; revisit if/when intraday
  backtesting is ever built.
- **Structural, not a "gap" to close** - consensus/AI-debate replay (Section 3) is Phase 9 scope by
  design, not something this phase's backtest-parity work can safely shortcut.

## 10. Automated parity tests added this phase

`BacktestEngine.drawdownCircuitBreaker.test.ts` (new) - a real integration test proving the new
drawdown simulation actually stops new entries once the threshold is breached, and that an existing
open position continues to be tracked/exited normally after the breaker trips (never force-closed).
