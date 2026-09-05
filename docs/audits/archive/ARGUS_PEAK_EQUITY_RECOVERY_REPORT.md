# ARGUS — Peak Equity Recovery & Risk State Integrity Report

**Date:** 2026-08-26. **Scope:** repair of a real, currently-active RiskEngine data-corruption defect found during the 2026-08-25 pre-market forensic audit. All 24 risk gates, all safety thresholds, replay isolation, and existing trading behavior are unchanged.

## 1. Root cause

`RiskEngine.ts`'s `portfolio_drawdown` gate (#10) is the only gate whose live comparison baseline (`settings.peakEquity`) is a persisted, ratchets-only-up value read from a shared database row rather than recomputed fresh each evaluation. Before a 2026-08-24 fix (documented in the gate's own code comment), this was also the *only* gate with no replay-isolation branch — it unconditionally read **and wrote** the shared live `settings.peakEquity` row regardless of whether `equityNow` came from the real broker or an isolated replay/backtest equity curve. That fix stops **new** contamination; it does not repair a value already poisoned by a pre-fix run.

## 2. Exact source of the $1,000,000 contamination

**Not fully recoverable, and reported as such rather than guessed.** No `settings`-change-history table exists, so there is no ledger of every historical write to `peakEquity` — only its current value. I exhaustively checked both real historical-run ledgers retained in the live database:

- `replay_runs` (38 rows, the modern isolated MODE B replay system) — no run configured with `initialCapital` anywhere near 1,000,000; all show realistic ~$100k starting/ending capital in properly isolated `HISTORICAL_REPLAY` environment rows.
- `quant_strategy_backtests` — only two distinct `initial_cash` values exist (`100000`, `2000`); no `1000000` row.

Neither table contains a matching signature. The exact originating event therefore predates or falls outside both currently-retained ledgers — most plausibly a pre-2026-08-24 replay/backtest run (a common round-number starting capital used elsewhere in this codebase's own test fixtures, e.g. `phase18.fullReplay.test.ts`'s `initialCash: 1_000_000`) that, before the isolation fix, wrote its equity into the shared live row via the documented bug. This is the class of defect proven by the code's own comment; the specific run cannot be named from currently retained data.

## 3. Evidence used to determine the correct recovery value

Phase 1's decision tree (recover historical peak vs. safe-initialize vs. stop-and-report) resolved to **safe initialization**, because:

- No `settings`-change-history exists, so option A (recover a real historical high-water mark) is not possible — there is nothing to recover from.
- The real, authoritative broker (Alpaca PAPER) reports current equity directly; this is the only trustworthy live number available, matching the explicit instruction to use "the real broker paper account as the authoritative source."
- Cross-checked against organic trading history: only a handful of real `PAPER`/`FILLED` trades exist all-time (well under `researchSafety.minPaperTrades`, 30) — nowhere near enough real closed trades to have organically grown the account from ~$100k to $1,000,000. This rules out "the peak really was $1M once" as a plausible alternative.

## 4. Old value / New value / Recovery type

| | |
|---|---|
| Old value | `1,000,000` |
| New value | `100,046.80` (the real Alpaca PAPER equity read at the moment of repair) |
| Type | **Safe initialization baseline**, not a recovered historical peak (none exists to recover) |

The new value is **not hardcoded** anywhere in source — it is read live from the broker at repair time via the exact same `broker.portfolio()` call `RiskEngine.ts` already uses, so a real account with a different current equity gets correctly re-baselined to *its own* real number, not a snapshot value.

## 5. Files changed

- **New:** `src/server/engines/PeakEquityIntegrity.ts` — the repair mechanism (see §6).
- **New:** `src/server/engines/PeakEquityIntegrity.test.ts` — 7 tests.
- **New:** `src/server/routes/v2System.strategyBacktestDetail.timeoutGuard.test.ts` — 4 tests (Phase 6).
- **Edited:** `src/server/core/ArgusCoreBoot.ts` — wires the one-shot boot-time integrity check right after `BrokerManager.initialize()`.
- **Edited:** `src/server/config/tradingSafety.ts` / `config/tradingSafety.json` — added `peakEquityMaxPlausibleMultiplier` (5), config-driven, not hardcoded in TS.
- **Edited:** `src/server/routes/v2System.ts` — fixed the real `ERR_HTTP_HEADERS_SENT` defect in `GET /api/v2/quant/strategy-backtests/:id` (§9).
- **Not changed:** `RiskEngine.ts`'s gate logic itself, `EvidenceAggregator.ts`, `ChiefTraderAgent.ts`, OMS, BrokerManager, `consensusApprovalThreshold`, `minIndependentAgreeingAgents`, `disagreementPenalty`, `PAPER_TRADING_ONLY`, `LIVE_NO_GO`.

## 6. The repair mechanism (Phase 3)

A boot-time, idempotent integrity check (`reconcilePeakEquityIntegrity()`), not an undocumented one-time database edit. Runs once per restart, after the broker is ready, before trading begins. Three-way outcome, always audited:

- **CLEAN** (default, every normal restart): `storedPeak <= currentEquity × peakEquityMaxPlausibleMultiplier` → untouched. This is what correctly preserves a *legitimate* high-water mark — e.g. a real account that went `100k → 120k → 115k` keeps `peakEquity = 120k` forever, exactly as required, because `115k × 5 = 575k`, far above `120k`.
- **SUSPICIOUS_BUT_PLAUSIBLE**: the multiplier is exceeded, but real organic `PAPER`/`FILLED` trade count is ≥ `researchSafety.minPaperTrades` — real trading history could plausibly explain the growth. **Never auto-repaired** — only logged (`PEAK_EQUITY_INTEGRITY_SUSPICIOUS`), per Phase 2's "stop and report rather than guess."
- **CONTAMINATED_AND_REPAIRED**: both the multiplier is exceeded *and* organic trade count is too small to explain it. Re-baselines to current real broker equity and writes a full audit row to the existing `config_change_events` table (`setting: 'peakEquity'`, `oldEffective`, `newValue`, `source: 'PeakEquityIntegrity.reconcilePeakEquityIntegrity'`, `operator: 'system-auto-repair'`) — reusing the existing settings-audit table rather than inventing a new one.

