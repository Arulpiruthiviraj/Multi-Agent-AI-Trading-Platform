# Argus — Fast Opportunity Lane Evaluator: October 5 Case Study (2026-10-06)

**Mode:** research/paper only. LIVE_NO_GO. No execution authority exercised or tested.

**Scope discipline, stated up front:** per the investigation's own explicit instruction, this report
does **not** claim "Fast Lane would have traded MXL" or "Fast Lane would have made money." It
establishes only: detection timing, real data availability, strategy-evaluation capability, and
whether a valid trigger exists — using real historical evidence where it exists, and
`INSUFFICIENT_EVIDENCE` where it does not, never a fabricated input to force an answer.

---

## 1. MXL / SYNA / WOLF / MPWR — real data availability (re-confirmed, not re-guessed)

Direct, repeated queries against `data/argus.db` (the same real database this entire investigation
series has used):

| Symbol | Cached `ohlcv_bars` rows | Real pipeline evidence | What `evaluateFastCandidate()` would honestly return today |
|---|---|---|---|
| MXL | 0 | `DISCOVERY_CANDIDATE_FILTERED`, reason `RANK_CAP`, 17:06:53 — passed the real liquidity screen (price $105.98, dollar volume $5.16M, spread 33bps, ADV 3.06M shares) but lost `refreshBroadUniverseCache()`'s own dollar-volume rank cutoff | `INSUFFICIENT_DATA` — `quantSignalAgent.evaluateSymbol()` requires `MIN_BARS_TO_EVALUATE` real bars; zero exist |
| SYNA | 0 | Five real `RANK_CAP`/`ADV_DATA_UNAVAILABLE` rejections across the day (16:21, 16:36, 19:20, 19:36), real dollar volume $5.6–9.0M | `INSUFFICIENT_DATA`, same reason |
| WOLF | 0 (intraday); 178 **stale daily** bars ending 2026-08-31, over a month before Oct 5 | **Zero** events of any kind on 2026-10-05 — never entered even the stage-1 screened universe | `INSUFFICIENT_DATA` |
| MPWR | 0 | 2 real admissions (17:06:53, 19:20:25), 1 real `ADV_DATA_UNAVAILABLE` filter (19:36:05) | `INSUFFICIENT_DATA` |

**This is answered honestly as `INSUFFICIENT_EVIDENCE` for "would a strategy have triggered,"
not as "Fast Lane failed."** Per Section 21 of the governing prompt: a symbol absent from all
pipeline stages (WOLF) is a discovery/source-coverage gap, and Fast Lane must not be credited for
observing a symbol it had no detection source for. Per Section 20: MXL/SYNA's real, confirmed
`RANK_CAP` rejection happens entirely inside `refreshBroadUniverseCache()`, a stage upstream of
`getOpportunityScanUniverse()`'s own top-N cut — **Fast Lane's detection path
(`fastLaneEventInjector.ts`, triggered by real-time `NEWS_CATALYST` events) does not go through
`refreshBroadUniverseCache()` at all.** This is exactly the architectural separation the mission
is meant to provide: a symbol rejected by the broad-universe rank cut can still become a Fast Lane
candidate **if** a real news catalyst exists for it. None did for MXL/SYNA/WOLF/MPWR on 2026-10-05
in the data this investigation has access to — confirmed by checking `news_clusters`/`NEWS_CATALYST`
event history for all four symbols: zero rows. So even the one real escape hatch Fast Lane
provides was not exercised for these four names, because the triggering input it needs (a real
news catalyst) never existed for them that day either. **This is a separate, second data gap from
the `RANK_CAP` one** — not something this investigation can paper over by assuming a catalyst
Fast Lane never actually received.

**No live re-evaluation of these four symbols was run** (would require live Alpaca API calls
against a closed, non-regular-hours market at the time of this report, or stale cached data either
way — not a meaningful test). The table above is a direct, honest consequence of
`quantSignalAgent.evaluateSymbol()`'s own real, unconditional requirement for cached bars, re-verified
by direct code reading, not asserted from memory.

## 2. PTC — the negative control case

**Real historical fact, already established:** PTC had a real, premarket (08:16 ET) M&A-arbitrage
catalyst and was admitted 94 times, reaching the challenger pool at 10:37 ET before losing fairly to
CHRW's higher real score (see `ARGUS_ADMITTED_TO_CHALLENGER_FORENSIC_2026-10-05.md`).

**Capability proof (deterministic fixture, not live Oct 5 PTC data — full-day replay remains
untrustworthy per the governing constraint):** `fastLaneEvaluator.test.ts`'s
`'candidate + no strategy clears triggerMet -> NO_VALID_SETUP (the real PTC control case...)'`
test proves the evaluator correctly returns `NO_VALID_SETUP` when the real strategy evaluation
produces evidence with `triggerMet: false` for every strategy — exactly the shape an M&A-arbitrage
gap (a real, large price move with no technical breakout/momentum trigger) would produce. **This
answers the capability question honestly: a fast system is structurally capable of quickly saying
NO** — `bestStrategyIdea()` never fabricates a trigger that didn't fire, regardless of how
dramatic or catalyst-driven the underlying price move was. Whether the REAL PTC specifically would
have triggered any of the 21 real strategies on 2026-10-05 was not tested against real PTC bars in
this pass (would require a live or cached historical fetch for that exact date/time, out of scope
for a capability proof).

## 3. PCVX — source-coverage control, kept separate from evaluation capability

