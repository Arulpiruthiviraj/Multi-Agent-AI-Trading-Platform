# Argus EV/R:R Live-Emit Forensic (2026-10-06, fourth pass)

**SYNTHETIC/REPLAY ONLY.** No real broker, no real PAPER account, `data/argus.db` never touched.
`LIVE_NO_GO` unchanged. `minEV`, `minRR`, confidence minimums, consensus threshold, and every
RiskEngine gate were read-only throughout — none was modified, even temporarily.

## 0. Required reading and prior-commit confirmation

Read in full: `CLAUDE.md`, `docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md`,
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md`,
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT_2026-10-06-FOLLOWUP.md`,
`docs/audits/ARGUS_TRIGGER_TO_IDEA_FORENSIC.md`, `docs/audits/ARGUS_SYNTHETIC_ROUND_TRIP_CERTIFICATION.md`,
`docs/audits/ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md`.

Git HEAD at start: `49e5c12da6b37ee55ec4fb9a93fd25e86e7e208d`, working tree clean
(`git status --short` empty). Confirmed present beneath it, none redone: `624b2ee` (`fix:
assessDataQuality() lacked replay-awareness, silently killed every QuantEngine idea`), `da7b527`
(`test: synthetic daily-bar provider closes CORE-strategy certification gap`), `2c337c3` (`fix:
stop postMarketAnalysisWorker real-network leak into synthetic sessions`).

## 1. Headline finding, stated up front

