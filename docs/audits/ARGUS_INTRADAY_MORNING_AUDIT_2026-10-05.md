# ARGUS — Intraday Morning Paper Session Audit (2026-10-05)

**Mode:** read-only forensic audit. No code, config, thresholds, weights, or agent toggles were changed.
No restart, no pause/resume action, no order placement/cancellation, no reconciliation action, no DB writes.
PAPER only throughout. `LIVE_NO_GO` unchanged.

## Audit window

- ET start: **2026-10-05 09:57:48**
- ET end: **2026-10-05 12:57:48**
- UTC start: **2026-10-05T13:57:48.222Z**
- UTC end: **2026-10-05T16:57:48.222Z**
- Epoch ms: `1791208668222` → `1791219468222`

For context, trading was actually enabled earlier than this window (09:08:25 ET) — see §2 for why that matters.

## 1–2. Current runtime state (verified at audit time)

- `git rev-parse HEAD`: `cf02389` — clean working tree.
- Engine: healthy, uptime ~14,216s (~3h57m) at time of writing. `tradingMode: PAPER`. `live: "NO-GO"` (confirmed, `LIVE_NO_GO` intact).
- Watchdog: healthy, single instance (`pid 7340`), fresh heartbeat.
- Budget: `$10,000`, `maxTradeSize: $3,000` — unchanged since this morning's certification.
- **`autoBotEnabled: true`** (unchanged since this morning).
- **`tradingState: TRADING_PAUSED`** — **this is not what either of us expected.** See the critical finding below.

## 3. Did any real PAPER trade happen?

**REAL PAPER TRADES IN WINDOW = 0.** Zero rows in `trades` with `timestamp` in the audit window. Zero
orders created, submitted, acknowledged, partially filled, filled, rejected, or cancelled in this window.
`risk_assessments` in window: **0**. `transaction_traces`/`consensus_decisions` in window: **0**. Nothing
reached RiskEngine or ChiefTrader's consensus-recording step at all during this window.

## Critical finding: trading was auto-paused 2.5 minutes after this morning's resume, and has stayed paused since

This was found while re-verifying runtime state for this audit, not assumed. From `kill_switch_events`:

```
2026-10-05T13:08:25.278Z  TRADING_PAUSED → TRADING_ENABLED   actor: admin
  "Operator-requested resume after full pre-market remediation/certification..."

2026-10-05T13:10:58.335Z  TRADING_ENABLED → TRADING_PAUSED   actor: system:PortfolioReconciliation
  "Portfolio reconciliation found a ~$100.00 mismatch vs IBKR Gateway (Socket) -
   trading paused pending manual review."
```

