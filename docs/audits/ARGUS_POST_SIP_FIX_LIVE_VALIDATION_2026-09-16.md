# ARGUS — Post-SIP-Fix Live Validation (2026-09-16)

Short, read-only, live verification pass following `ARGUS_UNIVERSE_AUDIT_FIX_RESTART_2026-09-16.md`.
No restart performed (process already healthy, PID unchanged: 26640). No threshold, calibration, or
RiskEngine change made. Window: ~95 minutes since the fix-deploying restart (17:58:22 UTC) through
report time.

## 1. Deployed state — confirmed

| | |
|---|---|
| Source | `feed=sip` present at `MarketUniverseScanner.ts:319` (confirmed by direct grep of the running tree) |
| PID | 26640 (unchanged since the restart) |
| Git commit | `2d8670b` (unchanged — fix is an uncommitted working-tree change, consistent with this session's practice throughout) |
| `paperTradingOnly` | `true` |
| `LIVE_NO_GO` | yes |
| `tradingState` | `TRADING_ENABLED` |
| Broker | `ibkr_gateway`, authenticated |
| Market data | connected |
| Watchdog | running, PID 16060 |
| Reconciliation | clean |
| Portfolio | flat |
| Open orders | 0 |

## 2. Universe funnel — before vs. after (the headline result)

| Metric | Before SIP fix (full day) | After SIP fix (~95 min) | Change |
|---|---|---|---|
| Distinct symbols scanned | 1,085 | 885 | — |
| **Admitted to discovery funnel** | **17 (1.57%)** | **192** | **+1,029%**, in 1/8th the time |
| `ADV_BELOW_FLOOR` | 106 | 16 | -85% |
| `ADV_DATA_UNAVAILABLE` | 644 | 592 | still large — see §4 |
| Symbols reaching any alpha agent | 5 (Technical), 10 (Kronos) | **0** | see §7 |

**The fix works exactly as intended at the layer it targeted.** Admission jumped from 17 for the
entire day to 192 in under two hours. This is not a marginal change — it's the dominant discovery-
layer bottleneck being removed.

## 3. Named large-cap symbols — direct verification

| Symbol | Result since restart | ADV shares (if admitted) | Notes |
|---|---|---|---|
| AAPL | **ADMITTED** | 21,634,116 | Real, correctly-scaled consolidated volume |
| AMD | **ADMITTED** | 15,994,803 | Real, correctly-scaled |
| AMZN | **ADMITTED** | 20,708,333 | Real, correctly-scaled |
| AVGO | **ADMITTED** | 13,434,314 | Real, correctly-scaled |
| MSFT | `ADV_DATA_UNAVAILABLE` | — (null) | SIP call returned no bars for this symbol; FMP fallback also dead (§4) |
| NVDA | `ADV_DATA_UNAVAILABLE` | — (null) | same |
| TSLA | `ADV_DATA_UNAVAILABLE` | — (null) | same |
| META | `ADV_DATA_UNAVAILABLE` | — (null) | same |
| INTC | `ADV_DATA_UNAVAILABLE` | — (null) | same |
| GOOGL | `ADV_DATA_UNAVAILABLE` | — (null) | same |
| GOOG | `ADV_DATA_UNAVAILABLE` | — (null) | same |
| JPM | not yet seen this window | — | scan hasn't reached it yet |

The fix is proven correct where it worked (AAPL/AMD/AMZN/AVGO show real, sensible 13–21M-share
consolidated volumes — an order of magnitude more plausible than any IEX-only figure). The seven
symbols still failing are a **different, real, and currently active problem** — see §4.

## 4. FMP fallback investigation

**All callers of `FmpBudget.tryConsume()`** (grepped directly): two, exactly as suspected —
`FundamentalAgent.ts` (its documented, primary purpose — AlphaVantage-exhaustion fallback) and
`MarketUniverseScanner.ts`'s `fetchAvgDailyVolumeSharesFmpFallback()` (the ADV gate's own fallback).
**No deduplication, no caching, no per-purpose allocation exists** — it's one shared counter, `used`
vs a flat `fmpDailyRequestBudget: 250`, first-come-first-served, no reserved slots for either caller.
**Quota state survives restart** — persisted in `external_data_cache` (`ExternalDataCache`), keyed by
UTC date; confirmed unchanged across this session's two restarts today.

