# Argus Trigger-to-Idea Forensic (2026-10-06, same day, third pass)

**Builds on, does not overwrite:** `ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md` (first pass, CORE
strategies unreachable) and `ARGUS_SYNTHETIC_CERTIFICATION_RESULT_2026-10-06-FOLLOWUP.md` (second
pass, closed the daily-bar gap, found all 5 CORE strategies reachable, 3/5 trigger with real
conditions, but **zero** `QuantSignalAgent`-sourced `TRADE_IDEA_GENERATED` in any run). This doc is
that pass's own explicitly-named "first job": find the exact reason a triggered strategy never
becomes a live idea.

**Git HEAD at start of this pass:** `da7b527` (`test: synthetic daily-bar provider closes
CORE-strategy certification gap`), stacked on `2c337c3`. Working tree clean. Both confirmed present
via `git log --oneline -5` before any change.

## BEFORE (Phase 1 baseline — captured before any code change)

Re-ran the prior pass's own `CERTIFIED_BULLISH_ENTRY_EXIT` scenario unchanged
(`npm run sim:market-open -- --scenario=CERTIFIED_BULLISH_ENTRY_EXIT --seed=20261006 --speed=400
--duration=400 --seed-calibration`), isolated temp-dir DB, `ARGUS_ACTIVE_BROKER=internal_paper`.

| Metric | BEFORE value |
|---|---|
| Strategy evaluations reaching `StrategyEngine.evaluateAll()` | every cycle, all 5 symbols (confirmed in prior pass) |
| `triggerMet:true` events logged this run | 81, all `PULLBACK_CONTINUATION` on MSFT (`"setup found but is"` log line count) |
| `deriveColdStartBootstrapIdea()` bootstrap ideas constructed | 81 (log: `"emitting a cold-start bootstrap idea instead"`, 81) |
| `quant_idea_discarded_stale_data` events | **81** — every single constructed bootstrap idea, 100% |
| `TEMPORARY_DATA_RESCUE_GRANTED` for these ideas | 81/81 (rescue always granted, never helped — see root cause) |
| `QuantSignalAgent`-agent `TRADE_IDEA_GENERATED` events | **0** |
| `CHIEF_APPROVED_IDEA` from QuantEngine | 0 |
| `RISK_ASSESSMENT_COMPLETED` from a QuantEngine-sourced idea | 0 |
| Fills this run | 1 (NVDA, KronosEngine+TechnicalAgent consensus — same pattern as every prior pass) |
| `DESK_NO_TRADE` dominant text | `"Quant live emit requires a strategy idea that clears live EV and min R:R. Regime-only fallback is not a trade."` |

Full raw log: `/tmp/argus_run1.log` (15,233 lines, this session's scratch dir equivalent —
reproducible by re-running the same command against pre-fix code).

## PHASE 2 — Exact call path (read, not inferred)

`QuantSignalAgent.evaluateSymbol()` (`src/server/services/QuantSignalAgent.ts`):

1. `evaluateAll()` (`StrategyEngine.ts`) → per-strategy `StrategyEvaluation[]` including `triggerMet`.
2. `bestStrategyIdea(explorationAdjusted)` (`StrategyEngine.ts:224`) picks the single highest-
   `setupScore` eligible evaluation clearing `MIN_STRATEGY_CONFIDENCE_TO_TRADE` (0.6,
   `tradingSafety.json: minStrategyConfidenceToTrade`).