**Trading was live for only 2 minutes 33 seconds this morning.** The `$100.00 mismatch` is the same
`ACCOUNT_VALUATION_UNAVAILABLE` placeholder-impact item that has been recurring in literally every single
reconciliation cycle today (confirmed: all 36 reconciliation cycles in this 3-hour window show the identical
`{"symbol":"__ACCOUNT__","type":"ACCOUNT_VALUATION_UNAVAILABLE","localQty":0,"remoteQty":0,"approxDollarImpact":100}`
mismatch, never clearing). This is a data-unavailability placeholder (an account-level valuation the system
couldn't confirm), not a real $100 of missing money or a position discrepancy — but Argus's own
`PortfolioReconciliation` worker correctly, fail-closed, treats "cannot verify account valuation" as a reason
to pause, exactly as designed. **This is the system working as intended** (auto-pause on an unverifiable
account state, never auto-resume) — the actual defect, if there is one, is that this placeholder-level
mismatch has never once cleared across 36 consecutive checks over 3+ hours, and nobody (including me, during
the morning build-out) was watching `tradingState` after the initial resume to notice it flip back.

**This was NOT caught or reported in my "Did trading happen?" check or summary earlier this session** — I
checked for new trades and confirmed zero, but did not re-verify `tradingState` at that moment, so I did not
know trading had already been paused again when I reported "Argus is live and trading" this morning. That
report was accurate at the instant it was written but stale within minutes.

**Left exactly as found, per this audit's explicit read-only constraint — not un-paused, not acknowledged, not investigated beyond this report.**

## 4. Pipeline funnel (event counts, this window)

| Stage | Count | Distinct symbols |
|---|---|---|
| Discovery candidates filtered | 6,559 | 513 |
| Discovery candidates admitted | 3,370 | 330 |
| Subscription requested | 1,197 | 91 |
| Subscription ACK'd (IBKR) | 386 | 83 |
| Quant/strategy assessments completed | 139 | 111 |
| Quant trade ideas emitted | **0** | 0 |
| DESK_NO_TRADE (quant) | 139 | 111 |
| TRADE_IDEA_GENERATED (any agent) | 0 | 0 |
| Consensus rounds (consensus_decisions) | 0 | 0 |
| ChiefTrader approvals | 0 | 0 |
| RiskEngine assessments | 0 | 0 |
| OMS orders | 0 | 0 |
| Broker submissions | 0 | 0 |
| Fills | 0 | 0 |

**Largest drop: discovery-admitted (330 symbols) → subscribed (91 symbols) → quant-assessed (111 symbols,
overlapping but not identical to the subscribed set) → zero ideas emitted.** The funnel never reaches
consensus, RiskEngine, OMS, or the broker at all — every real drop to zero happens at or before the
quant/strategy evaluation step.

## 5. Discovery health

Discovery was genuinely active: 6,559 filter events and 3,370 admissions across 330 distinct symbols in 3
hours — this is real, ongoing scanning activity, not a stalled worker. Did not retrieve per-candidate
score/rank detail this pass (would require joining `DISCOVERY_CANDIDATE_ADMITTED` payloads individually,
out of scope given the time already spent on the higher-priority findings above).

## 6. Subscription / capacity

1,197 subscription requests across 91 distinct symbols, 386 real IBKR ACKs across 83 distinct symbols. This
is a real gap — 330 admitted candidates but only ~91 ever requested a subscription and ~83 got acknowledged.
Did not trace individual rescue-grant/denial counts or per-symbol wait times this pass. **Not confirmed as
the primary cause** — the Quant assessments that *did* happen (139, across 111 symbols — more symbols than
even got a subscription ACK, meaning some assessments used already-cached/prior bar data) uniformly returned
`NO_ELIGIBLE_STRATEGY`, not a data-unavailability code, so the subscription gap did not prevent evaluation
from happening at all, even if it may have limited which candidates got a *fresh* look.

## 7. Market data quality

893 `IBKR_HISTORICAL_DATA_ERROR` (WARN-level) events in the window — investigated directly rather than
assumed. **Error code 200 ("no security definition found"), fired against: `FB` (delisted/renamed ticker,
now META), `DIAGTEST`/`DIAGTEST1786368993694` (literal diagnostic-test placeholder symbols), and garbage
tickers (`SDFX`, `NFLQ`).** This is IBKR correctly rejecting stale/synthetic/invalid symbols from somewhere
in the candidate list — not a real data failure against legitimate, tradable symbols. **Ruled out as a cause
of zero trades.** No IBKR error 10089 (market data entitlement) observed in this window's error sample.

## 8–9. Strategy evaluations / trigger gate

139 quant/strategy assessments, 111 distinct symbols, **0 emitted a trade idea** — every single one
terminated in `DESK_NO_TRADE` with reason code `NO_ELIGIBLE_STRATEGY`: *"Quant live emit requires a strategy
idea that clears live EV and min R:R. Regime-only fallback is not a trade."* Sampled both immediately before
and immediately after the 13:10:58 auto-pause — same code both times, suggesting this reflects the
strategies' own evaluation of market conditions, not the pause. Did not break this down per-CORE-strategy
(MOMENTUM_BREAKOUT/PULLBACK_CONTINUATION/MEAN_REVERSION/TREND_FOLLOWING/RANGE_REVERSION individually) or
compute setup-score distributions this pass — the top-level `quant_assessments` table stores this in a JSON
`strategy_evaluations` blob per row that would need per-row parsing across 139 rows; flagged as a reasonable
follow-up, not done here given time constraints.

## 10. A separate, unresolved signal: TechnicalAgent/MacroAgent/Kronos went quiet

Checking `agent_predictions` (the shadow-tracking ledger, separate from `quant_assessments`): `TechnicalAgent`,
`MacroAgent`, `KronosEngine`, and the legacy `QuantEngine` entry each logged their **last** prediction at
13:09–13:11 UTC — right at the moment of the auto-pause — and **nothing since**, for the rest of the 3-hour
window. Meanwhile `JavaFactorComposite` (1,567 total, latest at 16:58 UTC) and `DiscoveryOutcomeTracker`
(44,016 total, latest at 16:56 UTC) kept recording continuously the whole time.

**I could not conclusively determine why** in the time available. Two plausible, unresolved explanations:
(a) these agents' prediction-recording is itself gated on a real `TRADE_IDEA_GENERATED` emission, and the
pause's `IDEA_GENERATION_GATED` suppression (confirmed present in this morning's earlier activity log, before
I called resume) silently blocked them from ever reaching that point again; or (b) they legitimately had
nothing new to say for 3 hours (deterministic, debounced, state-transition-based signaling — no new
crossover, no new prediction). **Classification: `INSUFFICIENT_EVIDENCE`** — flagged for a follow-up trace
of the exact call path, not resolved here.

