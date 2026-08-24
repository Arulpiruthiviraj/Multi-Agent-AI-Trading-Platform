# ARGUS — Independent Prediction Learning & Market Regime Architecture — Implementation Audit

**Scope:** the full 14-phase architecture was authorized and built in this pass (the user explicitly chose "build the full architecture now" after being shown the confirmed bug and the tradeoffs). This report documents exactly what was built, what evidence backs each claim, and what remains a known limitation rather than silently narrowing scope after the fact.

---

## 1. Executive summary

**The core question this work answers:** does raw, correlated prediction data currently distort Argus's live `ChiefTraderAgent` consensus weighting? **Yes — confirmed by direct code trace, not assumed.** `ReflectionEngine.evaluateAgents()` fed raw (uncorrelated-for) prediction counts into `agentWeightUpdate()`'s sufficiency gate, which cleared `minSampleSizeForTrust` (20) by orders of magnitude for tick-driven agents, computing a real, non-neutral `currentWeight` from an autocorrelated win rate that `ChiefTraderAgent` then used directly in weighted consensus math.

**What was built to close this:**
- An **effective-sample-aware weight-learning pipeline**: `ReflectionEngine.evaluateAgents()` now gates `currentWeight` changes on EFFECTIVE N (time-gap-clustered, per-agent independence policy), not raw N. Raw stats are preserved and persisted unchanged (never hidden).
- A **per-agent independence policy** module (Kronos's shorter horizon, QuantEngine's strategy-id/bootstrap secondary key, PortfolioManager's exclusion from weight learning).
- A **bounded, gradual weight-adjustment mechanism** (`boundedStep`) — one noisy cycle cannot snap a live weight to an extreme, and insufficient evidence causes gradual rollback toward the agent's static default, not a frozen stale value.
- A **lightweight, no-look-ahead market-regime classifier** for tick-driven agents (TechnicalAgent), reusing existing daily-bar regime capture (`quant_assessments.regime`, Kronos's own `volatility`/`marketStructure`) wherever it already existed rather than duplicating it.
- **Quant cold-start bootstrap observability** that keeps bootstrap-idea statistics visibly separate from EV-backed strategy statistics in reporting (the live `currentWeight` scalar itself remains necessarily per-agent-blended — a structural fact of the existing, protected `ChiefTraderAgent` architecture that this pass does not and should not change).
- A **scaffold-only TradingAgents shadow interface** — types and a null adapter, zero live wiring, zero external integration code.

**Nothing here lowers `consensusApprovalThreshold`, `minIndependentAgreeingAgents`, weakens RiskEngine/OMS/news_veto, or claims trading edge.** `PAPER_TRADING_ONLY=true` and `LIVE_NO_GO` are unchanged throughout.

---

## 2. Exact implementation scope

Built in full: Phases 1–5 (trace, independence policy, evidence taxonomy, effective-sample learning, sufficiency gate), 8–9 (bounded safe learning pipeline, portfolio/risk-exit isolation), 10 (quant cold-start observability), 11 (TradingAgents scaffold), 12 (tests), 13 (read-only runtime verification), 14 (this document).

Built with intentionally reduced scope vs the original spec's most ambitious version: Phase 6/7's regime classifier is a genuinely new, lightweight, tested module for tick-driven agents specifically — it does **not** replace or duplicate `RegimeEngine.ts` (Quant/backtest's real multi-feature daily-bar classifier), which continues to be the regime source of record wherever daily bars are already available. Phase 2's "per-agent independence policy" is a small resolver-function module (`independenceClusterGapMs`, `isExcludedFromWeightLearning`, `secondaryGroupKey`), not a class-per-agent plugin architecture — deliberately, per the spec's own "do not overengineer" instruction.

---

## 3. Files changed

| File | Change |
|---|---|
| `src/server/db/schema.ts` | `agentPredictions.regime` (new, nullable text); `agentPerformanceStats.effectivePredictions/effectiveCorrect/wilsonLower/wilsonUpper/evidenceStatus` (new) |
| `drizzle/0044_independent_learning.sql`, `drizzle/meta/_journal.json` | Migration for the above (backward-compatible `ALTER TABLE ADD`, all nullable or defaulted) |
| `src/server/research/predictionIndependencePolicy.ts` (new) | Per-agent cluster-gap, weight-learning exclusion, secondary-key resolvers |
| `src/server/research/effectiveSampleSize.ts` | Extended: `secondaryKey` on `ClusterableRow`, `tagRowIndependence()`, `classifyEvidenceStatus()` |
| `src/server/research/agentWeightPolicy.ts` | Added `boundedStep()` |
| `src/server/research/lightweightRegimeClassifier.ts` (new) | No-look-ahead regime classifier for plain price-array agents |
| `src/server/research/tradingAgentsShadow.ts` (new) | Scaffold-only types + null adapter |
| `src/server/services/ReflectionEngine.ts` | `evaluateAgents()` rewritten for effective-N gating, bounded adjustment, risk-exit exclusion; `logPrediction()` persists `regime` |
| `src/server/services/TechnicalAgent.ts` | Captures + emits a real regime string per idea |
| `src/server/config/tradingSafety.ts`, `config/tradingSafety.json` | New: `maxWeightAdjustmentPerCycle` (0.15), `tradingAgentsShadowEnabledEnvVar` |
| `src/server/config/quantThresholds.ts`, `config/quantThresholds.json` | New: `lightweightRegimeMinBars` (20), `lightweightVolatilityHighBandWidthPct`/`lightweightVolatilityLowBandWidthPct` (0.04/0.015) |
| `scripts/prediction_accuracy_status.ts` | Rewritten to group by (agent, secondaryKey, bucket) and use per-agent cluster gaps; new `quantColdStartBootstrap` / `quantEvBackedStrategies` report sections |
| `.env`, `.env.example` | `TRADING_AGENTS_SHADOW_ENABLED=false` added |
| 7 new/extended test files | See §16 |

---

## 4. Data flow before and after

**Before:**
```
agent_predictions (raw, unbounded correlation)
  → prediction_outcomes (1:1 per row, no clustering)
    → ReflectionEngine.evaluateAgents(): raw total/correct
      → agentWeightUpdate({totalEvaluated: RAW total, winRate: RAW winRate})
        → agent_performance_stats.currentWeight (unbounded single-cycle change)
          → ChiefTraderAgent.agentWeights[agent] (live consensus math)
```

**After:**
```
agent_predictions / kronos_predictions (raw, unchanged - never hidden)
  → prediction_outcomes (unchanged evaluation logic)
    → ReflectionEngine.evaluateAgents():
        raw total/correct (persisted, observability)
        + rowsByAgent[agent] (symbol, side, timestampMs, outcome, secondaryKey)
          → rawVsEffectiveDirectional(rows, independenceClusterGapMs(agent))
            → effectiveN, effectiveWinRate, evidenceStatus
              → IF isExcludedFromWeightLearning(agent): weight frozen (PortfolioManager)
              → ELIF LEARNING_ELIGIBLE: boundedStep(previous, agentWeightUpdate(effective).currentWeight, maxDelta)
              → ELSE (INSUFFICIENT_EVIDENCE): boundedStep(previous, staticDefault, maxDelta)
                → agent_performance_stats.currentWeight (bounded, evidence-gated)
                  → ChiefTraderAgent.agentWeights[agent] (live consensus math, unchanged read side)
```

`ChiefTraderAgent`'s own read of `agent_performance_stats.currentWeight` is byte-for-byte unchanged — the fix is entirely upstream of it, in how that value gets computed.

---

## 5. Raw vs effective sample behavior

Both are always computed and both are always persisted (`totalPredictions`/`correctPredictions` = raw; `effectivePredictions`/`effectiveCorrect` = effective). Neither silently replaces the other anywhere in the codebase. `scripts/prediction_accuracy_status.ts` (already existed from the prior pass, extended this pass) displays both side by side for every agent/secondaryKey/confidence-bucket combination, plus the Wilson 95% interval for each.

---

## 6. Production learning path findings

**Confirmed by direct code trace (CODE evidence), not assumed:**
- `ReflectionEngine.evaluateAgents()` (pre-fix) built `statsMap[agentName].total` from every `prediction_outcomes` row with zero deduplication.
- `agentWeightUpdate()` (`agentWeightPolicy.ts`) gates on `totalEvaluated < tradingSafety.minSampleSizeForTrust` (20) — raw N for TechnicalAgent (tens of thousands per the forensic audit) cleared this by ~1000×.
- `ChiefTraderAgent.ts` loads `agent_performance_stats.currentWeight` directly into `this.agentWeights[agentName]` at construction/refresh and uses it in `resolveWeight()` → `EvidenceAggregator.aggregate()` — real, live consensus-math consumption, not a dead read.

**This was real, not hypothetical**, for every agent except KronosEngine (already de-duplicated at the write level in the prior pass, though its own tick-driven autocorrelation was still uncorrected at the weight-gate level until this pass).

---

## 7. Whether correlated observations previously affected currentWeight

**Yes, confirmed.** See §6. This pass closes the gap by gating on effective N (§4) rather than by claiming the old behavior was merely theoretical.

---

## 8. Agent-specific independence policies

| Agent | Cluster gap | Rationale |
|---|---|---|
| KronosEngine | `kronosEvaluationHorizonMs` (5 min) | Its own natural forecast horizon is much shorter than the generic 60-minute window (M5 finding) |
| QuantEngine | generic 60 min + `secondaryGroupKey` (real strategy id, or `COLD_START_BOOTSTRAP`) | Different strategies (and the cold-start bootstrap path) are structurally different signal sources and must never share one cluster series |
| PortfolioManager (configured `riskExitAgent`) | generic 60 min, but `isExcludedFromWeightLearning` | Risk-exit ideas are not directional-alpha calls; stats are computed and exposed, but never drive `currentWeight` |
| Every other agent (TechnicalAgent, News, Fundamental, Macro, etc.) | generic 60 min (`evaluationHorizonMs`) | No agent-specific reason found yet to diverge; default preserved |

---

## 9. Market regime methodology

**Reuse over duplication:** QuantEngine already captures a real, deterministic regime (`RegimeEngine.classifyRegime()`, multi-feature DMI/trend/volatility vote over real daily bars) into `quant_assessments.regime` at generation time — untouched by this pass. Kronos's own forecast already carries `volatility`/`marketStructure` fields from the model itself. The one real gap was tick-driven agents holding only a plain closing-price array (TechnicalAgent) with no regime capture at all.

**New: `lightweightRegimeClassifier.ts`** — reuses `technicalSignal.ts`'s existing `calcSMA`/`calcBollingerBands` (no duplicated indicator math). Short-vs-long SMA slope for trend direction (`BULLISH_TREND`/`BEARISH_TREND`/`SIDEWAYS_RANGE`, same type as `RegimeEngine.ts` for cross-codebase consistency), Bollinger-band-width-as-fraction-of-price for volatility (`HIGH`/`LOW`/`NORMAL`, using dedicated new thresholds — **not** `RegimeEngine.ts`'s `volatilityPercentileHigh/Low`, which are percentile-rank thresholds in a different unit; reusing them was a real bug caught and fixed during this pass's own testing, see §17). `insufficientData: true` (never a fabricated regime) below `lightweightRegimeMinBars` (20).

---

## 10. Explicit proof of no look-ahead bias

`classifyLightweightRegime(prices: number[])` takes exactly one parameter (asserted directly in `lightweightRegimeClassifier.test.ts`: `classifyLightweightRegime.length === 1`) and has no external clock, no database read, no cache — it is a pure function of the array it is given. The dedicated test constructs a full 100-tick series with a violent crash after tick 60, computes the regime using only the first 60 ticks, and proves the result is identical whether or not the caller later constructs the crash continuation — because the function is never given it. `TechnicalAgent.ts` calls this with its own rolling `priceHistory` array, which by construction only ever contains ticks up to and including the current one.

---

## 11. Evidence sufficiency methodology

`classifyEvidenceStatus(effectiveN, minEffectiveSampleSize)` returns `LEARNING_ELIGIBLE` only at or above the floor, else `INSUFFICIENT_EVIDENCE` — never a graded "maybe." The floor reused is `tradingSafety.minSampleSizeForTrust` (20), an existing, already-reviewed number — **applying the same floor to effective rather than raw N is strictly more conservative** (effective N ≤ raw N always), so this pass can only ever make the system *more* cautious about claiming sufficient evidence than before, never less. No new "magic number" was invented.

---

## 12. Weight adjustment safety bounds

`boundedStep(previous, target, maxDelta)` (`agentWeightPolicy.ts`) clamps the per-cycle change to at most `tradingSafety.maxWeightAdjustmentPerCycle` (0.15) in either direction. Applies identically whether moving toward a newly-computed target (evidence sufficient) or toward the agent's static default (evidence insufficient — gradual rollback, not an instant snap to neutral). A dedicated test (`agentWeightPolicy.test.ts`) proves a single cycle cannot reach a far-away target and that convergence requires multiple consistent cycles.

---

## 13. Portfolio/risk exit isolation

`isExcludedFromWeightLearning(agentName)` returns true for `agentWeightConfig.riskExitAgent` (config-derived, not a hardcoded string — `config/agentWeights.json`'s existing, already-reviewed `"riskExitAgent": "PortfolioManager"`). Its raw/effective stats are still computed and persisted (never hidden, per the architectural principle), but `currentWeight` is pinned to whatever it already was — proven directly by a real integration test seeding a 100%-effective-win-rate series for the risk-exit agent and asserting `currentWeight` stays at 1.0.

---

## 14. Quant cold-start monitoring

`secondaryGroupKey('QuantEngine', reasoning)` returns the real strategy id (parsed from the existing `"QuantEngine/<STRATEGY>: ..."` reasoning format `bestStrategyIdea()` already produces) or `'COLD_START_BOOTSTRAP'` for the regime-only bootstrap idea (matching its own distinct reasoning text). `scripts/prediction_accuracy_status.ts` now reports a dedicated `quantColdStartBootstrap` section, kept fully separate from `quantEvBackedStrategies` — run read-only against the real DB and confirmed to correctly report "No bootstrap ideas observed yet" (accurate: the flag was only just enabled, no bootstrap idea has fired in the live DB as of this pass).

**Known, structural limitation, stated explicitly (not glossed over):** `agent_performance_stats.currentWeight` remains a single scalar per agent name — `ChiefTraderAgent`'s live weight lookup (`this.agentWeights[agentName]`) has no per-strategy or per-secondaryKey concept at all. This is a fact of the existing, protected consensus architecture, not something this pass modifies (doing so would mean changing how `ChiefTraderAgent` resolves weights, which is exactly the kind of protected-spine change CLAUDE.md's architecture contract says to stop and flag rather than silently implement). The observability separation in the diagnostic script is therefore the correct and complete answer within that constraint — full statistical separation at the live-weight level would require a `ChiefTraderAgent` architecture change this pass does not attempt.

---

## 15. TradingAgents shadow status

Scaffold only, as explicitly permitted by the spec. `src/server/research/tradingAgentsShadow.ts` defines `ArgusMarketSnapshot`, `ShadowOpinion`, `TradingAgentsShadowAdapter` (interface) and ships exactly one implementation, `NullTradingAgentsShadowAdapter`, which always returns null. `isTradingAgentsShadowEnabled()` reads a new, default-`false` env var that **no code calls** — the flag exists so the config contract is documented, not because anything is wired to it. Nothing in this file is imported by `ChiefTraderAgent`, `RiskEngine`, `QuantSignalAgent`, `EventBus`, or any other live path. Confirmed by a grep-level check: this module has zero importers outside its own test file.

---

## 16. Tests and results

New/extended test files this pass:

| File | Tests |
|---|---|
| `predictionIndependencePolicy.test.ts` | 7 |
| `effectiveSampleSize.test.ts` (extended) | 15 total (4 new: secondaryKey isolation, tagRowIndependence ×2, classifyEvidenceStatus) |
| `agentWeightPolicy.test.ts` (new) | 8 |
| `lightweightRegimeClassifier.test.ts` (new) | 8, including the explicit no-look-ahead proof |
| `tradingAgentsShadow.test.ts` (new) | 2 |
| `ReflectionEngine.effectiveWeight.test.ts` (new) | 4 (correlated-does-not-move-weight, independent-can-move-weight-bounded, risk-exit-agent-frozen, rollback-toward-default) |
| `TechnicalAgent.debounce.test.ts` (extended) | +1 (regime emission), and the pre-existing "still-true momentumBreakout" test was strengthened with a real `expect(firstCount).toBe(1)` assertion — see §17 |

All pass individually with `tsc --noEmit` clean (excluding 3 pre-existing errors in untracked `CampaignTracker.ts`/`.test.ts` from an unrelated concurrent session, zero references to anything touched here). Full-suite result recorded in §17.

---

## 17. Runtime verification

Read-only/paper-safe throughout this pass, per the explicit constraint - no Autobot toggle, no order placement, no LIVE arm, no threshold change. Confirmed `PAPER_TRADING_ONLY=true` unchanged. `scripts/prediction_accuracy_status.ts` was run read-only against the real `data/argus.db` and produced a clean, valid report.

**A running Argus process was detected on :3000 during this pass (unrelated to this work — already running before it started).** That process is running pre-existing code and has not applied migration `0044_independent_learning` (migrations run once, at `db/index.ts` import time, which already happened for that process before this migration file existed). **A restart is required for this process to pick up any of this pass's changes** (new columns, effective-N weight gating, regime capture) — this is a normal, expected "restart to pick up code changes" situation, not a live inconsistency (the old code doesn't reference the new columns, so nothing is broken by their absence in that process's view). No restart was performed as part of this work.

**Two real bugs were caught and fixed by this pass's own tests before being shipped, worth stating plainly rather than hiding:**
1. `lightweightRegimeClassifier.ts`'s first draft reused `quantThresholds.volatilityPercentileHigh/Low` (percentile-*rank* thresholds) as if they were raw bandwidth-*percentage* thresholds — a unit mismatch that would have made `HIGH` volatility almost unreachable. Caught by the classifier's own test suite; fixed with dedicated, correctly-scoped thresholds.
2. The same module's first draft sized its "long" SMA reference window at a fixed `minBars`-sized slice near the recent end of the series rather than the full available window, understating a real trend's slope by roughly 5× and misclassifying a clean, steady uptrend as `SIDEWAYS_RANGE`. Caught by the same test suite; fixed by using the full available price history as the long-period reference.
3. While extending `TechnicalAgent.debounce.test.ts`, discovered its shared `SYMBOL` constant (`'DBEND2E'`) failed `looksLikeListedTicker`'s ≤5-letter format check, meaning every idea in that describe block was being silently routed to `TRADE_IDEA_REJECTED` instead of `TRADE_IDEA_GENERATED` — the pre-existing "still-true momentumBreakout" test had been passing vacuously (0 emissions vs 0 emissions) rather than proving debouncing actually works. Fixed the symbol and added an explicit `expect(firstCount).toBe(1)` assertion so this class of bug cannot silently recur.

---

## 18. Schema migrations

`drizzle/0044_independent_learning.sql` — six `ALTER TABLE ADD` statements, all nullable or defaulted (backward-compatible, no data rewrite, no destructive change). Applied and verified via the normal test-suite temp-DB migration path (every test in this pass ran against a freshly-migrated temp database).

---

## 19. Rollback plan

Every change is additive and independently revertible:
- Schema: the six new columns can be ignored by reverting `ReflectionEngine.ts`/`TechnicalAgent.ts` to their pre-this-pass state; dropping them is unnecessary (SQLite tolerates unused nullable columns) but possible via a follow-up migration if desired.
- `ReflectionEngine.evaluateAgents()`: revert to the single prior-pass version (Kronos-only effective sourcing, no bounded adjustment, no risk-exit exclusion) by reverting this one file plus its three new imports.
- `TechnicalAgent.ts` regime capture: revert the `regime` field additions; `agent_predictions.regime` simply stays null going forward.
- `lightweightRegimeClassifier.ts`, `predictionIndependencePolicy.ts`, `tradingAgentsShadow.ts`: delete the files; nothing else depends on them once `ReflectionEngine.ts`/`TechnicalAgent.ts` are reverted.
- New config keys (`maxWeightAdjustmentPerCycle`, `tradingAgentsShadowEnabledEnvVar`, `lightweightRegimeMinBars`, `lightweightVolatilityHighBandWidthPct`/`LowBandWidthPct`) can be left in place harmlessly (unused) or removed alongside their respective code.

---

## 20. Known limitations

- QuantEngine's per-strategy statistical separation is complete in observability (`prediction_accuracy_status.ts`) but **not** in the live `currentWeight` scalar itself (§14) — a structural limitation of `ChiefTraderAgent`'s existing per-agent-only weight model, not addressed by this pass.
- TechnicalAgent's regime capture uses a **lightweight, simplified** classifier (SMA-slope + Bollinger-width), not `RegimeEngine.ts`'s full multi-feature DMI vote — appropriate given the different input shape (plain price array vs OHLC bars), but a real methodological difference worth knowing about when comparing TechnicalAgent's regime-tagged stats against QuantEngine's.
- Phase 7's full "performance by regime, by symbol, by strategy, by time of day" cross-tabulated reporting was not built as a dedicated new report — the underlying data (`agent_predictions.regime`) is now captured and available for such a report, but the report itself remains a follow-up.
- The combined confidence≥0.75 cross-agent population's own autocorrelation (flagged `NOT VERIFIED` in the prior forensic audit) was not separately re-derived this pass.
- No new evidence exists on whether the regime-tagged data reveals genuine regime-dependent edge for any agent — that analysis was explicitly out of scope ("do not optimize for more trades... do not claim profitability or predictive edge").

---

## 21. Items intentionally not implemented

- A full class-per-agent `PredictionIndependencePolicy` plugin architecture (Phase 2's most literal reading) — a small resolver-function module was built instead, per "do not overengineer."
- Any real TradingAgents process integration, Python bridge, or API-key mapping — scaffold types only (§15).
- Any change to `ChiefTraderAgent`'s weight-resolution architecture (would be required for true per-strategy live weight separation, §14) — correctly out of scope as a protected-spine change.
- A dedicated by-regime/by-symbol/by-strategy cross-tabulated performance report (§20) — data capture is in place; the report is a follow-up.

---

## Final rule, restated

**No claim of trading edge, profitability, or confidence in any specific agent's usefulness is made anywhere in this document or the code it describes.** This work makes Argus's live learning loop honest about how much independent evidence it actually has — nothing more, and that is the intended scope.
