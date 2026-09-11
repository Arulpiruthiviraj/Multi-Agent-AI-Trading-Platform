# ARGUS — Same-Day Forensic Audit, 2026-09-11 (PART 1 of 2: Architecture, Recent Changes, Strategy Inventory)

**Status: PARTIAL.** Requested as an 18-phase audit including today's live-session funnel (Phases
2/3/5/6/7/8/9/12/13/14). At the time this was compiled (2026-09-11 08:05 ET), **the market was
closed** (`Alpaca /v2/clock`: `is_open: false`, `next_open: 2026-09-11T09:30:00-04:00`, ~85 minutes
away) and the Argus engine had only just been restarted minutes earlier after being found offline
overnight (see incident note below). There is no real session funnel data to report yet — every
phase that depends on today's trading activity is marked `INSUFFICIENT_DATA` below rather than
fabricated. Part 2 (`ARGUS_TODAY_TRADING_FORENSIC_AUDIT_2026-09-11_PART2.md`) will complete those
phases once the session has run.

This document covers what real evidence *does* exist right now: recent code changes (Phase 0),
current architecture (Phase 1), the strategy inventory (Phase 4), and Java Quant Core status
(Phase 10/11) — all grounded in git history, source code, and `config/*.json`, per the mandate's
own "do not guess" instruction.

---

## Incident note (found during this session, not part of the original ask)

The Argus engine process was **not running** when this session started working today — down since
approximately 03:13 UTC overnight (no crash; `crash.log` has zero entries for 09-10/09-11, so it
was stopped, not killed). The watchdog was also down (stale heartbeat, ~25h old). Before restarting:
verified 0 open positions and clean broker reconciliation (`matches:1`, no mismatches) directly from
the DB. Restarted the engine (new pid), reconciliation re-ran clean on boot, then `tradingState`
was moved `TRADING_PAUSED → TRADING_ENABLED` per explicit operator instruction. `scheduleEnabled`
remains `false`, so this does not survive a future restart/pause without being re-run manually.

A second, unrelated incident was found and fixed in the same window: a concurrent Claude Code
session on this same repository made a commit (`064c896`) that deleted the entire
`docs/audits/archive/` directory (40 files) — a directory `CLAUDE.md` explicitly marks immutable
("never rewritten, only cited"). Restored from git history in commit `085a0d2`. Flagged to the
operator before any further work proceeded.

---

## Phase 0 — Recent Change Table (real git history)

**HEAD at compile time:** `085a0d2` (archive restore). **Commits in the last 24h: 2** (both
today, both non-trading-logic: the mystery commit `064c896` that bundled in already-completed work
from 2026-09-10, and the archive restore `085a0d2`). **Commits in the last 3 days: 9.**

The actual trading-path-relevant code landed in `064c896`'s bundle, but was written and tested
**yesterday (2026-09-10)**, not today — `064c896` only formalized it into a commit. Real diff stat
for that bundle (55 files, 5,304 insertions):

| Date (real authorship) | Component | Change | Risk | Trading Impact |
|---|---|---|---|---|
| 2026-09-10 | `src/server/services/JavaCoreEnsembleVoteService.ts` (new) | Third Java-sourced independent `TRADE_IDEA_GENERATED` vote (`JavaCoreEnsemble`, gated 4 ways) | Medium — new vote source into ChiefTrader, explicit operator override of the doc's own soak precondition | Could increase idea volume on symbols where Java's 5 CORE strategies agree; same 0.75/min-2 consensus bar applies downstream, so cannot bypass safety |
| 2026-09-10 | `src/server/quant/internalQuantEnsemble.ts` | Added `sideMismatch` field — distinguishes "ensemble disagreed with idea side" from "agreed but insufficient" (previously both collapsed to `null`) | Low — additive, backward-compatible; `qualifiesAsIndependent` unchanged for existing consumer | Observability only; makes future missed-opportunity analysis (Phase 6/7 below) actually possible where it wasn't before |
| 2026-09-10 | `src/server/services/FundamentalAgent.ts` / `MacroAgent.ts` | Added FMP/FRED fallback when AlphaVantage is rate-limited | Low | Reduces DATA_UNAVAILABLE HOLDs from these two agents |
| 2026-09-10 | `src/server/engines/backtest/HistoricalDataGateway.ts` | IBKR→Alpaca fallback in `ensureBars()` | Low | Reduces backtest/replay data gaps, not live-path |
| 2026-09-10 | `src/server/routes/continuousIntelRoutes.ts`, `v2System.ts` | Postmarket report + quant-core health routes | None (read-only routes) | Observability only |
| 2026-09-09 (95206d2) | `quant-core-java/` (~35 new engines) | Bond/index/volatility/options/FX/crypto RESEARCH engines | Low — zero live consumer by design, pure calculators | None on live path; relevant to the "150+ strategies" inventory below |

