# Paper capital and protective-exit certification

Status: working document, 2026-10-12. PAPER only. LIVE_NO_GO. Nothing here is deployed behavior unless marked DEPLOYED.
Evidence base: `src/server/engines/RiskEngine.ts` (line numbers are from main@caf7895), `src/server/services/PortfolioMonitor.ts`, live observations of Oct 12.

## 1. How a protective exit travels today (DEPLOYED, main@95838c6 in the running engine)
`PortfolioMonitor.reviewPortfolio()` (timer, `portfolioMonitorMs` = 60 s) -> `emitRiskExit()` emits a SELL idea (agent = risk-exit agent, origin `PORTFOLIO_EXIT`) -> `ChiefTraderAgent.isRiskExit()` (agent AND origin) skips debate and min-agents -> `RiskAgent` -> `RiskEngine.evaluateRisk()` (all gates) -> OMS -> broker.

- [C] Exit protection is **software-only**. No broker-resident stop/limit order is created by Argus. The reconciliation job reported MATCH with the broker on every cycle, so no unknown working order existed; an independent read of the PAPER account's working orders has not been possible from this session (the available connector shows a different, empty account).
- [C] The monitor is a timer inside the Node process. During the periodic engine freezes observed on Oct 12 it did not run (review gaps of 242 s and 283 s; ~4 min freezes on a 15 min cycle). A freeze therefore delays every software exit.
- Intent is not modelled explicitly: ChiefTrader distinguishes only "risk exit" vs everything else; RiskEngine sees `side` and (BUY only) `closePositionIntent`.

## 2. Gate-by-intent matrix (what actually happens to a SELL today)
`approved = !firstFailure` over every recorded gate (RiskEngine ~1000); a failed gate rejects the order regardless of its purpose.

| Gate | Applies to SELL today? | Effect on a protective exit | Proposed treatment (needs approval) |
|---|---|---|---|
| `emergency_stop` | Yes (requires `TRADING_ENABLED`) | A pause or emergency stop blocks exits too | Keep for EMERGENCY_STOP; review whether a plain pause should block position-reducing orders |
| `autobot_enabled` | No (blocks BUY only) | none | none |
| `daily_loss` | **Yes** (broker-equity based, no side branch) | Once tripped, the exit that would stop the loss is rejected | Exempt for verified protective closes |
| `consecutive_loss` | **Yes** | Same | Exempt for verified protective closes |
| `portfolio_drawdown` | **Yes** (broker-equity based) | Same | Exempt for verified protective closes |
| `order_rate_limit` | **Yes** (counts all assessments/min) | A burst of entries can starve an exit | Separate exit allowance |
| `market_hours` | Yes | Legitimate: no regular-session exit outside hours | Keep |
| `data_freshness` | Yes (quote age) | No fresh quote -> exit refused | Review: allow broker-reported mark for protective closes? |
| `news_veto` | Yes, **exemptable** | Review branch `complete/protective-exit-seal` (1908ae7) exempts a sealed protective SELL; NOT deployed on the running engine unless restarted onto it | Done on branch, awaiting deployment |
| `price_validity` | Yes | Legitimate | Keep |
| `sell_position_exists` | Yes | Mandatory: prevents unintended shorts | Keep (mandatory) |
| `sufficient_size` | Yes | Mandatory: valid whole-share quantity | Keep |
| `argus_capital_allocation`, `daily_buy_notional` | No (BUY only) | Exit not consumed by new-entry allocation | none |
| `extended_hours_execution_policy` | Session dependent | Keep | Keep |

Mandatory controls that must never be waived for a protective close: account identity, verified existing long quantity, no unintended short, order validity, OMS idempotency, broker state, reconciliation, venue/session rules.

## 3. Evidence available / missing
- [C] On the review branch the news-veto exemption is a single-use seal minted only by `PortfolioMonitor.emitRiskExit`, bound to (traceId, symbol, SELL), propagated by ChiefTrader only from the genuine risk-exit branch, forwarded by RiskAgent and consumed by RiskEngine. Forged, replayed, wrong-trace, wrong-symbol, BUY and expired seals fail closed. Tests: seal unit tests, RiskEngine integration (5), ChiefTrader propagation (2, red without the change).
- [U] A tripped `daily_loss`/`consecutive_loss`/`portfolio_drawdown` gate rejecting a SELL is established by reading the code, not by an executed test; a synthetic test that trips each gate with an open long is still to be written.
- [U] No synthetic test yet covers: event-loop block during a stop crossing, partial protective fill, duplicate close request, stale broker quantity, restart before acknowledgment.

## 4. Capital model (DEPLOYED facts)
- Settings read back after the operator-approved change: budget **$20,000**, maxTradeSize $1,000, maxOpenPositions 2, dailyLossLimit $250, maxPortfolioDrawdownPct 0.05, FIXED_DOLLAR, PAPER. Open positions: DDOG 10 sh (~$2.9 k), S 38 sh.
- [C] `argus_capital_allocation` enforces the budget on BUY notional (budget minus open positions minus pending BUYs). It is independent of broker buying power.
- [C] `daily_loss` and `portfolio_drawdown` measure **broker account equity** (~$1.0 M simulated), not research equity. A 5% drawdown limit is therefore ~$50,000, and the $250 daily-loss figure compares against whole-account equity movements (which include unrelated simulated-account effects). Neither protects a $20 k research account as intended.
- [C] The 2026-10-12 incident this caused: the $50 daily-loss limit was set, would have tripped before DDOG's -5% stop (~$145) and then blocked the protective SELL; it was raised to $250 by the operator.
- Requirement still open: a research-equity basis (research starting capital + realized + unrealized P&L of Argus-originated positions) for daily-loss and drawdown, using the existing accounting layer, with the capital invariants of section 5 tested.

## 5. Capital invariants to prove (none yet covered by a dedicated test)
Allocation cap; pending BUYs reserve; partial fills update reservations; open positions consume allocation; rejected/timed-out orders release exactly once; OMS retry does not double count; closing orders are not blocked by the entry notional ceiling; drawdown and daily loss on the research basis; broker buying power never overrides the budget; restart with pending orders.

## 6. Next steps in order
1. Approve or amend the exit-exemption policy in the matrix (daily loss, consecutive loss, drawdown, exit rate allowance).
2. Write the gate-trip synthetic tests (open long + each tripped gate) and the chaos cases in section 3.
3. Implement the research-equity basis and the section 5 tests.
4. Decide on broker-resident protective orders (new order mechanism; separate architecture review).
5. Deploy `complete/protective-exit-seal` only after the full suite on the exact SHA.
