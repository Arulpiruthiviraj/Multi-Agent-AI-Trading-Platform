# ARGUS — POST-REMEDIATION MARKET PERFORMANCE AUDIT

**Mode:** READ-ONLY forensic. No source, config, `.env`, or database writes were made. Two small, targeted read-only queries were run this pass (via throwaway Node scripts opening `data/argus.db` with `readonly: true`, deleted immediately after use) to answer this spec's genuinely new questions (per-remediation status, prediction-accuracy-by-confidence). Everything else in this report is **restructured from, and cites**, `ARGUS_POST_MARKET_PERFORMANCE_AUDIT_2026-08-20.md` (compiled ~30 minutes earlier, same day, same DB) rather than re-derived from scratch — that report's core claims (the one real NVDA fill, the `profit_loss` bug, agent health stats) were independently re-verified against source/DB before being reused here, not taken on faith.

**Evidence grades:** `CODE` (verified in source), `DATA` (SQLite query, this pass or the cited prior one), `RUN` (live/runtime observation), `CALCULATED` (arithmetic from DATA), `NOT VERIFIED` (could not confirm).

**Compiled:** 2026-08-20, shortly after the cited prior audit. Market session 2026-08-20 was still in progress at compile time (close 16:00 ET / 20:00Z) — same interim-audit caveat as the prior report applies.

---

## 1. Executive Summary

Two genuinely new findings this pass, on top of everything already reported in the prior audit:

**New finding — real prediction accuracy is at chance level.** `prediction_outcomes` (55,965 rows total, not empty) was queried directly for today: KronosEngine's directional accuracy today is **49.8% at its dominant 0.80–0.89 confidence band (n=661)** and 61.0% at 0.70–0.79 (n=41) — indistinguishable from a coin flip at its main operating confidence, despite stating high confidence. TechnicalAgent is **41–50% across all bands today (n=512)**, with accuracy *decreasing* as stated confidence rises (47.0% at 0.50–0.59 → 41.2% at 0.70–0.79). PortfolioManager's underlying signal (not the one real trade — the broader momentum-breakout call evaluated 30 times today) was **30.0% correct at 0.80–0.89 confidence**. This is real, DATA-backed, and the single strongest evidence yet that Argus's stated confidence values are **not currently well-calibrated to actual subsequent price direction** — independent of, and more fundamental than, the consensus-threshold question.

**New finding — the remediation-boundary problem.** No session today has both (a) real trading-decision activity AND (b) started after the last remediation commit (`c8285f6f`, NVDA target-provenance fix, 17:46:51Z). The one real NVDA fill (16:25–16:26Z) occurred in session `e14691df` (PID 15912), which **predates** that fix's presence in the running process. The only session that runs fully after all remediations (`7e30e65e`, PID 15260, 17:57Z–ongoing) has not been independently confirmed this pass to contain comparable trading-decision volume — this is flagged rather than assumed either way (see §2).

Everything else — the one real organic NVDA SELL fill, the `trades.profit_loss` silent-failure bug, agent health, RiskEngine gate stats, the funnel counts, data integrity warnings, TradingAgents status — is carried over from the prior report, independently re-verified (the fill row and the `OrderManagement.ts` bug were personally re-checked against the live DB and source before this report was written, not merely copied).

**Scores:** see §16. **Trading evidence: INSUFFICIENT.** **Live readiness: LIVE_NO_GO.** **Paper trading status: DEGRADED** (mechanically functional, but the prediction-accuracy finding above is a new, real degradation signal beyond what "DEGRADED" meant in the prior report).

---

## 2. Audit Window

**Selected day: 2026-08-20** (DATA — same determination as the prior audit: this is the only recent day with real, non-incident, non-REPLAY-dominated decision-funnel activity; 2026-08-18 is excluded as a documented incident day, kill-switch event id 59).

**Remediation timeline** (DATA + CODE, carried over and re-verified):

| Remediation | Landed (best evidence) |
|---|---:|
| Kronos fail-closed (never votes when Chronos unavailable) | Before today — code confirmed present and exercised all day (see §4A) |
| News tick-success telemetry | Earlier this session (this conversation thread), before today's later activity |
| NVDA target-provenance fix (`resolveOpeningTradeForLiveExit`) | File mtime `2026-08-20 16:45:05 UTC`; commit `c8285f6f` at `2026-08-20 17:46:51 UTC` |
| Quant/Alpaca shared 429 backoff | Pre-existing before today (Phase 2 audit found this "PARTIALLY FIXED" already in place, not newly landed today) |