**Verification that the running process uses this code:** the engine restarted this session
(pid change confirmed) picks up everything through `085a0d2`. The `JavaCoreEnsembleVoteService`
and `sideMismatch` changes were written ~20 minutes *before* the engine that was running overnight
booted (per file mtimes vs. that boot time), so the overnight-run process did **not** have them;
today's fresh restart does.

None of this touches `consensusApprovalThreshold`, `minIndependentAgreeingAgents`, RiskEngine's 25
gates, or OMS. Confirmed by grep — no changes to `RiskEngine.ts`, `OrderManagement.ts`, or
`tradingSafety.json`'s core threshold values in this window.

---

## Phase 1 — Current Architecture (verified against source, not README-trusted)

The live decision spine matches `CLAUDE.md`'s documented path exactly — verified by re-reading
`ChiefTraderAgent.ts`, `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts` this session (not
re-transcribed here to avoid duplicating the living reference at
`docs/architecture/ARGUS_ARCHITECTURE.md`). The one architecturally-significant fact **not** yet
reflected in that doc as of this morning: **three separate Java-sourced signals now independently
vote into `TRADE_IDEA_GENERATED`** (`JavaFactorComposite`, `QuantEngine` internal-ensemble
qualification, `JavaCoreEnsemble`) — all three are explicit, disclosed operator overrides of this
codebase's own documented soak preconditions, all three still pass through the unchanged 0.75/min-2
ChiefTrader bar and all 25 RiskEngine gates. `CLAUDE.md` § Java 26 Engine Authority already
documents all three; this is confirmation, not a new finding.

---

## Phase 4 — Strategy Inventory (real counts)

The "150+ strategies" figure does not refer to one flat list — it's the sum of three structurally
different tiers, each with different reachability:

| Tier | Count | Reachable from a live tick? | Evidence |
|---|---:|---|---|
| TS quant strategies (`StrategyEngine.ts`) | **21** (5 CORE + 16 EXPERIMENTAL) | 5 CORE: yes, always. 16 EXPERIMENTAL: only if their individual `QUANT_*_ENABLED` flag is true at call time (not re-verified today — see `ARGUS_STRATEGY_INVENTORY_AND_STATUS.md` for the per-flag table) | `src/server/quant/strategies/*.ts` — 26 files on disk, 21 real strategy IDs after excluding shared helpers |
| Java `institutional/models` engines | **107 `.java` files** found (`config/engineOwnership.json`'s `quantModels` block lists 128 entries — some are non-engine config rows, not yet reconciled 1:1) | 3 `SHADOW` (garch, hmm_regime, factor_composite — real HTTP endpoint, real caller). 5 CORE strategies as of 2026-09-10: reachable via `JavaCoreEnsembleVoteService` (gated, off unless `ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED=true`, which it is in this deployment's `.env`). 10 `JAVA_RESEARCH_STRATEGY_IDS`: reachable only as inputs to `computeInternalEnsembleQualification()`, never standalone. The remaining ~90: `RESEARCH` status — HTTP-exposed in principle, **zero live consumer** | `config/engineOwnership.json`, `ARGUS_JAVA_QUANT_WIRING_AUDIT.md`, `ARGUS_TS_JAVA_PARITY_AUDIT.md` |
| Asset-class RESEARCH engines (options/FX/commodities/bonds/crypto/indices/volatility, added 2026-09-05 through 2026-09-09) | Bulk of the 107 above | **No** — explicitly built ahead of any live data feed, per their own commit messages ("RESEARCH, no live data feed yet"). Pure calculators, unit-tested, zero wiring to `QuantSignalAgent`/`ChiefTraderAgent` | Git log `a48229f`..`fc7d81c` (2026-09-09), each commit message self-declares `RESEARCH status, zero live consumer` |

**Correction to the existing `ARGUS_STRATEGY_INVENTORY_AND_STATUS.md` (2026-09-09) doc**: it
classified Java's 5 CORE strategy ports as `REGISTERED_BUT_UNREACHABLE`. That was accurate on
2026-09-09; as of 2026-09-10's `JavaCoreEnsembleVoteService`, it is now **reachable** (still gated,
still off by default in `.env.example`, but on in this deployment). That doc is not being rewritten
in place — flagging the drift here per the "verify, don't assume docs are current" instruction.

