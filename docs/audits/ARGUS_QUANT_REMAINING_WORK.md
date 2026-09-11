# ARGUS Quant Engine — Remaining Work (2026-09-09)

Per the audit's own instruction: only genuine, proven-necessary items. Nothing here was fixed
during the audit; this is a prioritized list, not a changelog.

## P0 — correctness/safety blockers

**None found.** The Java CORE strategies being unwired is not a safety blocker — TypeScript's
versions are the sole production authority and nothing depends on Java's copy. The RSI/MACD
indicator-level divergence is real but confined to a shadow-comparison log event
(`QUANT_CORE_PARITY_DIVERGENCE`) that never reaches a trading decision. No finding in this audit
weakens RiskEngine, ChiefTrader thresholds, OMS, or broker safety controls.

## P1 — architecture / quant-engine work (proven necessary, not yet done)

1. **Root-cause fix for the RSI/MACD/Bollinger indicator parity divergence** — redesign
   `QuantCoreBridge`'s wire protocol so Java compares against the exact array TS holds (full-array
   payload per comparison, or a sequence-numbered/acknowledged tick-delivery scheme) instead of an
   independently-accumulated buffer fed by a best-effort, unacknowledged `POST /api/v1/ticks`. A
   genuine cross-language protocol change — design it deliberately, do not rush it (per this
   codebase's own established discipline against rushing quant-adjacent changes).
2. **Decide the fate of the 5 CORE Java strategy ports.** They are fully implemented, registered,
   and parity-tested against synthetic fixtures, but have zero live callers. Either (a) wire
   `/api/v1/evaluate` into a real shadow-comparison caller (mirroring `compareParity()`'s pattern
   for indicators) to start accumulating real-world divergence evidence before ever considering a
   vote, or (b) explicitly document them as parity-test-only artifacts with no near-term wiring
   plan. Leaving them silently unwired with no stated plan is the actual current gap, not the code
   itself.
3. **Port the feature-computation pipeline (RegimeEngine/trend/volume/priceAction/
   supportResistance/MarketContext) to Java** if full strategy migration is ever actually pursued —
   `StrategyContext.java`'s own header already names this as the real remaining Phase 1.5 work.
   Not started. Do not consider the 5 CORE strategies "fully migrated" until this exists and has
   its own parity tests against real bars, not synthetic fixtures.
4. **`JavaBacktestEngine.java` is a real, tested, but completely unwired third backtest
   implementation.** Either wire it (with a real parity test against the two Node engines before
   trusting its output) or mark it explicitly deprecated/research-only in the registry (it already
   is `RESEARCH`-adjacent in spirit; make it explicit) to prevent someone trusting its output as
   comparable evidence, which the registry itself already warns against.
5. **Concurrency and performance audits (Sections 20-21) have never been done.** Not urgent given
   current unwired status, but a real precondition before any Java engine (CORE strategies or the
   117 RESEARCH engines) is considered for a live vote.

## P2 — research / enhancement (not blockers, not urgent)

1. Wire the ~10 newly-HTTP-exposed research engines (`handleInstitutionalStrategy` dispatch) to a
   real backtest/research consumer beyond the one confirmed live path
   (`internalQuantEnsemble.ts`'s narrow `JAVA_RESEARCH_STRATEGY_IDS` subset) — most of the 117
   RESEARCH engines have no HTTP endpoint or consumer at all.
2. Real backtest/walk-forward/paper evidence for any of the 117 RESEARCH-status engines before
   considering promotion — none has any evidence beyond synthetic unit tests today.
3. `stat_arb`, `correlation_engine`, `quant_ensemble`, `regime_volatility_overlay` each have a
   tested-but-unused TS caller already written (`fetchInstitutionalCorrelation`,
   `fetchInstitutionalEnsemble`, `fetchInstitutionalAdvisory`) — deciding whether/how to actually
   invoke these is a real design decision (which models feed an ensemble, cross-symbol correlation
   needs) explicitly not yet made, per the registry's own notes.
4. Investigate whether `tests/parity/test_strategy_context_parity.ts` /
   `test_strategy_evaluate_parity.ts` (found by filename search, **not opened this pass**) already
   partially address the StrategyContext-parity gap named in P1.3 above — read these before
   assuming zero existing work in that direction.
5. Quantify current RSI/MACD divergence rate freshly (a bounded DB query against
   `observability_events`) rather than relying solely on the earlier-session figure, once/if the P1.1
   fix is designed, to measure before/after impact.

## Explicitly NOT remaining work (already correctly resolved or correctly deferred)

- Paper=TS/Backtest=Java mismatch risk — does not exist; both real backtest paths use the same TS
  strategy source as live.
- ATR TS/Java parity — not a real gap; disclosed as `NOT_A_PARITY_PAIR`, correctly labeled, not a
  silent divergence.
- Full Java strategy correctness line-by-line review of the 5 CORE ports — real, but genuinely
  low-priority while they remain unreachable from any live path (P1.2 resolves the priority
  ordering: decide wiring intent first, then correctness-review only if wiring proceeds).
