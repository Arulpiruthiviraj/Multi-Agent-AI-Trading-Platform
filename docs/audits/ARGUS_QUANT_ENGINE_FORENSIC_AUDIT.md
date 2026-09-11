# ARGUS Quant Engine — Forensic Audit (2026-09-09)

Consolidates Sections 3, 4, 6, 7, 10, 12, 13, 17-21 of the audit brief. Cross-reference the
ownership matrix, wiring audit, strategy inventory, and parity audit docs for the detail those
sections own primarily — this document focuses on the Java Quant Core's internal structure,
zero-signal investigation, and the areas (concurrency, performance, config) not covered elsewhere.

## Complete quant code inventory — where it lives

- `src/server/quant/` — TS strategies (21), indicators (`RSIEngine.ts`, `MACDEngine.ts`,
  `technicalSignal.ts`, `TechnicalIndicators.ts`), `RegimeEngine.ts`, scoring
  (`StrategyScoreNormalizer.ts`), risk (`ExpectedValue.ts`, `LiveStrategyPerformance.ts`).
- `src/server/strategiesEngine/` — the SECOND, isolated research subsystem (own `MarketSnapshot`,
  condition-tree DSL) — per CLAUDE.md, reuses indicator math only, never imports ChiefTrader/
  RiskEngine/OMS, never places or influences a real order. Not re-audited this pass beyond
  confirming CLAUDE.md's own description; no evidence found contradicting it.
- `quant-core-java/src/main/java/io/argus/quantcore/` — `indicators/` (RSI/MACD/Bollinger),
  `strategy/core/` (5 CORE ports), `strategy/institutional/` (2 files:
  `InstitutionalStatArbStrategy.java`, `MultiFactorMomentumStrategy.java` — not deeply audited this
  pass, part of the 123-engine `quantModels` registry), `institutional/models/` (~35+ engines,
  rapidly growing per recent commits — options/FX/commodities/futures/CDO/crypto/technical-catalog),
  `server/` (HTTP layer), `features/` (`FeaturePipeline`, regime/volatility).
- `config/` — `quantThresholds.json`, `quantExperimentalStrategies.json`, `quantForumStrategies.json`,
  `quantStrategyTaxonomy.json`, `smcConfluence.json`, `engineOwnership.json` (the authoritative
  registry this audit leans on heavily), `thesisInvalidation.json`.
- `scripts/` — `java_parity_fixtures.ts`/`_phase1.ts`/`_phase2.ts`, `write_golden_core_parity.ts`,
  `assert_core_vectorbt_parity.ts` (not opened this pass — VectorBT-specific, orthogonal to the
  Java Quant Core question).
- `tests/parity/` — `generate_parity_golden.ts`, `test_strategy_context_parity.ts`,
  `test_strategy_evaluate_parity.ts` (names suggest exactly the StrategyContext-level parity gap
  identified in the parity-audit doc might already have partial tooling started — **not opened this
  pass**, flagged as a follow-up read before assuming the gap is completely untouched).

## Zero-signal investigation (Section 13)

CLAUDE.md's own ground truth: organic closed PAPER FILLED SELL P&L is 0, and this session's earlier
direct DB query (this same conversation) confirmed only 3 real PAPER trades ever (Aug 20-21, 2026),
zero since. This is **not** a quant-engine defect under this audit's own evidentiary standard:

```text
Strategy evaluated: YES (evaluateAll() runs whenever QUANT_ENGINE_ENABLED=true and a symbol has a
                    populated StrategyContext)
Conditions passed:  UNVERIFIED this pass — would require reading quant_assessments table for a
                    recent window and tabulating per-strategy BUY/SELL vs HOLD counts; not done
                    this session (a bounded, mechanical follow-up query, not a code-reading task)
Primary blocker:    Not established from source this pass for the quant strategies specifically.
                    CLAUDE.md's own established finding for the AGENT layer generally (not quant
                    specifically) is that ChiefTrader has approved ~0 ideas because 0/38 agent/
                    confidence-bucket combinations clear real statistical significance — that
                    finding predates this pass and was not re-derived here for the quant strategies
                    in isolation.
```

