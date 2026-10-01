# ARGUS — Active Intraday PAPER Strategy Design & Implementation Program

**Target: Evaluate Whether $2,000 Can Sustain Approximately $20/Trading-Day Average Net P&L**

**Original design date:** 2026-09-29
**Status:** Proposed implementation program — NOT YET STARTED. Saved for later execution per explicit instruction ("add this plan," not "implement now").
**Mode:** PAPER ONLY
**Implementation philosophy:** additive, evidence-driven, feature-flagged, fail-closed, no protected-spine bypasses

**Supersedes:** an earlier, less-refined draft of this same idea framed as "$10/day" (see
`project_argus_ibkr_data_gap.md` memory, "IBKR Paper Readiness + $2,000/$10-day Feasibility" —
that earlier draft was held pending go-ahead and never started; this $20/day version replaces it
with several important corrections, listed below).

**Corrections made vs. the original draft, before handing this to an implementer:**
- Treat $20/day on $2,000 as a **feasibility benchmark**, not an operational quota.
- Do **not** fall back from marketable-limit to `MARKET` when a required fresh bid/ask is missing —
  that defeats the purpose of spread-controlled execution. Fail closed / defer instead.
- The $400-position-at-1%-is-$4 math must be **measured from real evidence**, never assumed.
- Argus now has **IBKR real-time consolidated U.S. Level 1 subscriptions active** (per this session's
  2026-09-30 update) — validate and use that feed rather than treating Alpaca/IEX as a permanent
  ceiling.
- Don't hardcode a new "Gate 26" — add a new ordered gate through the existing gate-registry
  architecture and let the real count fall out of that.

---

## OBJECTIVE

Evolve Argus so it can rigorously evaluate and, if evidence supports it, execute a selective active
intraday strategy using approximately:

```text
allocated capital = USD $2,000
research benchmark = ~$20 average net P&L / trading session
```

Approximately **1% of allocated capital per session**. Treat strictly as a research/feasibility
benchmark — NOT a guaranteed daily target, a minimum quota, or a reason to force trades, increase
risk after losses, or lower confidence thresholds. Argus must be allowed to produce **ZERO TRADES**
on sessions where no sufficiently strong opportunity exists.

---

## 0. FIRST PRINCIPLE — DO NOT BUILD A "$20/DAY BOT"

Do not implement: keep-trading-until-+$20, size-up-if-behind-target, chase-late-session-opportunities,
loosen-RiskEngine-after-losses, reduce-consensus-for-frequency, martingale sizing, revenge/recovery
trading. Optimize instead for positive expected value after spread, slippage, commissions, missed
fills, and adverse selection. $20/day is the benchmark PAPER evidence is evaluated against, not a
behavior to engineer toward.

## 1. HONEST MATHEMATICAL FRAMING

$20/$2,000 = 1%/session. Sustained over ~252 sessions without compounding ≈ $5,040/year against
$2,000 — a highly demanding target; never describe it as easy or expected. A $400 position earning
1% is only ≈$4, so $20/day requires several profitable positions, greater average move, more capital
deployed, or higher expectancy — determined empirically, never from a predetermined trade count.

## 2. PROTECTED ARCHITECTURE

Authoritative, unchanged: ChiefTrader deterministic consensus, RiskEngine, PositionSizing, OMS,
BrokerManager, reconciliation, kill switch, trading-state machine, portfolio accounting. No new
execution path. Spine: Opportunity Discovery → Strategies/Quant Evidence → ChiefTrader → RiskEngine
→ PositionSizing → OMS → BrokerManager → PAPER broker. `PAPER_TRADING_ONLY=true` / `LIVE_NO_GO`
throughout.

## 3. VERIFY CURRENT CODE BEFORE IMPLEMENTING

Ground every change against actual HEAD — inspect `OrderManagement.ts`, `PositionSizing.ts`,
`RiskEngine.ts`, `MarketDataWorker.ts`, `ExtendedHoursExecutionPolicy.ts`, `BrokerManager`,
`executionQuality.ts`, `PortfolioMonitor`, `tradingSafety.json`, `researchSafety.json`,
`OpportunityDiscovery`, `QuantCoreBridge`, current IBKR market-data implementation. Verify rather
than assume RTH order construction, existing LIMIT support, spread APIs, bid/ask storage, current
risk-gate count/order, current exit mechanisms, PAPER soak floors, current market-data provider
selection. If the design conflicts with current code because the system evolved, adapt to current
architecture rather than forcing stale assumptions.

## PHASE 1 — MEASURE CURRENT EDGE FIRST

No strategy tuning yet. **1.1** Create a $2,000 PAPER experiment profile via config (not hardcoded
account-size logic) — `experimentBudget = 2000`, PAPER only, initial sizing range ≈$300–500/trade as
an experiment input (not an assertion of optimality); existing concentration/open-position/capital
gates remain authoritative. **1.2** Build a read-only `dailyPnlDistribution` report backed by real
orders/fills/trades/transaction-cost/execution-quality records: session count, mean/median daily
gross & net P&L, p10/p25/p75/p90, best/worst day, profitable/losing/zero-trade session %, sessions
≥+$20 and ≤-$20, avg trades/session, gross/cost/net expectancy per trade, avg spread cost/slippage/
commissions, max drawdown, longest losing streak — never infer missing costs as zero. **1.3** Gate
further work on evidence from real `config/researchSafety.json` values (positive net expectancy,
sufficient sample size, acceptable profit factor/drawdown, cost-aware result). If baseline evidence
is materially negative: STOP strategy-performance claims (execution-cost research may continue
independently, but never claim it creates alpha).