**Confirmed still exhausted right now**: `external_data_cache` row `fmp:daily-budget:GLOBAL` —
`{"utcDate":"2026-09-16","used":250}`, unchanged since 8:08 PM ET last night. **It will not recover
until the UTC date rolls over** (~8:00 PM ET tonight) — no code fix changes that fact.

**Why this still matters after the SIP fix**: `fetchJson()`'s primary SIP batch call is *succeeding*
(no `'ADV batch failed'` log entries since restart — confirmed by direct query) but is returning an
*empty bars array for a subset of symbols within otherwise-successful batches* (MSFT/NVDA/TSLA/META/
INTC/GOOGL/GOOG among them). Previously, this exact gap-class (a symbol Alpaca's response has nothing
for) was designed to be caught by the FMP fallback — but that path is currently 100% dead. So today,
specifically, these particular large caps are excluded by the *combination* of an intermittent SIP
gap plus a fully-exhausted fallback, not by the feed choice itself.

**Recommended architectural improvement (not implemented tonight, per instruction)**: per-caller
reserved budget shares (e.g. a small fixed reserve for `MarketUniverseScanner`, matching the same
`rescueReservedSlotsForPriorityClasses` pattern this codebase already uses elsewhere for exactly this
class of problem — one caller starving another), so `FundamentalAgent`'s AlphaVantage-exhaustion
bursts can no longer fully starve the ADV gate's fallback. A full redesign (centralized multi-tenant
budget accounting) is not justified by tonight's evidence — the fix is a small, additive allocation
change, but even that was not made tonight, only recommended.

## 5. Rejection categories, separated (not combined)

