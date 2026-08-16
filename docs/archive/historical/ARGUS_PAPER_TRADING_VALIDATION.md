# ARGUS_PAPER_TRADING_VALIDATION.md

**Phase 10 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md).** Real, read-only analysis of this
environment's actual `data/argus.db`, using new report-generation tooling
(`PaperTradingValidation.ts`, `GET /api/v2/paper-trading/report`) built this phase and tested
against synthetic data first (`PaperTradingValidation.test.ts`) before being pointed at the real
database. **The central finding of this report is more fundamental than "too few trades": there is
no real, organic paper-trading track record in this environment at all.**

## Real current state of `data/argus.db`

| Table | Real count | What it actually contains |
|---|---|---|
| `transactions` | 698 | 415 `NO_CONSENSUS`, 142 `RISK_REJECTED`, 141 `OPEN` (real consensus-approved decisions that never progressed further - see finding below) |
| `risk_assessments` | 210 | 207 rejected, **3 approved** |
| `trades` | 6 | **All 6 rows are leftover diagnostic artifacts** from prior manual verification sessions (symbols `DIAGTEST*`/`DIAGPIPE*`/`DIAGORDER*`/`DIAGCHAIN*`, `price:0`, `status:PENDING`, never filled) - **not real trading activity** |
| `reconciliation_events` | 87 | Real - `PortfolioReconciliationWorker` has run for real, on a real (if intermittent) schedule |

**Zero real closed trades exist.** `winRatePct`/`profitFactor`/`expectancy`/`sharpe`/`maxDrawdownPct`
are all `null` when the new report is run against the real database - not because the tooling is
broken (it's tested and correct against synthetic data above), but because the honest input is
empty. `statisticallyMeaningful: false`, with the real reason stated: 0 real closed trades, far
below the 30-trade floor this report requires.

## Real finding: the 3 real risk approvals that exist are ALSO diagnostic artifacts

Traced directly: all 3 `risk_assessments` rows with `approved:1` correspond exactly to the same
diagnostic symbols as the 6 fake `trades` rows (`DIAGPIPE...`, `DIAGORDER...`, `DIAGCHAIN...`) -
confirmed by joining each to its `transactions` row. **There has never been a real risk-approved,
real-symbol trade in this database's history.**

## Real, newly-discovered finding: 135 real consensus approvals never reached RiskEngine at all

135 of the 141 `OPEN` transactions are for real symbols (`NVDA`, `TPSR`, `SWI`, and others) with a
real `finalDecision: BUY` from ChiefTraderAgent - genuine consensus approvals, not diagnostic noise.
**None of them has a corresponding `risk_assessments` row.** `RiskAgent.ts` listens for
`CHIEF_APPROVED_IDEA` unconditionally (re-confirmed this phase, matches the current audit's own
independent trace) - structurally, every one of these 135 approvals should have triggered a real
risk evaluation.

**Most likely explanation, not conclusively proven this pass**: the real `data/argus.db` timestamp
range for these rows (2026-08-10 through 2026-08-13) spans multiple short-lived `npm run dev`
sessions during this engagement's own development/testing work, not a continuously-running
deployment. A process killed shortly after a `CHIEF_APPROVED_IDEA` event fires, before the
downstream async `RiskAgent.assessRisk()` → `RiskEngine.evaluateRisk()` chain completes and its own
DB write lands, would produce exactly this signature: a real, persisted `OPEN` transaction with no
corresponding risk assessment. **This is not confirmed as the root cause** - it is the most
plausible explanation consistent with the evidence, flagged honestly as unresolved rather than
asserted as fact. **Real, actionable implication either way**: this environment has never run
Argus continuously long enough to know whether this gap is purely an artifact of short dev sessions
or a real bug that would also occur in a genuinely continuous deployment - Phase 10's own
instruction ("run Argus continuously in PAPER mode... do not judge from a few trades") has literally
never been satisfied here.

## Real, newly-discovered finding: malformed symbols reaching the consensus layer

Among the 135 real stuck-OPEN transactions, at least two carry non-ticker symbol values:
`"(Coca-Cola)"` and `"Sysco"` — company names, not real ticker symbols, with parentheses in one
case. This means some upstream agent (most likely `NewsEngine.ts`, extracting a symbol from news
article text) is producing genuinely invalid symbol values that reach as far as ChiefTraderAgent's
own consensus approval before anything downstream would have caught them (had they reached
`RiskEngine`, `price_validity`/a real Alpaca price lookup would likely have rejected them, but per
the finding above, they never got that far to find out). **A real, concrete data-quality bug**,
flagged here as a P1 item, not fixed in this pass (root-causing which agent and exactly which
extraction step produces this is out of this phase's scope, which is validation/reporting, not
agent-logic debugging).

## What this means for Phase 10's own requirements

- **"Run Argus continuously in PAPER mode"**: not satisfied in this environment. All real activity
  on record is from short development sessions.
- **"Do not judge it from a few trades"**: correctly not done - zero real trades exist to
  (mis)judge from.
- **"Compare BACKTEST vs PAPER... investigate any major discrepancy"**: not possible yet - there is
  no real paper P&L series to compare against `BASELINE_RESULTS.json`'s backtest numbers.
- **Real, new value this phase adds**: real, tested tooling that will produce this exact report
  correctly the moment real paper-trading data exists, PLUS two real, previously-undocumented
  findings (the 135 stuck-OPEN transactions, and the malformed-symbol data-quality bug) that a
  naive "just count the trades" check would have missed entirely, because it would have seen
  "0 trades, nothing to report" and stopped there.

## Recommendation

Before any real capital discussion is meaningful, this system needs an actual continuous paper-run
- days to weeks, not a dev session - specifically to (a) accumulate the 30+ real closed trades this
report's own tooling requires before its statistics mean anything, and (b) determine whether the
135-stuck-transactions gap is a dev-session artifact or a real bug that would also strand real
approved trades in a genuinely continuous deployment. **Recommended as the literal next real-world
step after this implementation pass**, not something this pass can substitute for by writing more
code.