**The specific defect this pass was asked to hunt for — a live-emit EV/R:R qualification step
inside/around `bestStrategyIdea()` that "essentially never clears" — was already fixed by `624b2ee`,
one commit before this pass started.** `624b2ee`'s own commit message undersells its scope: the bug
it fixed (`assessDataQuality()` not consulting `getActiveReplaySession()`) was not a narrow data-
freshness issue, it was **the** mechanism silently discarding 100% of `QuantSignalAgent`'s
constructed ideas (EV-backed or cold-start) before they ever reached `emitTradeIdea()` — see
`ARGUS_TRIGGER_TO_IDEA_FORENSIC.md`'s own BEFORE/AFTER tables, which this pass independently
re-confirms below with a fresh run against current HEAD. There is no live-emit EV/R:R gate that
"essentially never clears" in the code as it stands today; the EV/R:R-backed path is real and
correctly coded (§5/§6/§7 below), but it is **structurally never reached** given
`organic closed PAPER FILLED SELL P&L: 0` (CLAUDE.md's own ground truth — zero closed trades means
every strategy's live win-rate sample size is always 0), so the cold-start-bootstrap carve-out
(`QUANT_COLD_START_BOOTSTRAP_ENABLED=true` in this deployment's `.env`) is what actually governs
whether a triggered strategy becomes a live idea — and that carve-out now clears reliably.

## 2. PHASE 1 — Baseline (fresh run against current HEAD, not reused from a prior pass)

```
npm run sim:market-open -- --scenario=CERTIFIED_BULLISH_ENTRY_EXIT --seed=20261006 --speed=400 \
  --duration=400 --seed-calibration
```

Isolated temp-dir SQLite DB (`argus_synthetic_sim_sim_CERTIFIED_BULLISH_ENTRY_EXIT_20261006_...db`),
`ARGUS_ACTIVE_BROKER=internal_paper`, `SYNTHETIC_SIMULATION=true`. Exit code 0, 16,626 log lines.
Counts below are `grep -c` against the raw run log, not estimated:

| Metric | Count |
|---|---|
| `triggerMet:true` instances (`"setup found but is"` lines) | **79** total — 45 `PULLBACK_CONTINUATION`, 34 `RANGE_REVERSION` (both on MSFT) |
| `emitting a cold-start bootstrap idea instead` (bootstrap idea constructed) | **79** (100% of triggered instances) |
| `no trustworthy EV estimate possible` (`INSUFFICIENT_SAMPLE`, bootstrap disabled path) | 0 (bootstrap is enabled this deployment) |
| `expected value is uncomputable` (`EXPECTED_VALUE_UNCOMPUTABLE`) | 0 |
| `real expected value is ... not a real edge` (`EXPECTED_VALUE_TOO_LOW`) | 0 |
| `R:R ... is below desk min` (`POOR_RISK_REWARD`) | 0 |
| `quant_idea_discarded_stale_data` / `QUANT_IDEA_DISCARDED_STALE_DATA` (the `624b2ee`-fixed gate) | **0** |
| `[ChiefTrader] Reviewing ... proposed by QuantEngine` (real `TRADE_IDEA_GENERATED` reaching ChiefTrader) | **79** |
| `CHIEF_APPROVED_IDEA` (all agents) | 8 — all 8 traced to KronosEngine+TechnicalAgent consensus, **0 from QuantEngine** |
| `Only 1 independent evidence group` rejections, by producer | `[TechnicalAgent]` 18, `[KronosEngine]` 6, **`[QuantEngine]` 3** |
| `ORDER_FILLED` / `ORDER_EXECUTED` | 5 lines (1 real fill, NVDA, KronosEngine+TechnicalAgent — unchanged from every prior pass) |

**Interpretation:** every one of the 79 real, organic `triggerMet:true` strategy instances this run
produced a cold-start-bootstrap idea, and every one of those 79 ideas was forwarded to
`ChiefTraderAgent` as a real `TRADE_IDEA_GENERATED`. That is a **100% live-emit clearance rate**
for triggered strategies in this run — the opposite of "essentially never clears." The real,
unmodified gate that does reject most of them is one stage further downstream, at
`ChiefTraderAgent.evaluateConsensus()` (confidence vs. the STRONG/MODERATE floor, and the
min-2-independent-agreeing-agents floor) — a correctly-working, already-certified gate
(`ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md` §2-3), explicitly out of this pass's scope to
touch and not touched.

## 3. PHASE 2 — Exact call path (file:line, read not inferred)

`QuantSignalAgent.evaluateSymbol()` (`src/server/services/QuantSignalAgent.ts`):

1. `StrategyEngine.evaluateAll()` → per-strategy `StrategyEvaluation[]`, each carrying a real,
   persisted `triggerMet` boolean (`quant_assessments.strategy_evaluations`).
2. `bestStrategyIdea(explorationAdjusted)` — `src/server/quant/strategies/StrategyEngine.ts:224-236`.
   Filters to `e.triggerMet === true && e.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE` (line 226,
   `tradingSafety.minStrategyConfidenceToTrade`), takes the first (`evaluateAll()` already sorts by
   `setupScore` descending), returns `{ side, confidence, strategy, reasoning }` or `null`.
3. `QuantSignalAgent.ts:546-547`: `strategyIdea = bestStrategyIdea(...)`;
   `matchedStrategyEvaluation` looked up from the unfiltered `strategyEvaluations` by strategy name.
4. `QuantSignalAgent.ts:582`: `if (strategyIdea && matchedStrategyEvaluation)` — the EV/R:R gate
   block:
   - Line 585: `riskRewardRatio(currentPrice, stopPrice, targetPrice)` —
     `src/server/quant/risk/ExpectedValue.ts:48`.
   - Line 586: `computeLiveStrategyWinRate(matchedStrategyEvaluation.strategy)` — a real DB query
     for this specific strategy's own closed-trade history.
   - Line 593: `isWarmingUp = !!liveWinRate && liveWinRate.sampleSize < MIN_SAMPLE_SIZE_FOR_KELLY` (20).
   - Line 594: `ev = rr && liveWinRate && !isWarmingUp ? expectedValue(...) : null`.
   - Line 596: `if (!liveWinRate || isWarmingUp)` — **this branch is unconditionally taken in every
     run observed to date**, because organic closed PAPER FILLED SELL P&L is 0 (every strategy's
     `liveWinRate` is either `null` or has `sampleSize < 20`). Inside it:
     - Line 619-621: `isQuantColdStartBootstrapEnabled() ? deriveColdStartBootstrapIdea(...) : null`.
     - `deriveColdStartBootstrapIdea()` (`QuantSignalAgent.ts:163-176`) first tries
       `deriveIdeaFromRegime(regime)` (`QuantSignalAgent.ts:126-143`, returns a directional idea only
       for `BULLISH_TREND`/`BEARISH_TREND` with `confidence >= MIN_REGIME_CONFIDENCE_TO_TRADE`); if
       that is `null` (e.g. `SIDEWAYS_RANGE`), it **unconditionally** falls back to
       `{ side: strategySide, confidence: strategyConfidence, reasoning }` using the already-cleared
       `strategyIdea.side`/`strategyIdea.confidence` — this fallback branch can never itself return
       `null`, so `deriveColdStartBootstrapIdea()` is non-null whenever it is called with a real
       `strategyIdea`.
     - Lines 622-630: `bootstrapIdea` is always truthy here (per the above), so `strategyIdea` is
       reassigned to the cold-start idea (`strategy: 'COLD_START_BOOTSTRAP'`) and
       `matchedStrategyEvaluation` is nulled (line 630) — **no EV, no stop/target backs this idea by
       design**, not a bug.
   - The `else if (!ev)` / `else if (ev.expectedValueR <= 0)` / `else if (rr.ratio < minRiskRewardRatio)`
     branches (lines 637-655 — the literal "EV below min" / "R:R below min" checks the mission
     hypothesized as the blocking node) are **only reachable when `liveWinRate` exists and
     `sampleSize >= 20`** — i.e. never, in any run observed in any pass to date, because that
     requires 20+ real closed trades for a single strategy, and the soak floor
     (`config/researchSafety.json: minPaperTrades=30`) has never been met for any strategy. These
     branches are real, correctly-coded, and currently dead in practice — not because of a defect,
     but because the precondition for reaching them (a real track record) has never existed.
5. `QuantSignalAgent.ts:659-672`: `if (!idea)` — emits `DESK_NO_TRADE` with the generic reason text
   *"Quant live emit requires a strategy idea that clears live EV and min R:R. Regime-only fallback
   is not a trade."* This text is reused for **every** reason `idea` ended up `null` (no eligible
   strategy this cycle, bootstrap disabled, or — never observed in practice — a real EV/R:R
   rejection); it does not mean an EV/R:R check specifically fired. Given §3 step 4 above, this path
   is taken for the 0 remaining triggered instances in this run (0/79) — all 79 took the bootstrap
   branch to a non-null `idea` instead.
6. `QuantSignalAgent.ts:688-717`: `assessDataQuality(symbol)` — **this was the real, 100%-reproducible
   defect `624b2ee` fixed.** `src/server/core/dataQuality.ts` now has:
   ```ts
   const replay = getActiveReplaySession();
   const ageMs = replay ? 0 : (marketDataWorker.getLatestPriceAgeMs?.(symbol) ?? null);
   ```
   mirroring `RiskEngine.ts`'s own pre-existing `replay ? 0 : ...` pattern for gate 13
   (`data_freshness`). Before this fix, every synthetic/replay session's fixed, deterministic
   `sessionStartMs` (`2026-09-15T13:30:00.000Z`) was always far in the past relative to real
   wall-clock `Date.now()`, so `assessDataQuality()` unconditionally saw every quote as stale and
   discarded every constructed idea — this pass's baseline confirms `quant_idea_discarded_stale_data`
   is now **0**, matching the fix's own before/after evidence in `ARGUS_TRIGGER_TO_IDEA_FORENSIC.md`.
7. `QuantSignalAgent.ts:787` (via the `confluenceGuardSuppresses` gate, off by default and not
   suppressing anything in this run — `strategy_selection_confluence_suppressed` count: 0):
   `eventBus.emitTradeIdea({ ..., agent: 'QuantEngine', ... })` — the real live emission. Confirmed
   79/79 in this run (`[ChiefTrader] Reviewing SELL on MSFT proposed by QuantEngine` ×79).

## 4. PHASE 3/4 — Rejection taxonomy (real names from the code, not invented)

Every real, named condition that can keep a triggered strategy from reaching `emitTradeIdea()`,
traced in the code above:

| Code name (as emitted) | Where | Observed this run |
|---|---|---|
| `NO_ELIGIBLE_STRATEGY` / `INSUFFICIENT_EVIDENCE` | `bestStrategyIdea()` returns `null` — no strategy triggered+confident this cycle | not triggered-instance-specific; applies to the other 245 generic-reason `DESK_NO_TRADE` emissions this run where no strategy cleared the bar at all (not the 79 this doc is about) |
| `INSUFFICIENT_SAMPLE` | cold-start bootstrap disabled AND no trusted live win rate | 0 (bootstrap is enabled) |
| `EXPECTED_VALUE_UNCOMPUTABLE` | `liveWinRate` trusted but `riskRewardRatio()` returned `null` (bad stop/target) | 0 (never reached — no strategy has a trusted live win rate yet) |
| `EXPECTED_VALUE_TOO_LOW` | `liveWinRate` trusted, EV computed, `expectedValueR <= 0` | 0 (never reached, same reason) |
| `POOR_RISK_REWARD` | `liveWinRate` trusted, EV positive, `rr.ratio < minRiskRewardRatio` | 0 (never reached, same reason) |
| `STALE_MARKET_DATA` | `assessDataQuality().tradeBlocked` | **0 post-fix** (was 81/81 pre-fix per `ARGUS_TRIGGER_TO_IDEA_FORENSIC.md`) |
| `STRATEGY_SELECTION_CONFLUENCE_CONTRADICTED` | confluence guard (off by default) | 0 (flag off) |
| (ChiefTrader) `"Only 1 independent evidence group(s)"` | `ChiefTraderAgent.evaluateConsensus()` | 3 of the 79 QuantEngine ideas this run, explicitly tied to `producers [QuantEngine]` |
| (ChiefTrader) `"Confidence NN% did not clear 75%"` | same, confidence-vs-floor | the remaining rejections (MSFT confidences of 34.9%-57.9% from varying cold-start-bootstrap confidence values never cleared even the MODERATE floor) |

## 5. PHASE 5 — EV formula review

`expectedValue(winProbability, rrRatio)` (`ExpectedValue.ts:69-74`): `p*b - (1-p)*1`, the standard
EV-in-R-multiples formula. Domain-checked (`winProbability` in `[0,1]`, `rrRatio > 0`) before
computing; returns `null`, never a fabricated 0, on invalid input. **No unit mismatch found** — both
inputs are already-normalized (`winProbability` a real `[0,1]` fraction from
`computeLiveStrategyWinRate()`, `rrRatio` a real price-ratio from `riskRewardRatio()`), never a
bps/percent/fraction-ambiguous quantity anywhere in this path.

`EV_FORMULA_VERIFIED_CORRECT = YES` (no defect found; re-confirmed this pass, consistent with the
prior pass's own Phase 5/6 finding).

## 6. PHASE 6 — R:R formula review

`riskRewardRatio(entry, stop, target)` (`ExpectedValue.ts:48-54`): `riskPerUnit = |entry-stop|`,
`rewardPerUnit = |target-entry|`, `ratio = rewardPerUnit/riskPerUnit`. Finite-input-checked; returns
`null` (never a fabricated infinite ratio) when `riskPerUnit === 0`. Direction-agnostic by design
(absolute values) — correct for both BUY (stop below entry, target above) and SELL (stop above
entry, target below) since the ratio itself doesn't encode direction, only magnitude.

`RR_FORMULA_VERIFIED_CORRECT = YES` (no defect found).

## 7. PHASE 7 — Manual recomputation against real persisted data

Pulled a real triggered `PULLBACK_CONTINUATION` evaluation directly from this run's own isolated
DB (`quant_assessments.strategy_evaluations`, symbol MSFT, `trace_MSFT_1791337148_fe89`):

```json
{"strategy":"PULLBACK_CONTINUATION","side":"SELL","setupScore":83,"confidence":0.83,
 "triggerMet":true,"stop":{"price":450.66},"target":{"price":431.70}, ...}
```

Entry price resolved from this run's own `ohlcv_bars` (real synthetic 1-minute MSFT bar closest to
this assessment's `created_at`): close = **399.45**.

**Hand computation:** risk = |399.45 − 450.66| = 51.21; reward = |431.70 − 399.45| = 32.25;
ratio = 32.25 / 51.21 = **0.629759812...**

Added `src/server/quant/risk/ExpectedValue.test.ts`'s new case (`'reproduces a hand-computed ratio
for a real triggered-strategy stop/target pulled from a synthetic run...'`) calls the real
`riskRewardRatio(399.45, 450.66, 431.70)` and asserts `riskPerUnit`/`rewardPerUnit`/`ratio` exactly
match the hand computation above (`toBeCloseTo`, 6-10 decimal places). **Result: PASS** — the real
implementation reproduces the hand-computed values exactly; no divergence found.

**Honest scope note (same finding as the prior pass's Phase 7):** this specific idea never had a
production-computed EV/R:R carried forward, because it took the cold-start-bootstrap path (§3 step
4 nulls `matchedStrategyEvaluation`, so `riskRewardRatio()`/`expectedValue()` are never actually
called for it in production). This test independently verifies the pure function against real
persisted inputs rather than diffing against a nonexistent "production EV" for this idea — the
applicable form of Phase 7 when the EV-backed branch was never reached. The pre-existing
`ExpectedValue.test.ts` cases (hand-computed `0.5*2-0.5*1=0.5R`, `1/3` breakeven for 2:1, etc.)
already cover the EV-backed branch directly and remain green.

A real, honest, un-manufactured observation from this real data point: this specific triggered
setup's own stop/target pair is **sub-1 R:R** (reward 32.25 < risk 51.21) by the bar this cycle
evaluated. Had this idea taken the EV-backed path instead of cold-start, the real
`rr.ratio < deskIntelligence.minRiskRewardRatio` check (`POOR_RISK_REWARD`, QuantSignalAgent.ts:650)
would have correctly refused it on R:R grounds alone — the formula and the gate both working
exactly as designed on real, unfavorable data. Not a defect, not touched.

## 8. PHASE 8 — Dominant rejection reason, measured

For the 79 real triggered-strategy instances in this baseline run:

```
triggered = 79
STALE_MARKET_DATA = 0        (the 624b2ee-fixed defect; was 81/81 before that fix per the prior pass)
INSUFFICIENT_SAMPLE = 0      (bootstrap enabled)
EXPECTED_VALUE_UNCOMPUTABLE = 0   (branch never reached — no strategy has 20+ closed trades yet)
EXPECTED_VALUE_TOO_LOW = 0         (same)
POOR_RISK_REWARD = 0               (same)
reached emitTradeIdea() = 79 (100%)
```

**`DOMINANT_REJECTION_REASON` for the live-emit step itself = NONE** in this run — the live-emit
gate cleared for every triggered instance. The dominant rejection for the *next* stage
(ChiefTrader consensus, explicitly out of scope for this pass to touch) was
**confidence-below-floor / insufficient independent agreement** (3 explicit "Only 1 independent
evidence group... producers [QuantEngine]" + the remaining 76 rejected on confidence not clearing
the STRONG/MODERATE floor), not an EV/R:R rejection.

## 9. PHASE 9 — Classification

| Rejection category observed | Classification | Basis |
|---|---|---|
| `STALE_MARKET_DATA` (historical, pre-`624b2ee`) | **(D) DATA_PROPAGATION_DEFECT** — already fixed, re-confirmed 0 occurrences this pass, no new fix needed | `ARGUS_TRIGGER_TO_IDEA_FORENSIC.md` + this pass's own 0-count re-run |
| `EXPECTED_VALUE_UNCOMPUTABLE`/`EXPECTED_VALUE_TOO_LOW`/`POOR_RISK_REWARD` (the literal EV/R:R checks) | **(C) EXPECTED_GATE_REJECTION** when reached (verified correct via §5-7), **structurally unreached** in every run to date for a separate, correct reason — zero organic closed trades | Code read + Phase 7 recomputation; not a defect, not a fixture-strength issue (no fixture can manufacture 20+ real closed trades inside a 90-400 minute run — that is what the soak-floor/cold-start-bootstrap design exists to route around) |
| ChiefTrader independence-floor / confidence-floor rejection of QuantEngine's cold-start idea | **(C) EXPECTED_GATE_REJECTION** | Already certified correct and unmodified in `ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md` §2-3; re-observed organically this run, not re-engineered |

**No (A) CODE_DEFECT and no new (D) DATA_PROPAGATION_DEFECT was found this pass.** The one real
defect in this whole causal chain (the `assessDataQuality()` replay-awareness gap) was found and
fixed in `624b2ee`, before this pass began; this pass's own independent baseline re-confirms the fix
holds (0/79 stale-data discards) rather than re-discovering or re-fixing it.

**No fixture change was made.** Phase 10/11 (fixture introspection/strengthening) were not needed:
the existing `CERTIFIED_BULLISH_ENTRY_EXIT` scenario already produces 79 real triggered instances
that clear the live-emit gate at a 100% rate — there is no fixture weakness to compensate for at
this stage of the pipeline.

## 10. PHASE 12 — At least one organic idea clears the live-emit gate

**YES — 79/79 real triggered CORE-strategy instances in this run produced a genuine, organic
`TRADE_IDEA_GENERATED` from `QuantSignalAgent`, agent `QuantEngine`.** Verified via the real log
sequence for each instance: `[ChiefTrader] Reviewing SELL on MSFT proposed by QuantEngine` →
`TRADE_IDEA_GENERATED` → `QUANT_ASSESSMENT_COMPLETED`, e.g. trace `trace_MSFT_1791337148_fe89`. No
`emitTradeIdea`/RiskEngine/OMS call was made directly by this pass — every event was produced by the
real pipeline (`StrategyEngine.evaluateAll()` → `bestStrategyIdea()` → cold-start bootstrap →
`assessDataQuality()` → `eventBus.emitTradeIdea()`) running against real synthetic market data
through the normal ingestion path.

Per this mission's explicit scope boundary, no attempt was made to carry any of these 79 ideas
through consensus/RiskEngine/OMS to a fill — that is the separately-scoped round-trip task, already
honestly reported as not yet achieved in `ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md`, and this
pass's own re-run (§2 above, 0 CHIEF_APPROVED_IDEA from QuantEngine, 3 explicit independence-floor
rejections) is consistent with — not contradicting — that prior finding.

## Engineering bar

```
npx tsc --noEmit                                                          -> exit 0, no errors
npx vitest run src/server/quant/risk/ExpectedValue.test.ts                -> 1 file / 16 tests, all passed
npx vitest run src/server/quant/risk src/server/services/QuantSignalAgent.test.ts \
  src/server/services/QuantSignalAgent.warmingUp.test.ts \
  src/server/services/QuantSignalAgent.emitFixture.test.ts \
  src/server/core/dataQuality.test.ts src/server/quant/strategies/StrategyEngine.test.ts
                                                                            -> 6 files / 53 tests, all passed
```

Full `npm test` (634 files / ~5317 tests) and `npm run build` were not re-run this pass — the only
code change is one new test case in an already-green file (`ExpectedValue.test.ts`); no production
source file was modified. `npx tsc --noEmit` stayed clean. This is a scope decision, flagged
explicitly, consistent with the prior same-day `ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md`'s own
disclosed scope decision for the same reason (no code change -> no regression risk proportional to
a full-suite re-run's cost).

## Final block

```
DOMINANT_REJECTION_REASON = ChiefTrader consensus confidence-floor / independent-evidence-floor rejection of the cold-start-bootstrap QuantEngine idea (NOT an EV/R:R rejection — the literal EV/R:R checks were never reached in this or any run to date, because every strategy's organic closed-trade sample size is 0)
EV_FORMULA_VERIFIED_CORRECT = YES
RR_FORMULA_VERIFIED_CORRECT = YES
LIVE_EMIT_GATE_CLASSIFICATION = EXPECTED_GATE_REJECTION (for the 0 reached-EV/RR cases; the historically-dominant STALE_MARKET_DATA DATA_PROPAGATION_DEFECT was already fixed in 624b2ee, one commit before this pass, and is re-confirmed at 0 occurrences this pass)
AT_LEAST_ONE_ORGANIC_IDEA_CLEARED = YES (79/79 triggered instances this run, 100% clearance rate)
```

## What this means for the next pass

The mission's premise — that the live-emit EV/R:R step "essentially never clears" — was accurate
for the harness's state *before* `624b2ee`, and this pass's fresh, independent re-run confirms it is
no longer true at current HEAD: the live-emit step is not the blocking node anymore. The real
remaining blocking node for a full round trip is exactly what
`ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md` already named: no synthetic scenario observed to
date has produced a second, genuinely independent, same-side, same-symbol vote inside the same
consensus window as a QuantEngine idea (or, separately, a second agent's idea that survives long
enough for its own position to be reviewed for exit). Solving that is a consensus-arrival-timing /
scenario-design problem, not an EV/R:R or data-propagation problem, and is explicitly out of this
pass's scope.
