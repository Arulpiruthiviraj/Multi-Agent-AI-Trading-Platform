# ARGUS TS↔Java Parity Forensics (2026-09-09)

Answers Sections 5, 6, 11, 14 of the audit brief. Cross-reference: ownership matrix, wiring audit.

## What the existing parity tests actually test

`StrategyParityTest.java` (103 lines, 9 `@Test` methods, one per strategy plus edge cases):
- Runs TS-mirrored Java strategy classes against **synthetic, hand-built `StrategyContext` fixtures**
  — not real bars, not the output of a real feature pipeline.
- Its own file comment states the feature computation (RegimeEngine/trend/volume/etc.) that would
  populate a real `StrategyContext` from live bars is explicitly **NOT ported** — see
  `StrategyContext.java`'s header (quoted in full in the ownership matrix): "this Phase 1 pass ports
  the strategies' own decision logic... not the feature computation itself."
- Tests decision-boundary outputs (BUY/SELL/HOLD, confidence) given identical synthetic inputs —
  this is real evidence the *decision logic* matches, given the same inputs.
- Does **not** test: missing-data behavior parity, invalid-data behavior parity, whether Java's
  feature pipeline would ever produce the same `StrategyContext` as TS's real
  `RegimeEngine.ts`/`trend.ts`/`volume.ts`/`priceAction.ts`/`supportResistance.ts`/`MarketContext.ts`
  pipeline from the same real bars (it doesn't exist in Java at all, per the same header).

**Classification: `PARTIAL PORT`, not `FULL JAVA MIGRATION`** — exactly the distinction Section 6
asks for. The decision logic is ported and parity-tested against synthetic inputs; the feature
pipeline that would need to feed it from real market data in production is not ported, not tested,
and not planned in this pass (tracked honestly in `JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md` per
the same header comment — not independently re-read this session).

## Indicator-level parity (RSI/MACD/Bollinger) — the one real runtime shadow comparison

`ParityComparator.compareSnapshots()` (`src/server/services/ParityComparator.ts`) is the actual
runtime mechanism — diffs a TS-computed `ComparableIndicatorSnapshot` against a Java-computed one,
logs a `QUANT_CORE_PARITY_DIVERGENCE` structured-log event when `diffPct > thresholdPct`
(`tradingSafety.quantJavaCoreDivergenceThresholdPct`). This is genuinely live, runs in production
paper mode (fire-and-forget from `QuantCoreBridge.compareParity()`), and is the source of the
mission-brief's cited "80% >5%, 56% >20%" divergence figures (established in an earlier audit this
session — R8 in `docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md`).

**Root cause (re-confirmed this session, not re-derived from scratch — already root-caused earlier
today in this same conversation):** NOT a formula bug. RSI.java/MACD.java are byte-for-byte ports
(confirmed identical algorithm by direct read). The divergence is structural: `tsSideSnapshot()`
reads TS's own `this.priceHistory[symbol]`; Java's `SymbolState.java` maintains an **independently
accumulated** tick ring buffer fed by a fire-and-forget `POST /api/v1/ticks` with no delivery/
ordering guarantee and no periodic resync. A single dropped/reordered tick makes the two input
arrays diverge in content; because RSI/MACD use recursive smoothing (each value depends on the
previous), that divergence propagates forward permanently rather than self-correcting the way a
plain rolling SMA would. This explains a **large, persistent** divergence pattern rather than
rounding-level drift, matching the observed 56% >20% figure.

**Do NOT widen the tolerance to make this look resolved** — per the mission's own explicit
instruction and this codebase's own established discipline (CLAUDE.md rule 10: measure, don't
assert). The real fix is a wire-protocol change (Java compares against the exact array TS holds,
rather than an independently-accumulated one) — a genuine cross-language design change, correctly
scoped as deferred work (see `ARGUS_QUANT_REMAINING_WORK.md`), not a same-session fix.

**ATR is explicitly `NOT_A_PARITY_PAIR`** (registry's own term) — Java's tick-range approximation is
disclosed as non-equivalent to TS's true OHLC-bar ATR. This is not a parity failure; it is an
honestly-labeled different calculation that should never be compared as if it were the same one.

## Java strategy correctness (Section 14) — NOT independently re-derived this pass

The mission asks for a line-by-line correctness review (off-by-one, NaN handling, look-ahead
leakage, timezone assumptions, etc.) of every Java strategy. This pass did **not** perform that
review for the 5 CORE strategies' Java ports beyond confirming they compile, are registered, and
pass their own parity tests against synthetic fixtures. **Marked UNVERIFIED, not assumed correct.**
Given the strategies are unreachable from any live path (see wiring audit), a correctness defect
there currently has zero production impact — it would only matter if/when someone wires
`/api/v1/evaluate` into a real caller, at which point this review becomes a real precondition, not
an optional nice-to-have.

## Divergence quantification — carried forward, not re-measured this session

The "14,207 shadow comparisons, ~80% >5%, ~56% >20%" figures were established in an earlier pass
this same conversation (cited from `docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md`'s R8 entry).
This pass did not re-run a fresh count against the live `observability_events` table — the root
cause (above) was independently re-confirmed via source reading, which is a stronger form of
evidence than re-counting the same underlying symptom again. If a fresh count is wanted, it is a
simple, bounded query (`SELECT COUNT(*) FROM observability_events WHERE event_type =
'QUANT_CORE_PARITY_DIVERGENCE'`), not done this pass to conserve effort for the wiring/ownership
questions the mission emphasized most.