## 11. Trade ideas

**Zero** `TRADE_IDEA_GENERATED` events of any kind in this window, from any agent.

## 12–13. Agent health / disagreement

Cannot be meaningfully assessed — with zero trade ideas and zero consensus rounds, there is no agreement or
disagreement data to measure. This is itself informative: it is not that agents disagreed and killed each
other's votes; no agent ever got far enough to cast a vote that reached the consensus-recording layer.

## 14–18. Horizon mismatch / consensus analysis / near-misses / independence / ChiefTrader

**Not applicable — `consensus_decisions` has 0 rows in this window.** There are no near-miss consensus
rounds to rank (§16), no independence analysis to perform (§17), and no ChiefTrader approvals to trace or
explain (§18), because no round ever reached that recording step. This is a direct, structural consequence
of §11 (zero trade ideas) — not a separate failure to investigate.

## 19. RiskEngine

**Zero assessments in window.** RiskEngine was never reached. **RiskEngine is conclusively not the reason
no orders happened today** — nothing got far enough upstream to ask it anything.

## 20. OMS / broker

**Zero OMS requests, zero broker submissions, zero fills.** Since RiskEngine assessments are also zero,
there is nothing to investigate here — OMS and the broker were never exercised, for better or worse.

## 21. Position / reconciliation health

- OKTA: **stayed resolved/clean for the entire window** — zero OKTA mismatches across all 36 reconciliation
  cycles today. The fix from this morning held.
- Only recurring mismatch: `__ACCOUNT__: ACCOUNT_VALUATION_UNAVAILABLE` ($100 placeholder impact), present
  in **all 36 of 36** reconciliation cycles this window, continuously unresolved — this is the issue that
  triggered the auto-pause described above.
- No `POSITION_FILL_CONFLICT`, no `RECONCILIATION_REQUIRED` (beyond the account-valuation item), no stale
  broker snapshot pattern observed this window.

## 22. Known-defect regression watch

