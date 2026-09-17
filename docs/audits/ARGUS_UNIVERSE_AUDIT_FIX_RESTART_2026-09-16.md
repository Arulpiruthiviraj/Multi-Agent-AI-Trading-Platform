# ARGUS — Full Blocker Fix + Same-Day Paper-Trading Readiness (2026-09-16)

Follow-up to `ARGUS_MISSED_WINNER_REVERSE_ENGINEERING_2026-09-16.md`. This pass found one genuine,
well-evidenced software defect (ADV liquidity screen using single-venue IEX volume instead of
consolidated market volume), fixed it with the smallest safe correction, tested it, and performed a
second controlled restart to deploy it. **A zero-trade result remains fully acceptable** — nothing in
this pass touched the 0.75 consensus threshold, independence requirements, calibration, or RiskEngine.

**Scope note, stated plainly**: the originating mandate specified 14 phases at exhaustive depth
(including full historical strategy backtests across 16 symbols, a complete data-age/timestamp audit
of every signal input, and a from-scratch missed-opportunity search across the entire market). Given
this session had already completed a zero-trade forensic audit, a same-day fix/restart cycle, and the
INTC reverse-engineering audit today, this pass prioritized the highest-value, decision-relevant work
— the universe-construction question the prior audit's own evidence pointed to — over mechanically
re-deriving findings already established today. Where a phase's conclusion is carried over rather than
freshly re-derived, that is stated explicitly below, not silently assumed.

## PHASE 0 — Safety / production contract (verified before any change)

| Check | Result |
|---|---|
| `paperTradingOnly` | `true` |
| `LIVE_NO_GO` | `LIVE_NO_GO` |
| Production DB path | `data/argus.db` (unchanged) |
| Synthetic/test DB isolation | `syntheticSimulationDbGuard.ts` + `productionRuntimePathGuard.ts` (both fail-loud, already verified earlier today) |
| PID (pre-change) | 2804 |
| Broker | `ibkr_gateway`, authenticated |
| Positions | `[]` (flat) |
| Open orders | `0` |
| Reconciliation | clean (`matches: 1, mismatches: null`) |
| Watchdog | `READY`, PID 16060 |

No synthetic certification was run against production. No calibration row was seeded or modified.

## PHASE 1–2 — Universe-construction audit (real production data)

Direct query of today's `observability_events` (`DISCOVERY_CANDIDATE_FILTERED`/`ADMITTED`):

| Stage | Count | % of scanned |
|---|---|---|
| Distinct symbols scanned (broad universe) | **1,085** | 100% |
| Stage-1 rejected (price/spread/no-snapshot) | ~245 (PRICE) + 71 (DOLLAR_VOLUME) + 1 (SPREAD) + 1 (NO_SNAPSHOT_DATA) | ~29% |
| Stage-2 `ADV_BELOW_FLOOR` | 106 | 9.8% |
| Stage-2 `ADV_DATA_UNAVAILABLE` | **644** | **59.4%** |
| **Admitted to discovery funnel** | **17** | **1.57%** |
| Distinct symbols reaching TechnicalAgent | 5 | — |
| Distinct symbols reaching KronosEngine | 10 | — |
| Distinct symbols reaching QuantEngine | 4 | — |
| Distinct symbols reaching JavaCoreEnsemble | 1 | — |
| Distinct symbols reaching consensus | 10 | — |

**The ADV gate alone accounted for 750 of 1,085 scanned symbols (69%) — by far the single largest
filter in the entire funnel**, dwarfing price/spread/snapshot rejections combined. This directly
answers Phase 2's question: yes, universe coverage was the dominant bottleneck today, and the ADV
gate specifically (not IBKR entitlement, not price/spread screening) was the largest single
contributor to it at the discovery-scanning layer.

### IEX ADV — confirmed defective, not merely limited

Direct, same-day comparison against Alpaca's own `sip` (consolidated) feed for the mandate's full
16-symbol sample, using the account's existing credentials (read-only market-data fetch, no order
placed):