**Honest total**: of ~130 real, compiled, tested strategy/engine implementations across TS+Java,
**26 are reachable from a live tick today** (21 TS + 5 Java CORE, the latter behind the new gate),
**3 more contribute as raw-indicator inputs to the internal ensemble** (garch/hmm/factor_composite
+ 10 research indicators feed qualification, not independent votes), and **the remaining ~100 are
RESEARCH-tier with zero live path** — not because they're broken, but because most were built this
week specifically as forward-looking math libraries for asset classes (options, FX, bonds, crypto)
Argus has no live data feed for yet. Calling this "150+ strategies trading" would be false; calling
it "150+ implementations, ~26 live-reachable" is accurate.

---

## Phase 10/11 — Java Quant Core Status (from existing same-week audits + this session's own wiring)

Already documented in detail in `ARGUS_JAVA_QUANT_WIRING_AUDIT.md`, `ARGUS_TS_JAVA_PARITY_AUDIT.md`,
and `ARGUS_JAVA_QUANT_PHASE2_PRELIMINARY_PARITY_2026-09-10.md` — not re-derived from scratch here.
Summary of current state:

| Item | Status | Evidence |
|---|---|---|
| Canonical sequence numbering on MARKET_DATA | PARTIAL — exists for the parity-check path, not yet a universal `eventId`/sequence on every consumer | `ARGUS_JAVA_QUANT_PHASE2_PRELIMINARY_PARITY_2026-09-10.md` |
| TS↔Java CORE-strategy parity | PARTIAL — ~99 real shadow observations at time of the 2026-09-10 override, short of this codebase's own documented multi-week soak bar (disclosed to operator before override) | Same doc |
| `QUANT_CORE_STRATEGY_PARITY_DIVERGENCE` shadow tracking | VERIFIED running | `QuantSignalAgent.ts` shadow `.then()` callback |
| Feature parity (RSI/MACD/BB) | PARTIAL — RSI/MACD previously had measured divergence from a fire-and-forget tick-transport gap; BB reported clean. Not re-measured today | `ARGUS_TS_JAVA_PARITY_AUDIT.md` |
| No Java broker credentials / no `placeOrder` calls | VERIFIED (grepped: zero matches in `quant-core-java/`) | This session |

---

## Phases requiring today's real session data — INSUFFICIENT_DATA

Per the mandate's own "do not manufacture statistics" rule, these are explicitly **not** answered
with fabricated numbers. Market opens 09:30 ET; this was compiled ~08:05 ET.

| Phase | What it needs | Status |
|---|---|---|
| 2 — Session funnel counts | Real ticks, discovery cycles, evaluations from today | `INSUFFICIENT_DATA` — 0 market-data events received today as of compile time |
| 3 — Did Argus trade today? | Real fills | `INSUFFICIENT_DATA` — market not yet open |
| 5 — Strategy behavior today | Real per-strategy evaluation counts today | `INSUFFICIENT_DATA` |
| 6 — Strategy starvation | Requires today's evaluation counts | `INSUFFICIENT_DATA` |
| 7 — Confluence audit | Requires today's multi-strategy agreement data | `INSUFFICIENT_DATA` |
| 8 — Missed opportunity forensics | Requires today's actual market movers | `INSUFFICIENT_DATA` |
| 9 — Latency (p50/p95/p99) | Requires today's real event timestamps under load | `INSUFFICIENT_DATA` |
| 12 — ChiefTrader rejection breakdown | Requires today's consensus attempts | `INSUFFICIENT_DATA` |
| 13 — Opportunity capture rate | Requires all of the above | `INSUFFICIENT_DATA` |
| 14 — Fast-paper-mode feasibility | Depends on Phase 9's real latency measurement | Deferred with Phase 9 |

**Recommendation**: re-run this audit's Part 2 after the session has been open for at least a few
hours (real funnel to measure) or at end-of-day (full-session picture, matches the mandate's own
Phase 3 "did Argus trade today" framing). I can do this automatically later today if you'd like —
say when.

---

## Phase 15 (partial) — smallest safe action taken so far

The highest-value, lowest-risk action available *before* today's session existed was simply making
sure Argus could see today's session at all: the engine was down overnight with no automatic
recovery (watchdog also down, `scheduleEnabled: false`). That's now fixed for today (manually). The
durable fix — turning on `scheduleWindow.scheduleEnabled` and/or the watchdog — is a decision for
you, not something to flip silently; ask if you want it.

## Do Not Change (unaffected by anything above)

`consensusApprovalThreshold` (0.75), `minIndependentAgreeingAgents` (2, plus the three explicitly
disclosed Java-ensemble alternate paths), all 25 RiskEngine gates, OMS's sole-`placeOrder` invariant,
`LIVE_NO_GO`, `PAPER_TRADING_ONLY`. Nothing in this pass touched any of these.