| Defect class | Status |
|---|---|
| Stale broker state resurrecting sellable shares | NOT_OBSERVED |
| Duplicate CLOSE_LONG | NOT_OBSERVED |
| Negative unintended position | NOT_OBSERVED (OKTA stayed clean) |
| Incorrect P&L | NOT_OBSERVED (no fills to compute P&L from) |
| Triggerless strategy idea reaching actionable status | NOT_OBSERVED (0 ideas emitted at all) |
| Degenerate-input crash | NOT_OBSERVED |
| Frozen daily price | INSUFFICIENT_EVIDENCE (not directly checked this pass) |
| Market-hours fail-open | NOT_OBSERVED (market data activity consistent with RTH) |
| Bad opening-range anchoring | INSUFFICIENT_EVIDENCE (not directly checked this pass) |
| VWAP pseudo-session input | INSUFFICIENT_EVIDENCE (not directly checked this pass) |
| Kill-switch race | NOT_OBSERVED |
| Price-deviation rejection malfunction | NOT_OBSERVED (no orders attempted) |
| Broker timeout/hang | NOT_OBSERVED (engine healthy throughout, uptime continuous) |
| Watchdog failure | NOT_OBSERVED (watchdog healthy, single instance, fresh heartbeat throughout) |
| Buying-power reservation anomaly | NOT_OBSERVED (no orders attempted) |

## 23. Runtime errors

- `ERROR` level: 11, all `AI_PROVIDERS_EXHAUSTED` — no trading-path impact (advisory-only agents).
- `WARN` level: 950 total — 893 `IBKR_HISTORICAL_DATA_ERROR` (benign, see §7), 36 `RECONCILIATION_MISMATCH`
  (the account-valuation item, see §21), 12 `QUANT_BRIDGE_MALFORMED_RESPONSE`, 6 `IBKR_MARKET_DATA_ERROR`,
  3 `MODEL_FALLBACK`. None of the smaller categories were individually traced this pass.

## 24. AI provider impact

11 `AI_PROVIDERS_EXHAUSTED` errors over 3 hours, consistent with this morning's finding that most paid
providers are in real `QUOTA_EXCEEDED`/`RATE_LIMITED`/`ACCOUNT_SUSPENDED` states. **Did AI degradation block
a trade? No evidence of this** — the pathway that actually produced the only real evaluation trail this
window (Quant/strategy, 139 assessments) is deterministic and does not depend on AI providers; its
`NO_ELIGIBLE_STRATEGY` verdict is a quant/math conclusion, not an AI failure. AI degradation plausibly
explains part of §10's unresolved TechnicalAgent/MacroAgent/Kronos silence, but that is not confirmed.

## 25. Budget / sizing

Budget: $10,000, max trade size $3,000 — unchanged, confirmed. **Budget was not the cause of zero trades** —
zero RiskEngine assessments means sizing was never even evaluated.

## 26–28. Top morning movers / missed-opportunity classification / forward-outcome research

**Not performed this pass** — these require either an external market-data cross-reference (movers) or
forward-price computation beyond what the existing DB captures for symbols that were never even assessed.
Given §4's funnel already shows the drop happens at (or before) strategy evaluation for the only pathway with
real evidence, and zero ideas were generated by any agent, a missed-opportunity classification would mostly
read `NOT_DISCOVERED`/`CAPACITY_STARVED` for symbols outside the 91 subscribed, and `TRADE_IDEA_NOT_EMITTED`
for the 111 that were assessed and found `NO_ELIGIBLE_STRATEGY` — flagged as a reasonable follow-up rather
than fabricated here without the external price data to back it.

## 29. Primary bottleneck

**STRATEGY_TRIGGER_RATE** (equivalently, `NO_VALID_SETUPS`), with one important caveat below.

- **PRIMARY CAUSE:** Of the 139 real quant/strategy assessments across 111 distinct symbols this window,
  **100% returned `NO_ELIGIBLE_STRATEGY`** — none cleared the live EV/min-R:R bar required to emit a trade
  idea. This is the only pathway with a complete, traceable evidence chain this window, and it alone fully
  accounts for zero RiskEngine/consensus/OMS activity.
- **SECONDARY CAUSE (confirmed, but likely not causal to the above):** Trading was auto-paused by
  `PortfolioReconciliation` at 13:10:58 UTC, 2.5 minutes after being enabled, over a persistent
  account-valuation placeholder mismatch, and stayed paused the rest of the window. Sampled evidence shows
  the Quant pathway's `NO_ELIGIBLE_STRATEGY` verdict was identical both before and after this pause, so it
  does not appear to be the reason that specific pathway found nothing — but it may be the reason
  TechnicalAgent/MacroAgent/Kronos went silent (§10, unresolved).
