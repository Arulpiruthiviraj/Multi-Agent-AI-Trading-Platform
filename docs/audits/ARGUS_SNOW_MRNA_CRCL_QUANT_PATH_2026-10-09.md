# SNOW / MRNA / CRCL Quant path — October 9, 2026

Read-only focused follow-up to ARGUS_ZERO_FILL_MISSED_OPPORTUNITY_FORENSIC_2026-10-09.md. Additional persisted evidence ends at 2026-10-09T16:27:27.743Z (12:27:27 ET), not market close. The active engine, its environment, broker and database were not changed. Code is staged only in codex/argus-session-repair-20261009.

## Lifecycle certification: verified empty authority, no automatic promotion

The runtime-authoritative `learning_versions` strategyEligibility namespace contains one record: PULLBACK_CONTINUATION, RETIRED, 2026-08-31T21:42:38.558Z, sample size 22, with the original negative-evidence hypothesis. No VALIDATED/CHAMPION runtime transition exists. This independently supports the earlier readiness result of 20 missing records and one ineligible strategy.

Source review found no production caller granting VALIDATED/CHAMPION through recordStrategyLifecycleTransition. Tests and the isolated synthetic soak explicitly seed fixtures; they are not organic promotion. The production research promotionEngine derives its own evidence-gated status, but its ladder is explicitly research-side, separate from execution authority. StrategyRecertification only reviews RETIRED/DEGRADED cases and never changes status. No missing strategy is covered by that quarantined-only review.

Therefore: authorization lookup works under the tests; an organic certification-to-runtime authorization workflow has NOT been demonstrated. This is not a reason to auto-create UNTESTED baselines or promote strategies. Even UNTESTED would change currently terminal missing-state routing into consensus, so no baseline was silently inserted. A real promotion needs reviewed, scoped evidence and the existing runtime decision recorder, not a status copied from research or synthetic tests. No certified positive organic evidence was established in this follow-up.

## SNOW: the first recorded boundary precedes authorization

At 10:26:42 ET, production assessment outputs include MA_CROSSOVER BUY confidence 1.0, setupScore 100, triggerMet=true. The same assessment contains a relative-strength BUY, but a persisted DESK_NO_TRADE with the identical assessment trace reports NO_ELIGIBLE_STRATEGY. Subsequent SNOW assessments at 11:08:44, 11:44:05 and 12:27:09 also report NO_ELIGIBLE_STRATEGY. No sampled SNOW Quant authorization or policy-selection record was found by 12:27:27 ET.

A regression replays the saved production evaluation outputs through the real configured adaptive selection function and bestStrategyIdea. Under the configured default ADAPTIVE_MULTI_STRATEGY and recorded BULLISH_TREND / LOW volatility, the preferred pool contains MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION and TREND_FOLLOWING. MA_CROSSOVER and relative-strength are excluded. The surviving three evaluations have triggerMet=false; bestStrategyIdea returns null. PULLBACK also remains retired, which cannot create an eligible idea.

This is a verified reproduction of configured selection semantics, consistent with the trace-matched production abstention. Historical focusId and exact full input context were not persisted, so this is NOT independent feature recomputation or absolute proof of the historical focus setting. The new selection-pool telemetry closes that specific future attribution gap. Changing membership to buy SNOW would be a strategy-policy change, not a demonstrated bug repair, and was not done.

## MRNA / CRCL: coverage gap with scheduler and data evidence

No MRNA or CRCL Quant assessment was found in the focused window through 12:27:27 ET. At that cutoff, MRNA's cached daily inventory contained 223 bars, latest timestamp 2026-08-31T00:00:00Z; cached minute bars ended October 7. CRCL had no cached bars in any timeframe. These are current cache observations, not exact historical provider responses. MRNA's stale daily endpoint and CRCL's absent inventory establish data limitations; neither proves a scheduler attempt failed at a specific earlier instant.

The persisted QUANT_CYCLE_COMPLETED at 12:16:36.152 ET reports duration 1,026,530ms (17m 6.53s), concurrency=1. Attempted/completed symbols were SPY, QQQ, NVDA, AMD, AAPL, MSFT, META, GLD, TSLA and IWM; notAttemptedSymbols was empty. Source snapshots active symbols once at cycle start and evaluates sequentially at that concurrency. New subscriptions arriving afterward are not added to that already-running cycle. Timer overlap is correctly coalesced by singleFlightGuard.

Thus a slow boot cycle can defer later admissions even though it reports all snapshotted symbols completed. That is a demonstrated scheduling property and operational delay, not proof that MRNA/CRCL were deliberately starved or that provider backoff caused the 17 minutes. Historical per-symbol latency/provider-stage timing was not recorded. No provider pacing, concurrency, single-flight behavior, priorities or broker cap was changed speculatively.

## Isolated diagnostic repairs implemented

- Cycle start records expose the scheduled universe and resume cursor before the cycle can stall.
- Per-symbol start/finish records expose duration and ASSESSED / NO_ASSESSMENT / ERROR, including failures and null results under the same cycle ID.
- Bar-input records retain requested window, timeframe, real bar count, first/last timestamps and sufficient/insufficient-count outcome, with an assessment trace. Sufficient count is explicitly not a freshness certificate.
- Selection-pool records retain focusId and the evaluated, focused, adapted and lifecycle-filtered strategy IDs under the same assessment trace. No scoring/selection math changes.
- Optional bounded context evidence captures the actual StrategyContext, raw daily/intraday bars and the exact numeric liveQuotePriceUsed through existing observability infrastructure. It uses redaction before base64, a SHA-256 manifest, ordered chunks and a size refusal. Missing/reordered/modified chunks fail reconstruction. It is OFF by default; enabled overhead and runtime soak are not verified.

Capture is CONTEXT_REPLAY_ONLY. It does not preserve upstream benchmark bars, original provider availability times, or a complete versioned configuration/build manifest. quoteAfterContext is a later diagnostic observation. A reconstructed context supports replaying a strategy calculation against those recorded features; it does not certify that feature derivation was causal or independently correct. Exact historical replay of today's full pipeline remains unverified.

All instrumentation is diagnostic and fail-open. Capture factories do not read diagnostic quotes while disabled; enabled factory/logger failures cannot interrupt trading. No Java calculation, confidence/independence threshold, lifecycle decision, AI route, RiskEngine, sizing, OMS, broker or execution behavior was modified.

## What remains

1. Review real research/prediction/backtest evidence for each missing lifecycle and define an operator-reviewed certification decision; do not manufacture organic evidence. No new authority was granted.
2. After deployment of diagnostics at an authorized maintenance window, reconstruct each late-admitted symbol's actual attempt, input availability, provider stage and eviction history. The current code has not been deployed or restarted by this mission.
3. Complete upstream benchmark/build/config/provider-time provenance before claiming independent PIT indicator recomputation or full counterfactual replay. The new optional context capture is a limited first step.
4. Validate enabled-capture resource overhead and queue-loss behavior in isolation before activation. Full-suite and organic runtime verification remain required before broader readiness claims.

The original zero-order diagnosis remains unchanged for the original window. These changes improve diagnosis; they do not establish profitable alpha, certify strategies or guarantee tomorrow's entries.

## Validation and deployment status

Final targeted/related validation: 16 files, 145 tests passed (11 files/120 Quant-selection, authorization, policy, scheduling and architecture tests; 5 files/25 observability/config/queue tests). Typecheck passed and production build passed in the isolated worktree. Full npm test was not run in this batch. Neither deployment nor enabled-capture runtime/resource verification was performed. These counts prove the exercised behavior only, not organic trading edge or complete defect closure.