## PHASE 2 — EXECUTION MECHANICS

**2.1** Optional RTH marketable-limit execution behind `ARGUS_RTH_LIMIT_EXECUTION_ENABLED=false`
(default off; disabled preserves current behavior exactly). When enabled, derive BUY limit from
fresh ask+bounded offset, SELL from fresh bid−bounded offset; config (not TS literals):
`rthLimitOffsetBps`, `rthLimitMaxSpreadBps`, `rthLimitRepriceAfterMs`, `rthLimitMaxReprices`.
**CRITICAL FAIL-CLOSED CORRECTION:** if RTH limit mode is enabled and fresh bid/ask/valid-spread is
unavailable, do NOT silently fall back to uncontrolled MARKET — reject/defer per existing OMS
semantics; MARKET behavior is preserved only when the feature itself is disabled. **2.2** Add a new
ordered RiskEngine gate (`rth_spread_execution_policy`, named semantically — never hardcode a "Gate
26" number) through the existing gate-registration architecture, active only when the flag is on:
validates bid/ask presence, spread validity, quote freshness, spread ≤ configured max; fails closed;
never fabricates spread from last-trade/midpoint/historical-average. **2.3** Runtime-prove IBKR
consolidated L1 (AAPL/MSFT/NVDA/SPY/QQQ live BID/ASK/LAST/sizes, no entitlement/delayed errors)
before relying on it; compare vs. Alpaca/IEX for spread availability, quote completeness/age,
pre-market coverage, missing bid/ask, liquidity classification. Market-data provider and execution
broker stay separately configurable. **2.4** Bounded reprice/cancel policy reusing existing OMS
follow-up/stale-order reconciliation/cancellation/idempotency — submit→wait→reevaluate→optional
reprice→max retries→cancel; no infinite chasing, no duplicate logical order.

## PHASE 3 — INTRADAY EXIT ARCHITECTURE

**3.1** `IntradayBracketMonitor` behind `ARGUS_RTH_BRACKET_EXITS_ENABLED=false`, driven by live market
data: take-profit/stop-loss/trailing-stop/max-hold/EOD-flatten per position, values from the
validated strategy/trade plan — **never** globally hardcoded (e.g. "+1%/-0.5%") merely because the
target is $20/day; exit geometry belongs to strategy research. **3.2** A bracket trigger must NOT call
the broker directly — reuse the existing authorized risk-exit pathway (canonical risk-exit intent →
RiskEngine → OMS → BrokerManager), never invent a second bypass. **3.3** Record on every position:
`strategyId`, `predictionHorizon`, `entryTimestamp`, `intendedHoldingWindow`, `takeProfitPolicy`,
`stopPolicy`, `maxHold` — never use a 5-minute predictor to justify a multi-day hold.

## PHASE 4 — SMALL-CAPITAL PORTFOLIO PROFILE

**4.1** `SMALL_CAPITAL_INTRADAY_PAPER` config profile (not special-case code): candidate research
range 3–5 concurrent positions, ~$300–500 each, cash reserve for fills/variation — starting
experiment parameters validated through OOS/replay/PAPER, never assumed optimal. **4.2** Explicit
whole-share constraints (`quantity = floor(notional/price)`, minimum notional/quantity) — expensive
securities at $300–500 may correctly yield `quantity = 0`; never fabricate fractional capability.
**4.3** Evaluate portfolio-level expected value (capital deployed, cash reserve, simultaneous/
correlated/sector exposure, expected return/cost/downside), not only individual trades.

## PHASE 5 — IMPROVE INTRADAY ALPHA QUALITY (only after execution/measurement infra is trustworthy)

**5.1** New quant features go in `quant-core-java/` per existing Java authority boundaries — candidate
research families: short-horizon momentum, opening-range behavior, intraday mean reversion, VWAP
deviation, realized volatility, relative volume/strength, gap continuation/fade, regime-conditioned
momentum. Research hypotheses only, each must pass the standard validation ladder. **5.2** Java output
is `QuantEvidence` (or canonical equivalent) only — never `Java → broker` directly; always
Java→evidence→ChiefTrader→RiskEngine→OMS. **5.3** Improve discovery throughput (measure
discovered→admitted→challenger-scored→subscribed→evaluated→directional→consensus→risk→order→fill)
through evidence, never by lowering consensus — this session's own forensics already found
discovery-to-evaluation capacity as a real bottleneck class.

## PHASE 6 — VALIDATION

**6.1** Standard trade/session/expectancy/cost/drawdown/turnover metrics. **6.2** Explicit $20/day
feasibility metrics (mean/median net P&L per day, % sessions ≥+$20, % between $0-$20, % losing,
expected net P&L/trade, expected trades/session, capital utilization, cost as % of gross alpha) —
never conclude feasibility from one day/week/lucky trade. **6.3** Work backward mathematically
(expected daily P&L = expected trades/day × expected net P&L/trade; e.g. 2×$10, 4×$5, 8×$2.50 all
= $20) then check whether Argus's real evidence comes anywhere close after costs — never assume a
scenario is attainable merely because the arithmetic works. **6.4** Use existing OOS/walk-forward/PBO
plus Deflated Sharpe/parameter sensitivity/cost stress/regime stratification where available — strong
in-sample with failed OOS stays `NOT READY`.

## PHASE 7 — PAPER SOAK

Real market data, real strategy evaluation, real consensus, real RiskEngine, real OMS, real broker
PAPER fills, real transaction-cost measurement — no synthetic fills count toward promotion evidence.
Success is NOT "made $20 yesterday" — evaluate distributions (positive mean/median expectancy, stable
profit factor, cost survival, regime survival, drawdown relative to $2,000, outlier-day dominance,
calibration stability).

## PHASE 8 — READINESS CLASSIFICATION

`$20_DAY_TARGET_NOT_SUPPORTED` / `$20_DAY_TARGET_INSUFFICIENT_EVIDENCE` /
`$20_DAY_TARGET_PAPER_SUPPORTED` — the last never means "guaranteed future $20/day," only that
sufficiently large PAPER/OOS evidence presently supports approximately that average net expectancy
under the tested conditions.

## FEATURE FLAGS (default false; reuse existing equivalents, never add redundant ones)

`ARGUS_RTH_LIMIT_EXECUTION_ENABLED`, `ARGUS_RTH_BRACKET_EXITS_ENABLED`,
`ARGUS_INTRADAY_QUANT_VOTE_ENABLED`

## CONFIGURATION (versioned config, never hardcoded TS literals)

`rthLimitOffsetBps`, `rthLimitMaxSpreadBps`, `rthLimitRepriceAfterMs`, `rthLimitMaxReprices`,
`rthTakeProfitPolicy`, `rthStopPolicy`, `rthMaxHoldMinutes`

## TEST REQUIREMENTS

Feature-disabled preserves existing behavior; BUY/SELL marketable-limit pricing; stale/missing bid,
stale/missing ask, inverted spread, spread over max; reprice timeout; cancel after max reprices;
duplicate OMS submission; bracket take-profit/stop/max-hold/EOD exit; bracket event duplicate; quote
out-of-order; broker disconnect during bracket exit; restart with active bracket; no direct broker
path; RiskEngine still mandatory; LIVE_NO_GO still mandatory. Run full suite, typecheck,
architecture-boundary tests, golden safety suite.

## WHAT THIS PROGRAM EXPLICITLY REFUSES TO DO

Lower `consensusApprovalThreshold` or `minIndependentAgreeingAgents`; weaken calibration/RiskEngine;
bypass OMS/RiskEngine for faster exits; create a second kill switch or trading pipeline; trade
penny/microcap merely for larger % moves; increase leverage to hit $20; martingale sizing; use future
data; optimize on one PAPER period; claim guaranteed returns.

## IMPLEMENTATION SEQUENCE

1. Measure current $2,000 PAPER economics → 2. Verify IBKR real-time quote quality → 3. Build/test
controlled RTH limit execution → 4. Build/test RTH spread policy → 5. Build/test bracket
infrastructure → 6. Establish small-capital sizing experiment → 7. Re-run PAPER/OOS measurement →
8. Only then research additional intraday alpha → 9. Validate new alpha independently → 10. PAPER
soak → 11. Evaluate $20/day benchmark. **Do not skip directly to Phase 5.**

## FINAL DELIVERABLE

`ARGUS_2000_INTRADAY_PAPER_STRATEGY_REPORT.md` — current-state verification, $2,000 baseline
economics, daily P&L distribution, execution-cost analysis, IBKR market-data validation, RTH limit
architecture, RTH spread policy, bracket architecture, sizing profile, intraday strategy research,
opportunity funnel, OOS/walk-forward/cost-stress/PAPER results, drawdowns, defects discovered,
production changes, flags added, tests, final $20/day feasibility classification.

## STOP CONDITIONS

Stop rather than forcing further implementation if: baseline net expectancy is negative; execution
cost dominates gross alpha; no candidate strategy survives OOS; PAPER evidence is insufficient;
required market data is unavailable; a proposed change would weaken protected safety controls.
Report the limitation explicitly.

## FINAL PRINCIPLE

Discover enough real opportunities → estimate their edge honestly → enter selectively → control
execution cost → manage downside → exit according to hypothesis → measure net results → determine
whether ~$20/day average is actually supported by evidence. Keep PAPER mode throughout.
**Do not enable LIVE trading.**

**Important design note carried forward:** bracket take-profit/stop targets must come from the
strategy's forecast horizon, volatility, and empirical payoff distribution — never designed backward
from the desired $20 figure. Building brackets around the target dollar amount is a direct path to
overfitting Argus to this specific benchmark rather than discovering real edge.