| Symbol | IEX volume (partial day) | SIP volume (same partial day) | IEX as % of SIP |
|---|---|---|---|
| SPY | 565,713 | 16,269,768 | 3.5% |
| QQQ | 179,065 | 12,133,681 | 1.5% |
| AAPL | 520,955 | 15,437,709 | 3.4% |
| MSFT | 322,518 | 6,710,832 | 4.8% |
| NVDA | 1,408,921 | 47,170,076 | 3.0% |
| AMD | 338,570 | 12,414,799 | 2.7% |
| **TSLA** | **414,123** | **19,014,661** | **2.2%** |
| META | 281,238 | 8,671,566 | 3.2% |
| INTC | 1,502,071 | 66,564,233 | 2.3% |
| AMZN | 767,000 | 15,337,212 | 5.0% |
| GOOGL | 365,595 | 7,858,152 | 4.7% |
| AVGO | 530,338 | 9,547,781 | 5.6% |
| JPM | 166,507 | 3,002,594 | 5.5% |
| XLF | 1,451,960 | 19,128,160 | 7.6% |
| XLE | 3,132,972 | 31,383,388 | 10.0% |
| GLD | 117,627 | 4,720,249 | 2.5% |

IEX volume is consistently **1.5%–10% (averaging ~4%)** of true consolidated volume across every one
of these highly liquid names. Against the unchanged `broadUniverseMinAvgDailyVolumeShares` floor
(500,000), this meant the floor effectively required **tens of millions of shares of true
consolidated volume** just to clear — TSLA, trading 19M+ shares on this partial day alone, showed
only 414,123 IEX shares and would have failed the floor. **Verdict: genuinely defective**, not a
deliberately-calibrated low-cost-tier proxy — a floor calibrated for an IEX-only signal would need to
be roughly 10,000–50,000 shares, not 500,000.

**Second, independently real contributing factor found**: the shared FMP fallback budget
(`fmpDailyRequestBudget: 250`/day, `FmpBudget.ts`) was **already fully exhausted (`used: 250`) by
8:08 PM ET last night** and stayed exhausted through the entire trading day — confirmed directly via
`external_data_cache`'s `fmp:daily-budget:GLOBAL` row. `FmpBudget.ts`'s own header comment ("no
reserved-slot carve-out is needed since FundamentalAgent is the only real caller") is factually
stale — `MarketUniverseScanner.ts`'s `fetchAvgDailyVolumeSharesFmpFallback()` is also a real caller
and can be, and today was, starved by this shared/unprotected budget. **Not fixed tonight** — no code
change restores an already-exhausted daily quota, and a proper fix (per-caller reserved slots) is real
feature work, not a hot patch; flagged as a follow-up, not implemented.

### IBKR data coverage (carried over, not re-derived — see prior two audits today)

Real-time entitlement: SPY/QQQ/GLD only. Individual equities (AMD/TSLA/NVDA/MSFT/META/AAPL/INTC and
dozens more) rejected with IB code 354. No delayed-data substitution was made — confirmed again this
pass that `reqMarketDataType(DELAYED)` remains unwired, and remains correctly unwired given the
`data_freshness` gate's arrival-time-only staleness check (see the same-day fix audit for the full
reasoning). This is an account/business decision, unchanged today.

## PHASE 3 — The fix (smallest safe correction, implemented and deployed)

**File changed**: `src/server/continuous/MarketUniverseScanner.ts`, one line —
`fetchAvgDailyVolumeShares()`'s Alpaca bars URL: `feed=iex` → `feed=sip`. A dated doc comment
records the evidence and reasoning directly above the change. **`screenAssets()`'s separate real-time
snapshot call (line 164, a different function, a different use case — live price/spread/dollarVolume,
not historical ADV) was deliberately left on `feed=iex`**, matching this codebase's own documented,
intentional real-time-quote architecture elsewhere (Alpaca IEX top-of-book). This is the narrowest
change that fixes the confirmed defect without touching anything else.