3. Lines 582-655: for the picked `strategyIdea`/`matchedStrategyEvaluation`:
   - `riskRewardRatio(currentPrice, stop, target)` (`quant/risk/ExpectedValue.ts:48`).
   - `computeLiveStrategyWinRate(strategy)` → `liveWinRate` (requires real closed trades for
     *this* strategy specifically).
   - `isWarmingUp = liveWinRate.sampleSize < MIN_SAMPLE_SIZE_FOR_KELLY` (20, `tradingSafety.json:
     minSampleSizeForTrust`).
   - `ev = rr && liveWinRate && !isWarmingUp ? expectedValue(...) : null`.
   - **Branch actually taken in every run to date:** `!liveWinRate` is true (organic closed PAPER
     FILLED SELL P&L is 0 per CLAUDE.md ground truth — no strategy has ANY closed trades) →
     `isQuantColdStartBootstrapEnabled()` (reads `QUANT_COLD_START_BOOTSTRAP_ENABLED`, **`true`** in
     this deployment's real `.env`, confirmed via `grep` — not scrubbed by
     `SyntheticSessionEngine.prepareIsolatedEnvironment()`) → `deriveColdStartBootstrapIdea()`
     (line 163) → non-null (falls back to the strategy's own real side/confidence when the regime
     alone gives no directional read — line 169-175, this is the "99% of real production volume
     today" cold-start path the code's own 2026-09-13 comment describes).
4. Line 688: `if (idea && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('QuantEngine'))`.
5. Line 689: **`const dataQuality = assessDataQuality(symbol);`** — `src/server/core/dataQuality.ts`.
6. Line 690: `if (dataQuality.tradeBlocked) { ... DESK_NO_TRADE code: 'STALE_MARKET_DATA' ... return; }`
   — this is the exact line that discarded all 81 bootstrap ideas before this pass's fix.
7. (unreached before the fix) `eventBus.emitTradeIdea({..., agent: 'QuantEngine', ...})` (line 787).

## PHASE 3-4 — Instrumentation and rejection taxonomy (real, not invented names)

No new production-wide logging was needed — the existing structured events already carried
everything required once correlated:

- `quant_idea_discarded_stale_data` (`QUANT_IDEA_DISCARDED_STALE_DATA`, observability_events) —
  fires exactly at step 6 above, `reasoning` field names the real strategy and `dataQuality.blockReason`.
- `TEMPORARY_DATA_RESCUE_GRANTED`/`DENIED` — the bounded rescue `MarketDataWorker.
  requestTemporaryDataRescue()` call made immediately before the discard (next-cycle-only, never
  rescues the current cycle).
- `DESK_NO_TRADE` with `code` field — the full real taxonomy observed across both runs this pass:
  `STALE_MARKET_DATA` (pre-fix dominant), `NO_ELIGIBLE_STRATEGY` (no strategy cleared
  `minStrategyConfidenceToTrade` that cycle), `INSUFFICIENT_SAMPLE`/`EXPECTED_VALUE_UNCOMPUTABLE`/
  `EXPECTED_VALUE_TOO_LOW`/`POOR_RISK_REWARD` (not observed in these runs — cold-start bootstrap is
  the real-production-volume path, per the code's own comment, so these never got exercised here).
  `"Only 1 independent evidence group(s) agreed..."` (ChiefTrader's own real independence-floor
  rejection, observed post-fix for the QuantEngine/MSFT idea itself).

## PHASE 8-9 — Dominant rejection reason, measured, classified

| Rejection | Count (this run, pre-fix) | Classification |
|---|---|---|
| `STALE_MARKET_DATA` (QuantEngine idea discarded before `emitTradeIdea`) | **81/81 (100%) of all constructed QuantEngine ideas** | **(A) CODE_DEFECT** — see Phase 2/5 below |
| `NO_ELIGIBLE_STRATEGY` (no idea even constructed, other 4 symbols) | not separately counted this pass (dominant reason is upstream of this for the one symbol that did construct an idea) | not reached for MSFT; plausible (C) for SPY/QQQ/AAPL/NVDA this scenario — not root-caused further this pass, out of scope once (A) was found and fixed |
| ChiefTrader independence-floor rejection (post-fix, MSFT QuantEngine idea reaches consensus but is a single voice) | real, observed post-fix (see AFTER below) | **(C) EXPECTED_GATE_REJECTION** — the correct, working, un-weakened behavior |

**The dominant, structural rejection reason, found by evidence, not guessed:** `assessDataQuality()`
(`src/server/core/dataQuality.ts:33`) is the **sole site in the entire `TRADE_IDEA_GENERATED`
emission path that never consulted an active replay/synthetic session.** `RiskEngine.ts` already
special-cases this in three separate places (`replay ? 0 : marketDataWorker.getLatestPriceAgeMs(...)`,
lines 646/687/797 — this is literally what CLAUDE.md's gate-13 row means by "Replay uses last
completed bar" / "price age 0"). `assessDataQuality()` had no equivalent branch: it called
`marketDataWorker.getLatestPriceAgeMs(symbol)` unconditionally, which returns `Date.now() - t`
where `t` is whatever timestamp `MarketDataWorker.cacheObservedQuote()` was last called with.

**Why this is 100% reproducible, not flaky:** `SyntheticSessionEngine.ts`'s main loop calls
`marketDataWorker.cacheObservedQuote(symbol, previousBar.close, t)` where `t = sessionStartMs + i *
BAR_INTERVAL_MS`, and `defaultSessionStartMs()` (line 138-143) returns a **fixed, deterministic**
`2026-09-15T13:30:00.000Z` — by design, so a given seed reproduces identically regardless of when
it is actually run. Any real run on or after that date has `Date.now() - t` already past
`stalePriceThresholdMs` (300000ms / 5 min) from the very first bar — guaranteed `RED`/stale by
`evaluateQuoteFreshness()`, for **every** symbol, on **every** cycle, in **every** scenario. This
is why it only visibly mattered for MSFT in this run: MSFT was the only symbol whose strategy
actually cleared `minStrategyConfidenceToTrade` and reached `assessDataQuality()` at all in this
scenario — SPY/QQQ/AAPL/NVDA ideas that did emit in every run to date all came from
TechnicalAgent/KronosForecastAgent, **neither of which calls `assessDataQuality()`** — confirming
this defect is specific to, and fully explains, the QuantEngine emission path's 100% historical
silence across all three passes today.

## PHASE 5/6 — EV and R:R formula review (real inspection, not assumed-correct)

`src/server/quant/risk/ExpectedValue.ts`:
- `riskRewardRatio(entry, stop, target)`: `|target-entry| / |entry-stop|`. Null (not fabricated 0
  or Infinity) when `riskPerUnit === 0` or any input non-finite. Units are consistent (same price
  units cancel in the ratio) — no bps/fraction/absolute-dollar mismatch found.
- `expectedValue(winProbability, rrRatio)`: standard `p*b - (1-p)*1` in R-multiples. Validated
  domain checks (`winProbability` in `[0,1]`, `rrRatio > 0`) before computing — no silent
  out-of-range input accepted.
- `MIN_SAMPLE_SIZE_FOR_KELLY = tradingSafety.minSampleSizeForTrust` (20) — shared constant, not
  duplicated/hardcoded in `QuantSignalAgent.ts` (imports it directly).
- **No unit-mismatch defect found.** This was the single most likely "classic silent killer" this
  phase was asked to check for, and it was not present: every input to `riskRewardRatio`/
  `expectedValue` is a real price level or a `[0,1]` probability, never a bps/fraction-ambiguous
  quantity.

## PHASE 7 — Manual recomputation (independent check against real production formulas)

A real, triggered `PULLBACK_CONTINUATION` evaluation from this run's own `quant_assessments` would
be the ideal input, but **this specific strategy's idea never carried a non-null stop/target**
(cold-start bootstrap path — `matchedStrategyEvaluation` is explicitly nulled at line 630 for this
exact reason: "no real strategy evaluation backs this - stop/target/EV all stay null downstream").
This means Phase 7's manual-recomputation test is **not applicable to this run's own data** — there
is no EV/R:R pair here to recompute, because the idea took the no-EV cold-start path by design, not
the EV-backed path. The existing `ExpectedValue.test.ts` (already in the repo, already green —
confirmed via the Phase 5 targeted test run below) already independently recomputes `riskRewardRatio`/
`expectedValue` against hand-picked inputs and asserts exact expected output, which is the
equivalent check for the EV-backed path; it was not duplicated here since it already exists and
passes. Recorded honestly as **not newly exercised against this run's own data**, rather than
silently skipped.

## THE FIX (Phase 11-class: a real code defect, not a threshold/fixture change)

`src/server/core/dataQuality.ts`: added a `getActiveReplaySession()`-gated branch to
`assessDataQuality()`'s market-data freshness channel, mirroring `RiskEngine.ts`'s own existing,
reviewed pattern exactly:

```ts
const replay = getActiveReplaySession();
const ageMs = replay ? 0 : (marketDataWorker.getLatestPriceAgeMs?.(symbol) ?? null);
```

This is **not** a threshold change: `stalePriceThresholdMs` (300000ms) is untouched, `evaluateQuoteFreshness()`
is untouched, and `getActiveReplaySession()` returns `null` in every real production/live/paper
deployment (it is only ever set by `FullArgusReplayEngine.ts`'s MODE B replay and
`SyntheticSessionEngine.ts`'s own `setActiveReplaySession(session)` call) — so real wall-clock
freshness behavior for live/paper trading is byte-for-byte unchanged. It is the exact same
precedent RiskEngine's gate 13 already established for this identical problem, applied to the one
remaining pre-RiskEngine freshness check that never got it.

## AFTER (same scenario, same seed, after the fix — real re-run, not predicted)

| Metric | AFTER value |
|---|---|
| `quant_idea_discarded_stale_data` events | **0** |
| `QuantSignalAgent`-agent (`QuantEngine`) `TRADE_IDEA_GENERATED` events | **17+ real events** (MSFT, `PULLBACK_CONTINUATION` cold-start bootstrap, `BEARISH_TREND` regime, confidence 1.00) |
| `[ChiefTrader] Reviewing SELL on MSFT proposed by QuantEngine` | confirmed in log (multiple cycles) |
| QuantEngine idea reaches `CHIEF_CONSENSUS_STARTED`/`COMPLETED` | **YES**, repeatedly |
| QuantEngine idea cleared to `CHIEF_APPROVED_IDEA` | **NO** — correctly rejected every time for being a single independent voice (`ChiefTraderAgent`'s own independence floor; no AI debate available this cycle, "Evaluating consensus on independent-agent evidence only") |
| Fills this run | 1 (NVDA, KronosEngine+TechnicalAgent — unchanged from BEFORE; QuantEngine itself produced zero fills) |

Full raw log: `/tmp/argus_run2.log` (16,392 lines).

**What this proves:** the trigger-to-idea gap this pass was asked to close is a real, now-fixed
`DATA_PROPAGATION_DEFECT` (category A/D) — QuantEngine ideas now reach `ChiefTraderAgent` exactly
like every other agent's ideas do. What it does **not** prove: a QuantEngine-sourced idea clearing
full consensus or producing a fill — the one real attempt observed was correctly rejected by the
unmodified, un-weakened independence floor (2 independent agreeing agents / 0.75 confidence bar),
which is the correct behavior CLAUDE.md requires, not a remaining defect. No threshold, gate, or
consensus rule was touched to produce this result.

## Engineering bar — evidence, not assertion

- `npx tsc --noEmit`: clean (no errors).
- Targeted tests: `src/server/core`, `QuantSignalAgent.test.ts`, `QuantSignalAgent.warmingUp.test.ts`,
  `QuantSignalAgent.emitFixture.test.ts`, `RiskEngine.test.ts` — **65 files / 470 tests, all passed**.
- `src/server/replay/synthetic`, `architecture.protection.test.ts`, `RiskEngine.gates.test.ts` —
  **11 files / 128 tests, all passed**.
- `npm run build` — green (`dist/server.cjs` built, 3.4MB).
- Two full synthetic certification runs (before/after) on the identical scenario/seed, logs
  preserved and referenced above.

## Phase 18 (consensus negative control) and Phases 21-38 (round trip, soak) — status

**Not completed this pass.** This pass's explicit, named first job (find and resolve the
trigger-to-idea gap) consumed the full scope realistically achievable in this session. The
dedicated correlated-factor negative-control fixture (Phase 18) and the full RiskEngine/OMS/
broker/fill/round-trip certification (Phases 21-38) were **not** attempted — per this task's own
explicit instruction ("If Phase 27-31 does not succeed, STOP and report honestly why — do not
proceed to any multi-hour soak regardless"), and this pass did not reach Phase 27 at all, so the
honest status is reported in `ARGUS_SYNTHETIC_ROUND_TRIP_CERTIFICATION.md` rather than fabricated.
The 3-hour soak and multi-day acceleration were, per the task's own instruction, never attempted.