- **TERTIARY CAUSE:** Discovery-to-subscription drop (330 admitted → 91 subscribed) means a meaningful
  fraction of admitted candidates never got a fresh look at all this window — not confirmed as blocking any
  specific strong setup, but a real capacity gap worth narrowing.

## 30. Counterfactual

**If the auto-pause were removed, would trades necessarily have occurred? No.** The Quant/strategy pathway's
`NO_ELIGIBLE_STRATEGY` verdict was consistent both before and after the pause — removing the pause alone
would not have produced a qualifying setup where none existed. **If `NO_ELIGIBLE_STRATEGY` were somehow
resolved and strong triggers had fired, would the pause then have blocked them? Plausibly yes** for any idea
needing to pass through the `isLiveIdeaGenerationEnabled()` gate — but no such idea was ever found to test
that against.

## 31. Healthy zero-trade determination

**`NOT_ENOUGH_EVIDENCE` to call this cleanly `HEALTHY_NO_TRADE`, specifically because of the unresolved
auto-pause.** The quant evaluation layer's own verdict (`NO_ELIGIBLE_STRATEGY`, consistently) supports a
genuinely conservative, correct "no valid setup" morning on its own — but the fact that trading was silently
paused for ~3h47m of this ~3h50m window, and that the §10 agents went quiet at exactly that boundary, means
I cannot rule out that some of the "no trade" outcome includes idea-generation that was never attempted
because it was gated, not because nothing existed to evaluate.

## 32. If trades occurred

N/A — zero trades this window.

## 33. Final scorecard

| Item | Result |
|---|---|
| ENGINE | PASS (healthy, continuous uptime, no restart during window) |
| WATCHDOG | PASS (single instance, healthy, fresh heartbeat) |
| MARKET DATA | PASS (893 historical-data "errors" are benign garbage-ticker rejections, not real failures) |
| DISCOVERY | PASS (active: 6,559 filtered, 3,370 admitted/330 symbols) |
| SUBSCRIPTIONS | PARTIAL (330 admitted → only 91 subscribed; not confirmed to have blocked a specific strong setup) |
| STRATEGY EVALUATION | PASS (139 real assessments, 111 symbols, consistently and traceably evaluated) |
| TRIGGER ACTIONABILITY | PASS (0 triggerless ideas reached actionable status — correctly, nothing reached actionable status at all) |
| AGENTS | PARTIAL (TechnicalAgent/MacroAgent/Kronos went silent at the pause boundary — unresolved, §10) |
| CONSENSUS | NOT_REACHED (0 rounds) |
| RISKENGINE | NOT_REACHED (0 assessments) |
| OMS | NOT_REACHED |
| BROKER | NOT_REACHED |
| POSITIONS | PASS (OKTA clean all window) |
| RECONCILIATION | **FAIL** (account-valuation mismatch recurred in 36/36 cycles, triggered a real, unnoticed auto-pause) |
| ERROR RATE | PASS (11 errors, all advisory-AI-related; 950 warnings, dominated by benign garbage-ticker rejections) |

## 34. Final verdict

**`MORNING_DEGRADED`**

Not `MORNING_HEALTHY_NO_VALID_TRADES`, because the reconciliation auto-pause — real, unresolved, and
unnoticed for most of the morning — means the system was not actually in the state either of us believed it
was in for ~96% of this audit window. The quant evidence independently supports "no valid setups," but the
pause itself is a genuine operational gap.

## 35. Continuation decision

**`PAUSE_AND_INVESTIGATE`**

Specifically: the operator should look at why `ACCOUNT_VALUATION_UNAVAILABLE` has not cleared across 36
consecutive cycles (likely a real IBKR account-summary subscription/data issue, not a position problem — OKTA
and all other positions reconciled clean throughout), before deciding whether to resume. This is a read-only
audit; no pause/resume/investigation action was taken here. **LIVE remains `LIVE_NO_GO`, untouched.**