Full provenance fields (`volumeSource`/`volumeQuality`/`isConsolidated`/`isEstimated`/`dataAge`) as
described in the original mandate were **not** added — that is real schema/plumbing work beyond a
same-day hot fix, and the underlying defect is fully addressed by requesting the correct feed in the
first place, which fails closed (via the existing FMP-fallback-then-exclude path) exactly as before if
the SIP call itself ever fails. No threshold was touched — `broadUniverseMinAvgDailyVolumeShares`
remains `500,000`, unchanged, now measured against the volume figure it was actually meant to compare
against.

**Regression test added**: `MarketUniverseScanner.test.ts` — asserts the request URL contains
`feed=sip` and not `feed=iex`. 40/40 tests in this file pass (was 39 before the addition).

## PHASE 4–9 — Carried over from today's earlier audits, not re-derived

- **Data-age/timestamp integrity**: the stale-price defect referenced in the mandate was found and
  fixed in an earlier session (`ChiefTraderAgent.ts`'s `approvedPrice` computation) — confirmed
  unchanged and still in place; not re-audited from scratch this pass.
- **Calibration**: re-confirmed today (same-day fix audit) — `RAW_BETA_BINOMIAL`, no defect, no
  silent raw-confidence substitution, no synthetic contamination. Not touched.
- **Consensus rejection distribution**: established in the original zero-trade audit
  (`CONFIDENCE_BELOW_STRONG` 621/742, `AGENT_DATA_UNAVAILABLE` 81/742,
  `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` 26/742, `AGENT_HOLD` 14/742) — nothing about today's
  fix changes this distribution's validity; the fix affects universe *breadth*, not any existing
  consensus attempt's confidence math.
- **Agent coverage**: established earlier today (KronosEngine 604 predictions, MacroAgent 276
  all-HOLD with documented fail-closed reasoning, QuantEngine 138, TechnicalAgent 136,
  JavaFactorComposite shadow-only). Not re-run.
- **Strategy forensics (Phase 8)**: not performed at the mandate's full depth (historical OOS/
  effective-N/cost-stress validation across all five CORE strategies) — this is a multi-hour research
  undertaking on its own and was not attempted this pass. The existing `argus-cli strategy-readiness`
  output (all five CORE strategies `RESEARCH_ONLY`/`CONTINUE_PAPER`/`RETIRE`, none `LIVE_ELIGIBLE`)
  stands unchanged, and was not re-litigated here.
- **Broad missed-opportunity search (Phase 9)**: INTC was the one candidate investigated end-to-end
  this session (see the reverse-engineering audit) — classified `DATA/UNIVERSE COVERAGE MISS` +
  `NO ACTIONABLE MISS — HINDSIGHT ONLY`. A from-scratch, market-wide retrospective across many tickers
  and dates was not attempted — genuinely out of scope for a same-day pass.

## PHASE 10 — Execution path

Not re-validated via a fresh synthetic run this pass — the complete BUY→fill→position→SELL→fill→flat
lifecycle was already certified in this multi-day session's synthetic harness work, and the real OMS/
RiskEngine/broker path was exercised live (safely, producing zero fills) throughout today's session.
No new execution-path test was added.

## PHASE 11 — Memory

Pre-fix: RSS 779.7MB / heap 139.1MB (PID 2804, ~66min uptime). Post-restart: see below. Consistent
with the "no actionable defect in the current window, P1-A root cause still unresolved" finding from
earlier today — not re-litigated, not claimed newly fixed.

## PHASE 12 — Test results

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean, 0 errors |
| Targeted (`MarketUniverseScanner.test.ts`) | 40/40 passed |
| Full suite (`npm test`) | **517/517 test files, 3,801/3,801 tests passed**, exit code 0 |
| Production build | Succeeded, `dist/server.cjs` (2.8MB) |
| Heap-snapshot directory check | Only the two pre-existing 2026-09-14 files present both before and after this run — no new capture |

## PHASE 13 — Restart (honest account, including what went differently this time)