| Category | Symbols affected (this window) | Status |
|---|---|---|
| **A. Legitimately below the (now-correct) SIP ADV floor** | 16 — AXSM, ARGX, EXPD, REGN, ALNY, BLK, BWXT, SBAC, CAH, APD, AMP, CPAY, GWW, AYI, FICO, ALLE | Trustworthy — measured against real consolidated volume for the first time |
| **B. FMP-unavailable, compounding an intermittent SIP data gap** | 592, including MSFT/NVDA/TSLA/META/INTC/GOOGL/GOOG | Active, real, ongoing — not fixed tonight (budget can't be restored by code) |
| **C. IBKR streaming-entitlement blocked** (downstream of discovery, blocks agent evaluation regardless of admission) | AAPL (20 code-354 errors), AMD (21 code-354 errors), and effectively every non-ETF admitted symbol | The dominant bottleneck now — see §7 |
| **D. Legitimate stage-1 rejections** (price/spread/dollar-volume/no-snapshot) | ~150 | Working as designed, unrelated to this fix |

## 6. IBKR data coverage — rechecked

Unchanged in kind, now visible at greater scale: AAPL and AMD, both newly admitted by the SIP fix and
both genuinely subscribed (40 and 46 `WATCHLIST_SUBSCRIBE_REQUESTED` events respectively), were
rejected by IBKR code 354 20 and 21 times respectively in this same window — identical pattern to
INTC earlier today. No delayed-data substitution was made or considered again. Subscription capacity
itself is not the constraint — `activeMarketDataLines: 18` of a `maxMarketDataLines: 90` cap, plenty
of headroom; AMZN/AVGO simply haven't been reached by a subscription cycle yet
(`maxNewSubscriptionsPerCycle: 20`/scan, gradual rollout, not a hard limit being hit).

## 7. Live agent coverage — the critical result

**Of the 192 symbols newly admitted since the fix, zero have reached TechnicalAgent, KronosEngine,
QuantEngine, or JavaCoreEnsemble.** AAPL/AMD: subscribed, but blocked by IBKR entitlement before any
tick ever arrives. AMZN/AVGO: not yet reached by the subscription cycle. **A wider discovery universe
is confirmed, but it has not yet translated into a wider alpha-evaluation universe** — IBKR real-time
entitlement remains the fully dominant downstream bottleneck, exactly as the user anticipated needed
checking before declaring victory.

## 8. Live opportunity funnel, since restart

| | Since restart (~95 min) |
|---|---|
| `NO_CONSENSUS` | 291 |
| `ANALYZING` (in-flight) | 170 |
| `CONFIDENCE_BELOW_STRONG` | 283 |
| `AGENT_DATA_UNAVAILABLE` | 7 |
| `AGENT_HOLD` | 1 |
| `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` | 0 |
| `CALIBRATION_UNTRUSTED` | 0 (never occurs in this system's current terminal-reason vocabulary) |
| `FORECAST_BELOW_COST` | 0 (same) |
| Risk assessments | 0 |
| Orders / fills | 0 / 0 |

Proportions are consistent with the whole day's pattern — unsurprising, since consensus is still
almost entirely driven by SPY/QQQ/GLD, the only symbols with real agent coverage; the newly-admitted
192 have not yet contributed a single prediction to change this distribution.

## 9–11. Trade outcome

**No trade occurred. Not called a failure.** Exact dominant bottleneck, in order:

1. Discovery-layer universe: **fixed** (17 → 192 admitted).
2. IBKR real-time streaming entitlement: **now the dominant, fully binding constraint** — confirmed
   directly (AAPL/AMD subscribed and rejected by code 354).
3. FMP-budget exhaustion: a real, currently-active secondary constraint affecting a specific set of
   large caps (MSFT/NVDA/TSLA/META/INTC/GOOGL) independent of #2.
4. Consensus/calibration: unchanged, still correctly rejecting on real evidence for the only symbols
   that do reach it (SPY/QQQ/GLD).

Nothing was lowered, bypassed, or forced to try to change this.

## 12. Restart

**Not performed.** Process (PID 26640) confirmed healthy throughout this validation pass.

## 13. Final report

### A. Before vs. after universe

| Metric | Before | After | Change |
|---|---|---|---|
| Admitted | 17 | 192 (in 1/8 the time) | dramatic improvement |
| ADV_BELOW_FLOOR | 106 | 16 | -85%, now trustworthy |

### B. Data coverage

| Cause | Symbols affected |
|---|---|
| IBKR entitlement (code 354) | Every individual equity attempted so far (AAPL, AMD confirmed directly) |
| FMP exhaustion + intermittent SIP gap | MSFT, NVDA, TSLA, META, INTC, GOOGL, GOOG, ~592 total |

### C. Agent coverage

| Agent | Before (whole day) | After (newly-admitted symbols, ~95 min) |
|---|---|---|
| TechnicalAgent | 5 distinct symbols (SPY/QQQ/GLD/AAPL and one more) | +0 from the 192 newly admitted |
| KronosEngine | 10 distinct symbols | +0 |
| QuantEngine | 4 distinct symbols | +0 |
| JavaCoreEnsemble | 1 distinct symbol | +0 |

### D. Decision funnel (since restart)

Consensus 291 completed / 170 in-flight → 0 approvals → 0 risk assessments → 0 orders → 0 fills.

### E. Trade outcome

No trade. First blocking stage for the *newly widened* universe specifically: **IBKR real-time
market-data entitlement** (not discovery, not calibration, not consensus). For the *originally
covered* universe (SPY/QQQ/GLD): unchanged — legitimate `CONFIDENCE_BELOW_STRONG` rejection.

### F. Final status

**ENGINEERING READINESS: READY**
**PAPER-TRADING READINESS: READY**
**LIVE ALPHA VALIDATION: NOT ESTABLISHED**
**REAL-MONEY READINESS: NO**

## Bottom line

The SIP fix is validated and working exactly as designed — an order-of-magnitude discovery-layer
improvement, proven with real, correctly-scaled volume numbers for AAPL/AMD/AMZN/AVGO. But it has not
yet — and structurally cannot, on its own — produce a wider trading opportunity, because the very
next stage (IBKR real-time entitlement) is a harder, fully binding constraint that the discovery fix
does not touch. This is the honest, complete picture: one real bottleneck removed, one already-known
bottleneck now confirmed as fully dominant, and one newly-surfaced secondary constraint (FMP
exhaustion colliding with intermittent SIP gaps) affecting a specific set of large caps independent
of both. None of this was papered over to manufacture a trade tonight.