**Sessions today** (DATA, `observability_events.session_id`, carried over from the prior report, re-cited here for the remediation-boundary question):

| Session | Window (UTC) | Contains |
|---|---|---|
| `bb6b71be` | 15:24–16:02 | The original no-trade audit window (pre-remediation) |
| `e14691df` (PID 15912) | 16:14–17:10 | **The one real NVDA SELL fill (16:25–16:26Z)** — this is **before** the 17:46:51Z target-fix commit |
| `7e30e65e` (PID 15260) | 17:57–ongoing | **The only session starting after all remediations landed** |

**Best post-remediation session, explicitly:** there isn't a clean one. `e14691df` has the real trade but predates the last fix. `7e30e65e` postdates every fix but its own decision-funnel volume (VETOs, risk assessments, new fills) was **not separately broken out by session_id in this pass** — the day-level totals in §6 blend all sessions. This is a genuine limitation of the "remap, don't rerun" scope chosen for this report: a true per-session funnel breakdown would require the kind of full re-query the user explicitly opted out of. **NOT VERIFIED: how much decision-funnel activity, if any, occurred specifically within `7e30e65e`.**

**Runtime facts** (DATA/RUN, carried over): `trading_mode=PAPER`, `trading_state=TRADING_ENABLED`, `auto_bot_enabled=1` (current), no `LIVE` execution_environment rows anywhere in `trades`, ever. `PAPER_TRADING_ONLY` key exists in `.env` (value not printed). Direct `GET /api/v2/live-readiness` was not queried this pass either (same gap as the prior report) — `LIVE_NO_GO` is inferred from total absence of any LIVE trade/arm event, not directly polled.

---

## 3. Runtime Health

Carried over verbatim from the prior audit's §3 (already independently spot-checked once; not re-queried this pass): Argus process DEGRADED-but-running (13+ session restarts in one day), SQLite/WAL HEALTHY, MarketDataWorker HEALTHY, broker connection HEALTHY, reconciliation DEGRADED-transiently-recovered-correctly (the post-fill local-portfolio lag, §10), Autobot ENABLED (current), emergency-stop triggered once and immediately reversed (operator test, not incident), Chronos/Kronos HEALTHY-and-active, QuantEngine HEALTHY-mechanically-zero-output, NewsAgent HEALTHY-clustering/DEGRADED-LLM-scoring, Fundamental/Macro nominal-but-inert, TechnicalAgent HEALTHY, BullResearcher/BearResearcher FAILED (near-total, `deepseek-r1:14b` timeouts), ExplainabilityAgent FAILED, ConsensusDebate PARTIAL (one of two providers dead), ReflectionEngine PARTIAL, OMS HEALTHY (n=1).

---

## 4. Remediation Verification