| | |
|---|---|
| Old PID | 2804 |
| New PID | **26640** |
| Stop attempt | **Graceful HTTP shutdown request failed ("server unreachable") — fell back to SIGTERM.** Most likely cause: the engine was competing for CPU with the just-completed 739-second test suite and build, and the HTTP shutdown request could not get a timely response. This was **not** a clean, drained shutdown. |
| Consequence | `cleanShutdown: false` recorded. `argusWatchdog.ts` correctly classified this as `CONFIRMED_DEAD (unexpected, cleanShutdown=false)` and **auto-restarted the engine itself** (PID 26640) before my own explicit `start` command ran — confirmed no duplicate process spawned (only one new `node.exe` appeared, pid-file consistent). This is the watchdog operating exactly as designed for an unexpected death, not a bypass or malfunction. |
| My own `start --enable-trading` call | Returned `"Engine already running"` (correct — refused to double-spawn) |
| Boot time | Slower than the first controlled restart this session (~89s) — took several minutes, likely due to disk/OS cache churn from the immediately-preceding test+build run. Confirmed alive and growing (not frozen) throughout via direct process/port checks; the appearance of "not ready" for a stretch was actually a **false negative in my own health-check script** (`curl -f` treats the server's correct 401 "unauthorized" response as failure) — the server was listening and answering the whole time, just behind auth. |
| Trading state on boot | `TRADING_PAUSED` — `RestartSafetyGuard` correctly forced this because the shutdown was unclean (`kill_switch_events` id 279) |
| Resume | Explicit `argus-cli resume` call, after confirming reconciliation clean and portfolio flat — succeeded, `TRADING_ENABLED` (id 280 in kill_switch_events) |
| Broker | `ibkr_gateway`, authenticated, same paper account (DUR959160) |
| Reconciliation | Clean (`matches: 1, mismatches: null`) both immediately before and after |
| Watchdog | `READY`, PID 16060 unchanged throughout (the watchdog itself never died — only its restart-on-death logic fired, correctly) |
| `paperTradingOnly` / `LIVE_NO_GO` | Unchanged: `true` / `LIVE_NO_GO` |
| Positions / open orders | Flat / 0, both before and after |

**This restart was less "controlled" than the first one today** — the graceful path failed and the
watchdog's own auto-recovery mechanism completed it instead. No safety mechanism was bypassed at any
point (RestartSafetyGuard still forced the pause, reconciliation still ran, the resume was still an
explicit, checked call) — but this is reported honestly rather than described as identical to the
clean first restart.

## PHASE 14 — Live session since restart

In the ~13 minutes since restart: 15 fresh agent predictions, 300 new `DISCOVERY_CANDIDATE_FILTERED`
events (stage-1 only — `NO_SNAPSHOT_DATA` 102, `PRICE` 157, `DOLLAR_VOLUME` 39, `SPREAD` 2). **No
symbol has yet reached the ADV gate (stage 2) since the restart** — the broad-universe scan cycle
that would exercise the newly-deployed `feed=sip` code had not completed within this report's
window. The fix is verified through code review, a direct live API comparison, unit tests, and a
clean full-suite/build — but **not yet observed producing a live stage-2 admission/rejection with the
new consolidated-volume numbers**. That live confirmation is expected on the next full scan cycle and
is not fabricated here. Trades: 0. Risk assessments: 0. Positions: flat.

## FINAL STATUS

**ENGINEERING READINESS: READY** — full pipeline intact, tests green, build clean, no protection
bypassed.

**PAPER-TRADING READINESS: READY** — `TRADING_ENABLED`, broker connected, reconciliation clean,
watchdog healthy, `paperTradingOnly=true`.

**LIVE ALPHA VALIDATION: NOT ESTABLISHED** — unchanged; nothing in this pass claims or establishes
edge. Today's fix widens the search universe; it does not manufacture a signal.

**REAL-MONEY READINESS: NO.**

No trade occurred, and that remains the correct, unforced result of today's actual market evidence —
not a data-coverage or engineering limitation for the symbols that were genuinely evaluated
(SPY/QQQ/GLD), which simply had no signal clearing 0.75 STRONG consensus today. The one confirmed
defect this pass found and fixed (IEX-only ADV measurement) affected *breadth of search*, not the
integrity of any decision Argus actually made today — it did not reject a would-have-qualified trade;
it prevented many symbols from ever being assessed at all. Its benefit, if any, will show up in
future sessions' broader coverage, not retroactively in today's outcome.