Marked **UNVERIFIED** rather than asserting a cause — the mission explicitly forbids inventing a
root cause. A real next step (not done this pass): query `quant_assessments` for the last 7-14 days,
group by `strategy_id`, count HOLD vs BUY/SELL, and cross-reference with `QUANT_ENGINE_ENABLED`'s
actual current `.env` value (not confirmed this pass either — a one-line check).

## Java Alpha Engine audit (Section 17) — summary, not per-engine deep-dive

123 `quantModels` entries in `config/engineOwnership.json`: 6 `SHADOW`, 117 `RESEARCH`. See the
ownership matrix for the full breakdown and the 6 SHADOW engines' individual live-consumer detail.
**Not independently verified per-engine this pass**: mathematical correctness of any of the 117
RESEARCH engines (GARCH, HMM, factor models, the entire recent options/FX/commodities catalog).
This would require reading ~50+ Java source files individually — explicitly out of this pass's
effort budget, and, per the mission's own Section 17 instruction, not asserted as "Alpha Engine
complete" — these are independently-existing components, not a connected pipeline. The one
exception (`internalQuantEnsemble.ts` → `QuantEnsembleEngine.java` → independence-count gate) is
real, live, and documented in the wiring audit.

## Strategy correlation / double counting (Section 18)

`ChiefTraderAgent.ts`'s `EvidenceAggregator` and the min-2-independent-agents floor were not
re-audited for correlation-blindness this pass. One relevant, confirmed mechanism:
`internalQuantEnsemble.ts` explicitly exists to prevent exactly this failure mode for the Java
research-strategy family — it runs `QuantEnsembleEngine.java`'s **correlation-adjusted**
`effectiveIndependentCount()` specifically so that multiple correlated Java signals cannot each
count as a full independent vote. Whether the TS-side 21 strategies (or the idea-agent layer
generally) have an equivalent correlation-awareness check was **not verified this pass** —
UNVERIFIED, not assumed either way.

## Concurrency / thread safety (Section 21) — NOT verified this pass

`SymbolState.java`'s `onTick()`/`snapshot()` methods are marked `synchronized` (confirmed by direct
read earlier this session, in the context of the parity root-cause investigation) — this is real
evidence of thread-safety awareness for that one class. No broader review of static mutable fields,
shared caches, or executor configuration across the ~50+ Java files was performed this pass.
`QuantCoreServer.java`'s `setExecutor(Executors.newVirtualThreadPerTaskExecutor())` (confirmed by
direct read) means every request runs on its own virtual thread — a real, modern concurrency
choice, but whether every engine it dispatches to is genuinely stateless was not audited file-by-file.
**UNVERIFIED**, flagged as real remaining work, not silently assumed safe.

## Performance audit (Section 20) — NOT measured this pass

No latency percentiles (p50/p95/p99) were captured for `/api/v1/evaluate`, `/api/v1/indicators/`,
or any `institutional/*` route this session. `QuantCoreBridge`'s own timeout config
(`tradingSafety.quantJavaCoreRequestTimeoutMs`) exists and bounds worst-case latency, but no
measurement was taken to support or refute a performance-motivated migration claim. Per CLAUDE.md
rule 10 ("performance claims require measurement, not assertion") and the mission's own Section 20
instruction, this is recorded as **NOT DONE**, not silently assumed favorable to Java.

## Configuration audit (Section 22) — partial

Confirmed: `config/quantThresholds.json`, `config/quantExperimentalStrategies.json`,
`config/engineOwnership.json` all exist and are internally consistent with what source code does
(spot-checked the 5 CORE strategies + indicators against `engineOwnership.json`'s claims — matched
exactly). **Not checked this pass**: whether any of the 16 experimental strategies' env flags are
currently `true` in the live `.env` (see strategy-inventory doc's own note on this), or whether any
config key is stale/orphaned across the full `config/*.json` set.