### A. Kronos / Chronos — **WORKING**
- Chronos reachable at `:8008` all day (RUN, prior soak-script output). Kronos active and voting continuously (DATA — 1,199–1,518 SELL / 266–320 BUY signals today, depending on which log table, see §10's discrepancy note). No `KRONOS_UNAVAILABLE`-during-vote pattern found. Fail-closed code path (`KronosForecastAgent.ts` checking `isAvailable` before and after the forecast call) independently verified in source earlier this session (CODE).
- **New this pass — Kronos is healthy but NOT demonstrated useful**: real evaluated accuracy today is 49.8% at its dominant confidence band (§7). Per this spec's own framing (healthy-and-useful / healthy-but-not-influential / unreliable / creating-excessive-disagreement / improving-consensus): Kronos is **"healthy but unreliable at predicting direction,"** and — see §4's bottleneck discussion below — **actively contributes to consensus disagreement**, since it ran 82% SELL-skewed today while TechnicalAgent ran 98% BUY-skewed (841 BUY/20 SELL) on largely the same universe. Two agents pointed opposite directions most of the day; that alone can prevent 2-independent-agent BUY consensus even before confidence math is considered. **This is the single most concrete, evidence-backed answer to "what is the biggest bottleneck to consensus" this or the prior audit has produced.**
- Stale-prediction reuse: not observed (no evidence Kronos served an old forecast past its own freshness window) — NOT VERIFIED beyond that negative check.

### B. Quant Engine — **PARTIALLY WORKING**
- No 429-cascade signature found in today's 1,061 `quant_assessments` rows (DATA, carried over) — the shared backoff isn't being tested hard today, not proof it would hold under real pressure. The dedup-cache gap Phase 2 found remains unaddressed (CODE, unchanged).
- **New synthesis this pass:** zero of the 1,061 assessments ever emitted a trade idea (`emitted_trade_idea=0` on every row, carried over DATA). Re-reading `QuantSignalAgent.ts` (read earlier this session): a strategy-sourced idea is refused unless `computeLiveStrategyWinRate()` returns a real win-rate estimate, which itself requires a minimum sample of **real closed live trades for that specific strategy** — and Argus has, at most, one ever-closed organic trade in its entire history (§9). This means QuantEngine's silence today is **structurally guaranteed, not incidental** — it cannot possibly clear its own EV gate with an effectively-empty live track record, independent of whether 429s are fully solved. This is a real, CODE-consistent explanation the prior audit didn't make explicit.

### C. NVDA / Portfolio Target Bug — **FIXED (code), NOT RE-EXERCISED**
- `resolveOpeningTradeForLiveExit()` / `isValidLongQuantTarget()` confirmed present and correct in current source (CODE, re-verified). The one real trade's own reasoning text still shows the old contaminated `$121.90` figure, but chronologically predates the fix landing in the running process (§2) — not a live contradiction. The NVDA position is now fully closed (only GLD remains, DATA carried over), so **there is currently no NVDA position to re-test the fix against** — status is "fixed in code, not exercised against a live position since."

### D. News Veto — **WORKING (as designed)**
- 21 blocks today, all NVDA SELL, cluster count dropped from ≥3 to 0 by the moment of approval (DATA, carried over) — genuinely time-bound, not bypassed, direction-blind per design. No evidence of excessive blocking, stale-cluster reuse, or unrelated-symbol blocking. **No weakening recommended.**

### E. AI Debate / Consensus Providers — **PARTIALLY WORKING**
- ConsensusDebate: one provider HEALTHY (141 success / 0 error), one FAILED (0 success / 177 error) — net usable via failover (DATA, carried over).
- BullResearcher / BearResearcher: **FAILED** (97%+ error rate, `deepseek-r1:14b` 60–90s timeouts — consistent with `HeavyModelMutex`'s `maxConcurrentHeavyModels:1` becoming a bottleneck when 3 agents share one heavy model, CODE-consistent inference).
- ExplainabilityAgent: **FAILED** (0 successes found today).
- No secret values exposed; only presence/health reported throughout, consistent with this spec's own constraint.

---

## 5. Agent Health

See §3 (carried over) and §7 (new, real accuracy data) — not repeated here to avoid duplication.

---

## 6. Complete Decision Funnel

Carried over verbatim from the prior audit (DATA, day-level, live/non-REPLAY only):

```
841 TechnicalAgent BUY + 20 SELL
+ 266–320 Kronos BUY + 1,199–1,518 Kronos SELL  (see §10 note on the two-table discrepancy)
+ 179 FundamentalAgent HOLD @ 0 confidence
+ 143 MacroAgent HOLD @ 0 confidence
+ 49 PortfolioManager SELL (all NVDA risk-exit)
+ 8 OpportunityScreener BUY
≈ 2,685 live agent signals today
  → ChiefTraderAgent: 2,181 VETO / 49 APPROVE (every approval = NVDA risk-exit SELL)
    → RiskEngine: 50 live assessments (49 from the approvals + 1 manual-override BUY) → 1 approved
      → OMS: 1 order created/submitted → Broker: 1 accepted (176ms) → Fills: 1 FILLED (qty 1/1)
```

No SIZING_FAILURE / OMS_FAILURE / BROKER_REJECTION observed live today.

---

## 7. Consensus Quality — including NEW prediction-accuracy analysis

**Confidence-band distribution of today's `transaction_traces.consensus_score`** (DATA, carried over):

| Band | Count |
|---|---:|
| 0.00–0.09 | 559 |
| 0.20–0.29 | 750 |
| 0.40–0.49 | 569 |
| 0.70–0.74 | 1 |
| 0.75–0.84 | 0 |
| 0.85–1.00 | 49 (all NVDA risk-exit) |

No graded (non-risk-exit) approval ever reached 0.75–0.84 today — the only approvals used the confidence-agnostic risk-exit shortcut.

**Consensus failure categories (ChiefTrader-stage, live today), best-available breakdown:**

| Category | Read |
|---|---|
| A. Insufficient independent agents | Dominant — most VETOs are single- or dual-agent patterns (e.g. solo-Technical ~315 rows @ ~0.24 confidence, Kronos+ConsensusDebate+Chief ~757 rows, still <0.75) |
| B. Confidence below threshold | Largely the **same rows** as (A) — confidence and agreement-count are correlated in this system's math, not cleanly separable without a per-trace re-query beyond this pass's scope. **NOT VERIFIED as a distinct count from (A).** |
| C. Directional disagreement | Real and material — Kronos ran 82% SELL-skewed, TechnicalAgent ran 98% BUY-skewed, on largely the same symbol universe today (DATA, §4A). This structurally blocks agreement even before confidence math applies. |
| D. Agents unavailable | NewsAgent is deliberately non-voting (`CATALYST_ONLY` mode, by design, not a failure); BullResearcher/BearResearcher/Explainability effectively down all day (§4E) — their *absence as independent evidence*, not a hard block, per CLAUDE.md. |
| E. Most agents HOLD | Fundamental (179) + Macro (143) HOLD-at-0-confidence all day — structurally non-contributing, not failing. |
| F. Invalid/stale signal | None observed live today. |
| G. Duplicate/cooldown | 1 (`sell_position_exists`, the post-fill duplicate NVDA SELL, correctly rejected — §10 of the prior report). |
| H. Other | 19 `market_hours` pre/post-RTH SELL attempts (RiskEngine-stage, not ChiefTrader-stage — kept separate per funnel stage). |

**★ NEW — Real prediction-accuracy by confidence bucket (`prediction_outcomes`, this pass, DATA, today only):**

`prediction_outcomes` is **not empty** — 55,965 rows total, 2,141 evaluated today (1,384 via `agent_predictions`, 757 via `kronos_predictions`). This directly answers this spec's Phase 7 question ("if `prediction_outcomes` is empty, determine why") — it is not empty; the evaluator (`PredictionOutcomeEvaluator.ts`) is running and productive.

| Source | Confidence band | n | Win | Loss | Win rate |
|---|---|---:|---:|---:|---:|
| KronosEngine (`kronos_predictions`) | 0.70–0.79 | 46 | 25 | 16 | 61.0% |
| KronosEngine (`kronos_predictions`) | 0.80–0.89 | 711 | 329 | 332 | **49.8%** |
| KronosEngine (`agent_predictions` log) | 0.70–0.79 | 41 | 25 | 16 | 61.0% |
| KronosEngine (`agent_predictions` log) | 0.80–0.89 | 661 | 329 | 332 | **49.8%** |
| TechnicalAgent | 0.50–0.59 | 351 | 165 | 186 | 47.0% |
| TechnicalAgent | 0.60–0.69 | 140 | 65 | 75 | 46.4% |
| TechnicalAgent | 0.70–0.79 | 17 | 7 | 10 | 41.2% |
| TechnicalAgent | 0.80–0.89 | 4 | 2 | 2 | 50.0% |
| PortfolioManager (underlying signal, not the 1 real trade) | 0.80–0.89 | 30 | 9 | 21 | **30.0%** |
| MacroAgent / FundamentalAgent | n/a (HOLD @ 0 confidence) | 62 / 78 | — | — | Correctly marked `N_A`, not forced into WIN/LOSS |

**Interpretation, honestly:** at Kronos's dominant operating confidence (0.80–0.89, n=661–711, by far the largest real sample in this entire audit series), directional accuracy is **49.8% — statistically indistinguishable from a coin flip**, despite the agent stating "high confidence." TechnicalAgent's accuracy *declines* as its stated confidence rises (47.0% → 41.2%), the opposite of good calibration. PortfolioManager's underlying momentum-breakout signal was right only 30% of the time at high confidence today. **This is the most direct, real, sample-sized evidence in any of these three audits that Argus's current confidence values are not calibrated to actual subsequent price direction.** This does not by itself prove the consensus threshold is wrong — a low-accuracy voter correctly failing to reach consensus alone is arguably the *safety system working as intended* — but it does mean: raising trade frequency by adding more agents at similar accuracy would not obviously help, and the mechanism's overall correctness (§ scores) should not be read as evidence the underlying signals are good.

---

## 8. Risk Gate Analysis

Carried over verbatim from the prior audit's §14 (gate-by-gate pass/fail table, `news_veto` deep-dive) — not re-queried this pass; no new evidence to add.

---

## 9. Organic Paper Trades

Carried over and independently re-verified this session (DATA, directly queried against `data/argus.db` and `OrderManagement.ts` source, not merely copied):

| Field | Value |
|---|---|
| Order id | `dec6df82-dadb-4508-a5d4-33a077e26373` |
| Symbol / side | NVDA / SELL, 1 share |
| Entry (opening) leg | `EXTERNAL_SYNC`, 2026-06-12, **not an Argus decision** |
| Submitted → Accepted → Filled | 16:25:47.338Z → 16:25:47.514Z (176ms) → 16:26:06.363Z |
| Fill price | $216.85 |
| `trades.profit_loss` | **NULL** (confirmed directly, this pass) — root cause: `OrderManagement.ts` line 336–340, empty `catch (e) {}` around `activeBroker.positions()`; line 381 gates P&L computation strictly on that lookup succeeding (confirmed directly in source, this pass) |
| Gross P&L (if it had been computed) | ≈ +$10.00 (CALCULATED) |

No other non-REPLAY FILLED trade exists anywhere in the database's history.

---

## 10. Trade Performance

**INSUFFICIENT SAMPLE SIZE.** n=1, entry-leg non-organic, `profit_loss` field itself not populated. Carried over from the prior audit's §7 — no new computation possible or attempted.

---

## 11. Prediction Accuracy

See §7 above (new this pass) — the confidence-bucket accuracy table is the substantive content for this section; not duplicated again here.

---

## 12. TradingAgents Research Comparison

**NOT ACTIVE — NO COMPARISON DATA.** No vendored TradingAgents source, integration files, flags, or `placeOrder` paths referencing it exist in the repository (confirmed by this and both prior audits). It remains inspiration-only.

**Proposed future architecture** (per this spec's own suggested shape, evaluated conceptually only — not implemented, not authorized):

```
Market Data → Argus Analysis → Argus Decision Ledger → Research Comparison Layer
                                                          ├── TradingAgents
                                                          ├── Other research engines
                                                          └── Prediction evaluation
                                                        → Agreement/Disagreement Analytics
                                                        → Offline Learning Dataset
```

Given §7's finding (real accuracy near chance level for the agents Argus already has), **a comparison layer would be genuinely useful** — not to add another voter, but specifically to test whether an independent research methodology (bull/bear debate, fundamental synthesis) is *better calibrated* than what's currently measured. This is a stronger, more concrete argument for the "SHADOW-mode comparison" idea discussed earlier in this conversation than existed before this audit, because now there is a real, measured baseline (49.8%/coin-flip) to beat. Still not implemented; still requires explicit authorization to build.

---

## 13. Reliability Analysis

Carried over from the prior audit's §3/§17, reclassified into this spec's severity taxonomy:

| Issue | Severity | Trace |
|---|---|---|
| `trades.profit_loss` silent-failure (empty catch) | **HIGH** | `OrderManagement.ts` → `trades` row → soak/P&L tooling undercounts by exactly the one trade that matters |
| Transient local-`portfolio` lag after the one real fill → reconciliation pause | **MEDIUM** | Fill → local cache stale ~5 min → `MISSING_REMOTELY` mismatch → correct fail-closed `TRADING_PAUSED` → operator resume 14.5 min later. Correctly handled, but a real transient inconsistency. |
| Overlapping `session_id`s (13:38–14:29Z) | **MEDIUM** | Multi-writer/instrumentation artifact, not root-caused this pass |
| 13+ short-lived process restarts in one day | **MEDIUM** | Consistent with active same-day development work on this exact forensic thread, not necessarily representative of steady-state operation |
| `agent_predictions` vs `agent_reasoning_logs` Kronos count discrepancy (~300–400 rows) | **LOW** | Two independently-written logs, not expected to match 1:1, gap flagged not root-caused |
| BullResearcher/BearResearcher/ExplainabilityAgent near-total failure | **HIGH** (capability gap) but did not demonstrably flip any actual decision today (no near-miss BUY was blocked specifically for lack of their input — closest was one row at 0.70–0.74, still short of 0.75 even hypothetically with more evidence weight) | `ai_calls` error logs |

No CRITICAL-severity issue was found to have altered a real trading decision today.

---

## 14. Previous vs Current Comparison

| Area | Prior audit (no-trade, pre-remediation) | Current | Change |
|---|---|---|---|
| Organic FILLED trades | 0 | 1 (entry non-organic) | Real but asterisked |
| ChiefTrader VETO rate | ~99%+ | ~98% (2,181/2,230) | Effectively unchanged |
| news_veto | Blocking, unresolved during that window | Blocked then correctly cleared | Working as designed both times |
| Kronos | Not separately fail-closed-verified in the original audit | Confirmed fail-closed; **new: confirmed near-chance accuracy** | Safety confirmed; usefulness newly disproven |
| Quant | 429-limited | No 429 today; **new: structurally silent regardless of 429 (EV-gate sample-size floor)** | Root cause reframed, not resolved |
| AI providers | "No AI Providers available for consensus" | ConsensusDebate partially recovered (1 of 2); Bull/Bear/Explainability still down | Partial improvement |
| NVDA target bug | Active, contaminating reasoning | Fixed in code; last live occurrence chronologically predates the fix | Fixed, narrowly unverified against a live position since |

---

## 15. Root Causes

| Previous Problem | Previous Status | Current Status | Evidence |
|---|---|---|---|
| H — Consensus failure (0.75/min-2) | Dominant | **UNCHANGED** — still dominant, now additionally explained by real directional disagreement between Kronos and Technical (§4A/§7), not just low individual confidence | DATA |
| N — News veto | Blocking | **UNCHANGED (working as designed)** | DATA |
| O — Kronos fail-closed | Undocumented at the time | **FIXED** (safety) / **NEW FINDING: unreliable** (usefulness) | CODE+DATA |
| O — Quant 429 | Active | **IMPROVED** (no 429 today) but **NOT EXERCISED under real load**, and **NEWLY EXPLAINED** as structurally silent regardless (EV-gate sample floor) | DATA+CODE |
| O — NewsAgent no successful ticks | Bug (telemetry only) | **FIXED** (this session, verified) | CODE+DATA |
| O — AI provider failure | Total | **IMPROVED** (partial) — one ConsensusDebate provider recovered; Bull/Bear/Explainability still down | DATA |
| NVDA target bug | Active | **FIXED** (code), not re-exercised live since | CODE |
| Dirty shutdown / multi-writer | Present | **UNCHANGED** — still present today (13+ restarts, one overlapping-session_id artifact) | DATA |
| Observability gaps | Present | **IMPROVED** — News telemetry fixed; **NEW GAP FOUND**: `trades.profit_loss` silent-failure | CODE |
| Prediction-outcome gaps | Not investigated in prior audits | **NOT A GAP** — `prediction_outcomes` is real, populated, and running (55,965 rows); the gap is in the *results* (near-chance accuracy), not the plumbing | DATA |

---

## 16. Scorecard

| Category | Score | Evidence |
|---|---:|---|
| Market data | 82/100 | Carried over — real intraday bars, real `data_freshness` passes |
| Technical analysis | 55/100 | Deterministic and available (as before), but **new**: real accuracy 41–50% today, not previously measured |
| Quant engine | 45/100 | Mechanically healthy, structurally silent by its own EV-gate design given near-zero closed-trade history — not simply "off," but not producing anything either |
| Kronos | 40/100 | Available and fail-closed (good), but **new**: 49.8% accuracy at its dominant confidence band — no demonstrated edge |
| Fundamental analysis | 50/100 | Nominal, non-contributing, not broken |
| Macro analysis | 50/100 | Same |
| News analysis | 60/100 | Clustering healthy, LLM scoring ~4% success, ideas deliberately off by design (`CATALYST_ONLY`) |
| AI debate | 35/100 | One provider path works; three of four LLM-dependent agents effectively down all day |
| Agent consensus | 74/100 | Mechanism correct and consistently applied; **new context**: even if it approved more, the underlying signals it would be approving are not yet shown to be accurate |
| Risk management | 90/100 | Unchanged from prior audit — 20/20 gates correct on the one real trade, capital/news gates correctly enforced |
| OMS | 78/100 (n=1) | Clean submit/accept/fill; genuinely tested once, not "untested" |
| Broker integration | 80/100 | Real accept/fill cycle worked cleanly |
| Reliability | 62/100 | Real fills work; docked for restart frequency, the P&L bug, and the transient reconciliation lag |
| Observability | 65/100 | Improved this session (News fix); new gap found (P&L silent failure); decision-trace infrastructure itself is genuinely rich |
| Prediction evaluation | 70/100 | The evaluator infrastructure itself works well and is running productively — scored on plumbing, not on what it revealed |
| Paper trading evidence | 20/100 | One real fill exists, but n=1 with a non-organic entry leg cannot be called meaningful evidence of anything beyond "the pipe works" |

**OVERALL SYSTEM READINESS: 61/100** (CALCULATED, unweighted mean of the above — a rough single-number signal, not a formal composite; individual rows carry the real meaning).

**TRADING EVIDENCE: INSUFFICIENT.**

**LIVE READINESS: LIVE_NO_GO.**

**PAPER TRADING STATUS: DEGRADED** — mechanically real and correct end-to-end, but this pass's prediction-accuracy finding is new evidence of a real capability gap, not just an infrastructure one.

---

## 17. Evidence Table

All findings above are labeled inline (CODE/DATA/RUN/CALCULATED/NOT VERIFIED) at point of use, per this spec's instruction to avoid mixing evidence types. No consolidated table is repeated here beyond what's already inline, to avoid a second, potentially-inconsistent restatement of the same facts.

---

## 18. Remaining Blockers

1. **`trades.profit_loss` silent-failure** (`OrderManagement.ts`, HIGH severity) — small, safe, additive fix available (log the failure, fall back to a locally-stored average price instead of only trusting a live broker call). Not yet fixed.
2. **No genuine post-remediation trading session has been observed** — the one real trade predates the last fix; the current session's own funnel volume is unverified (§2).
3. **Kronos/Technical directional disagreement** — a real, structural bottleneck to BUY-side consensus, not something to "fix" by weakening thresholds, but worth knowing about.
4. **Near-chance prediction accuracy** at real, non-trivial sample sizes (§7) — the most important open question this raises is *why* (feature quality? regime mismatch? something else), which is a research question, not a quick fix.
5. **QuantEngine structurally cannot emit ideas** until enough real closed trades exist to seed its own EV-gate — a cold-start problem, not a bug.
6. **Transient reconciliation lag after a fill** — root cause not fully traced (§13, MEDIUM).

---

## 19. Recommended Next Actions

1. Fix the `profit_loss` silent-failure (small, safe, matches the News-telemetry fix pattern already applied this session).
2. Do **not** change consensus thresholds, RiskEngine gates, or news_veto based on this report — nothing here suggests they're miscalibrated; if anything, §7's findings argue for *more* skepticism of current signals, not less gating.
3. If continuing this line of investigation, the next genuinely new question is *why* Kronos/Technical accuracy sits near chance — that requires feature/regime-level investigation, not another funnel audit.
4. A true "post-all-remediations" session audit remains open — would need Argus to run for a full session after `c8285f6f` with Autobot on, then be audited fresh (not remapped).
5. TradingAgents SHADOW-mode comparison (§12) now has a stronger evidentiary case (a real, low baseline to beat) — still requires explicit authorization to build; not started.

---

*End of audit. This report intentionally reuses and cites `ARGUS_POST_MARKET_PERFORMANCE_AUDIT_2026-08-20.md` rather than re-deriving already-verified findings, per explicit user direction to remap rather than fully rerun. The two genuinely new analyses (remediation-status classification, prediction-accuracy-by-confidence-bucket) were computed fresh, read-only, this pass.*