## 7. Database changes

One row updated (`settings.peak_equity`: `1000000` → `100046.8`), one row inserted (`config_change_events`, full audit trail, shown live below). No schema changes, no new tables.

## 8. Tests added / Test results

- `PeakEquityIntegrity.test.ts` — 7 tests: CLEAN (no stored peak), CLEAN (legitimate `120k→115k` growth preserved), the exact real-world contaminated scenario (repaired), SUSPICIOUS_BUT_PLAUSIBLE (never auto-repaired), SKIPPED_INVALID_EQUITY, idempotency (a second run is a no-op), consensus thresholds unchanged.
- `v2System.strategyBacktestDetail.timeoutGuard.test.ts` — 4 tests (§9).
- Existing `RiskEngine.test.ts` replay/live isolation suite (5 tests, "2026-08-24 fix") re-verified green — already-existing regression coverage for Phase 4, reused rather than duplicated.
- **Full suite: 366 files / 2420 tests passing.** `tsc --noEmit` clean. Build (`vite build` + `esbuild`) succeeds.

## 9. ERR_HTTP_HEADERS_SENT — root cause and fix

`GET /api/v2/market/sentiment-trend` (crash.log line ~940) was **already fixed** earlier the same day (2026-08-25) — its own code comment documents the identical root cause and fix, confirmed still in place.

`GET /api/v2/quant/strategy-backtests/:id` (crash.log line ~1593) was **not yet fixed** — same root cause: an unbounded `backtestEngine.getStrategyRun()` call could run past `server.ts`'s global per-request timeout backstop, which sends its own response first; the handler's late resolution then tried to send a second one (404 or 200), throwing `ERR_HTTP_HEADERS_SENT`. **Fixed**: wrapped the call in the same `withTimeout()` helper already used elsewhere (5s bound), and guarded every `res.*` call in the handler (404, success, and the catch's 500) with `if (!res.headersSent)`. 4 regression tests added, all passing, including confirming the success and not-found paths still return exactly one response each.

## 10. Regression prevention

Both the peak-equity repair and the double-response fix are covered by deterministic, fast (no real 15s waits) unit/integration tests that will fail if either regresses. `RiskEngine.test.ts`'s existing 5-test replay-isolation suite continues to prove new contamination cannot recur.

## 11. GLD SELL — no longer falsely blocked

Confirmed live, post-repair: `settings.peak_equity = 100,046.80`, current real broker equity ≈ `$100,046.80` at that instant → recomputed `drawdownPct ≈ 0%`, far under the 15% limit. The `portfolio_drawdown` gate will now correctly pass for any equity within 15% of its current real value. The GLD position remains open and correctly reconciled (`quantity 1, avg $387.97, current $424.28, unrealized +$36.31`, broker/Argus reconciliation matched, 0 mismatches) — the next legitimate exit attempt (EOD-flatten or otherwise) is no longer structurally blocked by corrupted state. No trade was forced or manufactured to prove this; the verification is the repaired stored value plus the gate's own unchanged arithmetic.

## 12. Phase 5 — fail-safe exit behavior (investigated, not changed)

Traced the architecture rather than guessing: gates #15 (`order_notional_cap`), #22 (`sell_position_exists`), and #23 (`argus_capital_allocation`) are **explicitly, documentedly** side-aware — they already skip or behave differently for SELL because their stated purpose is limiting *new capital deployment*, not position reduction. Gate #10 (`portfolio_drawdown`) has **no such documented side-carve-out** anywhere in code or CLAUDE.md; its own rejection message says "All new trades blocked," with no exit exception ever designed in. Per the explicit instruction to preserve existing architecture absent a *documented* defect: **I did not add a new SELL-bypass to gate #10.** The actual defect was the corrupted *data* (§1–§6), not the gate's design — fixing the data resolves the concrete "trapped position" scenario without weakening the circuit breaker for anyone relying on its current, side-blind behavior. Whether gate #10 *should* someday gain an explicit exit carve-out (matching 15/22/23's pattern) is a real, separate architecture question worth its own deliberate discussion — flagged as a **SHOULD MONITOR**, not implemented here.

## 13. Remaining risks

- The exact originating contamination event could not be named (§2) — if it recurs from a *different* pre-existing bug not covered by the 2026-08-24 replay-isolation fix, this repair mechanism will catch it again on the next restart (self-healing), but the underlying "how" would still warrant investigation.
- `SUSPICIOUS_BUT_PLAUSIBLE` cases are deliberately never auto-repaired — a real account that legitimately grows past the 5x multiplier with real trading history will need an operator's manual judgment call, by design.
- Gate #10's exit-carve-out question (§12) remains open, not urgent.

## Final classification

**GREEN — PAPER TRADING READY** (for this specific defect). Verified against the actual runtime `portfolio_drawdown` calculation using the real, repaired broker-authoritative equity — not asserted from tests alone. All 24 gates, all thresholds, replay isolation, and `PAPER_TRADING_ONLY`/`LIVE_NO_GO` confirmed unchanged; full regression suite green; engine restarted and running (PID 19532) with the repair confirmed live in the database.