## 36. Final questions

1. How long has Argus actually been running? ~3h57m continuous uptime at time of writing (since this morning's restart).
2. Was trading enabled throughout the audit window? **No — enabled for 2m33s at the very start of today's session (09:08–09:11 ET, before this audit window began), then auto-paused and has stayed paused for the rest of the morning, including this entire 3-hour audit window.**
3. How many real PAPER trades occurred? 0
4. How many orders occurred? 0
5. How many fills occurred? 0
6. How many symbols were scanned? Thousands of filter/admit events across 330+ distinct admitted symbols
7. How many were admitted? 330 distinct symbols
8. How many were subscribed? 91 distinct symbols requested, 83 ACK'd
9. How many had fresh data? Not independently quantified this pass; no entitlement (10089) errors observed
10. How many strategy evaluations occurred? 139, across 111 distinct symbols
11. How many valid triggers occurred? 0 (`NO_ELIGIBLE_STRATEGY` on all 139)
12. How many triggerless high-score setups were blocked? Not individually enumerated this pass — 0 reached actionable status, which is the invariant that matters
13. How many trade ideas were generated? 0
14. Which agent generated the most directional ideas? None — zero ideas from any agent
15. What was the largest systematic agent disagreement? N/A — no votes to disagree
16. How many consensus rounds occurred? 0
17. What was max final consensus confidence? N/A — no rounds
18. How many ChiefTrader approvals occurred? 0
19. How many RiskEngine assessments occurred? 0
20. How many RiskEngine approvals occurred? 0 (0 assessments)
21. How many OMS orders occurred? 0
22. Did broker execution block anything? No — never reached
23. Did subscription capacity materially affect trading? Not confirmed; a real gap exists (330→91) but no evidence it blocked a specific qualifying setup
24. Did stale/missing data materially affect trading? No — the 893 data "errors" are benign garbage-ticker rejections
25. Did AI provider degradation materially affect trading? Not confirmed for the pathway with real evidence (Quant is deterministic); plausible but unconfirmed contributor to §10's agent silence
26. Did any known defect recur? No — see §22, all NOT_OBSERVED or INSUFFICIENT_EVIDENCE
27. Was OKTA/reconciliation stable? **OKTA yes (clean all window). Reconciliation overall: no — the account-valuation item recurred in all 36 cycles and triggered a real auto-pause.**
28. Were any genuine strong setups missed because of a software defect? No confirmed instance — the one pathway with full evidence (Quant) consistently found nothing to miss
29. If there were zero trades, what is the single primary reason? `NO_ELIGIBLE_STRATEGY` across every real strategy evaluation this window — the quant/strategy layer itself found nothing to trade
30. Was zero trading a healthy outcome? Probably, on the evidence available, but not confirmable as cleanly healthy given the unresolved, unnoticed auto-pause — see §31
31. Is Argus functioning correctly? Mostly — discovery, quant evaluation, watchdog, and position/OKTA reconciliation all worked correctly and as designed (including the fail-closed auto-pause itself). The gap is operational visibility: nobody was watching `tradingState` after this morning's resume, and the underlying account-valuation data gap has never cleared.
32. Is it safe to continue supervised PAPER this afternoon? Yes, with the operator reviewing the auto-pause and account-valuation issue first — no trading-path defect was found, and Argus remaining paused (its current real state) is itself the safe default while that's reviewed.

## Note on this report's own process

Two self-caught errors during this audit, corrected before they became false findings in this report:
`observability_events.ts` is stored as epoch milliseconds, not an ISO string — an initial query using a
string comparison silently matched zero rows and would have wrongly suggested "no observability activity at
all" had it not been caught and re-run with the correct numeric boundaries. Separately, `DESK_NO_TRADE`'s
real reason code lives at `payload.payload.code` (double-nested), not a top-level `message` field — an
initial extraction attempt returned "UNKNOWN" for all 139 rows before being corrected by inspecting raw
sample rows directly.