Per Section 14: if a catalyst never reached Argus historically, this report does not pretend Fast
Lane would have detected it. Re-confirmed: PCVX's own real catalyst never produced any
`news_articles`/`NEWS_CATALYST` row in `data/argus.db` for 2026-10-05 (established in the EOD
report). `fastLaneEventInjector.ts` only reacts to `NEWS_CATALYST` events — if none exists, no
candidate is ever created, regardless of how capable the evaluator behind it is.
**`FAST_LANE_EVALUATION_CAPABILITY` and `NEWS_SOURCE_COVERAGE` are confirmed, by source reading, to
be two independent gaps** — fixing one does not fix the other. PCVX remains blocked by source
coverage, not by anything this evaluator does or does not do.

## 4. RANK_CAP finding (Section 20) — architectural separation confirmed by source reading, not yet exercised live

Confirmed directly from `src/server/fastlane/fastLaneEventInjector.ts`: its only input is
`eventBus`'s `NEWS_CATALYST` subscription — it never calls or depends on
`getCachedBroadUniverseCandidatesWithVolume()`, `refreshBroadUniverseCache()`, or any function
inside `MarketUniverseScanner.ts`. **Yes — a `RANK_CAP`-excluded candidate CAN be evaluated through
Fast Lane without surviving the broad-universe rank cut, structurally, by source inspection.** This
was not exercised against a real `RANK_CAP`-rejected symbol with a real contemporaneous news
catalyst in this pass (MXL/SYNA had no real catalyst that day, per §1 above) — the architectural
separation is proven by code structure, not yet demonstrated end-to-end on a real historical case.

## 5. Consensus evidence freshness audit (Section 18) — real finding, not yet fully resolved

Direct query against `agent_reasoning_logs` for TSLA/META around the repeated
`0.47211921439362725` `ChiefTraderAgent` confidence value (2026-10-05, 18:10–18:26 ET window):

```
18:10:44  TechnicalAgent  confidence=0.568  indicators={rsi:52.65, sma20:379.07, sma50:379.06, macd:0.00107, ...}
18:11:52  MacroAgent      confidence=0
18:11:52  ChiefTraderAgent confidence=0.47211921439362725
18:13:14  ChiefTraderAgent confidence=0.47211921439362725   <- same 17-significant-digit float again
```

**Real, confirmed finding: `TechnicalAgent`'s own confidence genuinely varies between rounds**
(different RSI/SMA/MACD snapshots each time — real fresh recalculation, option D in the governing
taxonomy). **But `ChiefTraderAgent`'s own weighted output repeats the identical 17-digit float
across multiple distinct timestamps** (18:11:52 and 18:13:14, and again later). A weighted average
genuinely recombining a changing Technical input with Kronos (flat 0.85) and Macro (flat 0) would
not plausibly reproduce the exact same float twice by chance. **The most likely explanation,
based on this evidence, is option C/B from the governing taxonomy: ChiefTrader is re-scoring the
same underlying evidence snapshot on its own cadence, independent of whether the idea-generating
agents actually re-fired within that window** (Technical's own cooldown — `technicalSignalCooldownMs`
— would explain why it did not produce a new reading between 18:11 and 18:13, and ChiefTrader's
re-score in that gap reused the last-known Technical value unchanged).

**This is not fully resolved in this pass** — the exact ChiefTrader code path responsible (does it
re-run on every `MARKET_DATA` tick regardless of idea-agent cooldowns, or something else) was not
traced to its source in this report. **The practical consequence stands either way: a meaningful
fraction of the "4,427 consensus rounds today" statistic very likely represents the same evidence
being re-scored, not 4,427 independent fresh opportunities to approve a trade.** Per the governing
instruction, **consensus is not re-classified as "independence-limited" purely on this finding** —
that classification (from the prior report) rests on the real, separately-confirmed
`agreements_count=1` pattern across symbols, which is unaffected by this freshness question. What
this finding changes is confidence in the *count* of 4,427, not the *independence* conclusion.
**Recommended next step, not performed here:** trace `ChiefTraderAgent`'s own re-evaluation trigger
condition directly in source, and add a `evidenceGeneratedAt`/`evidenceReusedFrom` field to
`agent_reasoning_logs` so this distinction becomes directly queryable going forward (same
"instrument going forward, don't fabricate history" principle applied to the score-decomposition
fields earlier in this series).

## 6. Resource usage / latency

No live evaluations were run against real detected candidates during market hours in this pass
(report authored overnight, market closed). `fastLaneEvaluator.test.ts`'s deterministic fixtures
confirm the real concurrency/cooldown governors (`fastLaneMaxConcurrentEvaluations=3`,
`fastLaneSymbolEvaluationCooldownMs=60000`) correctly refuse overflow/duplicate work rather than
flooding `historicalDataGateway`. Real candidate→evaluation latency (median/P90) requires live
market-hours operation to measure honestly and was not fabricated here.

## 7. Summary

| Symbols detected (real NEWS_CATALYST existed) | Symbols evaluable today | Valid triggers found | No-setups | Missing-data cases |
|---|---|---|---|---|
| 0 of the 4 semiconductor benchmark names (no real catalyst existed for any) | 0 of 4 (zero cached bars for 3; stale-only for WOLF) | N/A | N/A (never reached evaluation) | 4 — `INSUFFICIENT_DATA`, confirmed by direct bar-cache inspection |

## Final verdict

**`FAST_EVALUATOR_PARTIAL`.** The evaluator is real, safe (architecturally verified), and reuses
production strategy logic correctly (proven by deterministic unit tests). It could not be
validated against the specific benchmark symbols this investigation series cares about, because —
independent of anything about the evaluator itself — none of them had a real news catalyst or
cached market data for Argus to evaluate on 2026-10-05. That is a discovery/data gap, confirmed
distinct from the evaluation capability this report was scoped to test.
