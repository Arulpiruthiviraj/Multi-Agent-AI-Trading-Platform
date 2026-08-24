# ARGUS POST-MARKET PERFORMANCE AUDIT — 2026-08-20

**Mode:** STRICT READ-ONLY forensic. No source, config, `.env`, or database writes were made during this audit. The SQLite database was opened `readonly: true` via `better-sqlite3` in throwaway Node scripts (deleted after use, not part of the repo). One live read-only shell command was run (`npx tsx scripts/organic_paper_soak_status.ts`), which only queries the DB and computes derived numbers — it places no orders, changes no state, and is explicitly documented as non-mutating.

**Evidence grades used throughout:** `DATA` (SQLite query, query logic shown), `CODE` (verified in source), `RUN` (live/runtime observation — process list, file mtimes, script output), `CALCULATED` (arithmetic derived from DATA), `NOT VERIFIED` (could not confirm).

**Report compiled:** 2026-08-20T18:29:55Z (14:29:55 America/New_York). **The audited trading day was still in progress at compilation time** (market close is 16:00 ET / 20:00Z; compilation happened at 14:29 ET). This is flagged explicitly in §2 as a deviation from a true "post-market" audit — see there for why 2026-08-20 was nonetheless the correct session to audit.

---

## 1. Executive Summary

*(Written last, after all findings below.)*

The single most important finding: **this session contains the first-ever real, FILLED, organic-decision PAPER order in Argus's database** — NVDA SELL, 1 share @ $216.85, filled 2026-08-20T16:26:06.363Z, order id `dec6df82-dadb-4508-a5d4-33a077e26373`, transaction `ARG-2026-08-20-000199` (DATA). It went through a genuine ChiefTraderAgent risk-exit approval and passed all 20 evaluated RiskEngine gates (DATA, `risk_gate_results`), and OMS placed it against the real Alpaca paper broker, which filled it in ~19 seconds (DATA). This directly supersedes the CLAUDE.md claim "Organic closed paper FILLED SELL P&L: 0" as a point-in-time fact — that claim was accurate before 2026-08-20T16:26Z and is no longer accurate as a literal statement about the `trades` table.

However, three qualifications matter and are why this does **not** move Argus's soak/edge status:

1. **The entry (BUY) leg was never an Argus decision.** The NVDA position was opened `EXTERNAL_SYNC` on 2026-06-12 (a baseline broker-sync row, not a ChiefTrader/RiskEngine/OMS-originated BUY) (DATA). Only the exit was organic.
2. **The official soak tool itself reports zero.** `npx tsx scripts/organic_paper_soak_status.ts` (RUN, this session) returns `closedTradeCount: 0` because `trades.profit_loss` is `NULL` on this exact row — `isOrganicClosedPaper()` in `src/server/research/organicPaper.ts` requires `typeof row.profitLoss === 'number'` (CODE) and this row fails that check regardless of environment tagging. Root cause traced to `src/server/services/OrderManagement.ts` lines 336-340: `preTradeEntryPrice` is fetched from a live, unguarded `activeBroker.positions()` call wrapped in an empty `catch (e) {}` — if that call fails or doesn't find the symbol, P&L silently never gets computed, with no retry or backfill (CODE). This is a **new, previously undocumented, currently-live defect**, distinct from anything in the three prior audits.
3. **The exit's own stated reason is contaminated by the historical NVDA-target bug** ("Quant strategy (MOMENTUM_BREAKOUT) target reached: $216.78 >= $121.90") that Phase 2 reported "CONFIRMED FIXED AND TESTED (16/16)." Chronological evidence (this trade fired 16:25-16:26 UTC; the fix file's mtime is 16:45 UTC; the fix commit `c8285f6` is 17:46:51 UTC) shows this trade simply predates the fix — it is not evidence the fix is broken, but it is the last live instance of the bug's effect, and it means the one real trade's audit trail carries a wrong number in its human-readable reasoning.

With n=1 (and an entry-side asterisk on that one), this is **INSUFFICIENT SAMPLE SIZE to establish edge**, full stop. Everything else observed today — 2,181 ChiefTrader VETOs, 21 news-veto blocks, one manual-override capital-allocation rejection, near-total AI-debate-provider degradation — is consistent with the prior two audits' finding that Argus is a fail-closed, non-trading (or barely-trading) system by design, correctly gating on consensus and risk, not a system with demonstrated edge.

**Scores (justified in §19):** System reliability 68/100 · Market data quality 82/100 · Agent availability 46/100 · Consensus quality 74/100 · Risk management 90/100 · Execution quality 78/100 (n=1, small-sample caveat) · Observed trading performance: **INSUFFICIENT DATA**. **Evidence of trading edge: NONE.**

Sections where I had to fall back to NOT VERIFIED / INSUFFICIENT DATA (flagged again inline): §7 (performance metrics, n=1), §8 (counterfactual for the ~2,700 BUY-side VETOs — only the one NVDA episode has real intraday-bar-backed counterfactual data), §13 (regime-vs-strategy alignment causality), part of §17 (exact root cause of the transient reconciliation local-state lag).

---

## 2. Audit Window

**Most recent day with real (non-REPLAY) decision-funnel activity:** 2026-08-20. This was determined by DATA, not assumed:

| Day | Live (non-replay) `risk_assessments` | Live `transaction_traces` | Notes |
|---|---:|---:|---|
| 2026-08-20 | **50** | ~2,745 (ANALYZING+FILLED) | Real fill occurred (DATA) |
| 2026-08-19 | 2 | 898 | Effectively idle |
| 2026-08-18 | 2 | 51,263 | **Contaminated** — `kill_switch_events` id 59 (2026-08-18T19:29:15Z) documents an "idea-generation loop firing 500+ ideas/min and 15k+ AI calls/min ... saturating the event loop and crashing the process" — this day is an incident, not a representative session, and is excluded from all "typical day" framing below (DATA+the event's own recorded reason). |
| 2026-08-17 and earlier | low / REPLAY-dominated | — | Not audited in depth; prior audits already cover 2026-08-20's earlier PID-14036 window. |

**Deviation from "post-market" flagged explicitly:** at compilation time (14:29 ET), the NYSE session for 2026-08-20 had **not yet closed** (close is 16:00 ET). The process was still running live (PID 15260, heartbeat `2026-08-20T18:15:05.665Z` — RUN, `data/.argus_runtime_session.json`, confirmed alive via `tasklist` showing PID 15260 at 765MB RSS, the largest Node process running — RUN). This is therefore an **interim, same-day audit of an in-progress session**, not a true closed-market retrospective. I am reporting it as such rather than fabricating a "market closed" framing, because 2026-08-20 is unambiguously the most recent day with real activity and contains the one material event (the NVDA fill) this whole audit turns on.

**Runtime windows within 2026-08-20** (DATA, `observability_events.session_id` grouped by min/max `ts`, all times UTC): the day shows **many** short-lived process sessions (some with as few as 2-25 events, consistent with process restarts/crashes during active development work on this same forensic thread), interleaved with several long-running sessions:

| session_id (short) | Window (UTC) | Events | Notes |
|---|---|---:|---|
| `8d47efe8` … several short ones | 01:02–04:16 | up to 12,446 | Overnight — mostly REPLAY (`Argus Historical Evaluation`, MODE B) activity; kill-switch id 63 (04:02Z) records a REPLAY-vs-live reconciliation pause here. |
| `e1f1b282`, `36c786ed`, `0da2d0a1` | 12:20–13:12 | up to 3,034 | Admin resumed TRADING_ENABLED at 13:42:16Z (kill-switch id 64) — this is the pre-window for the previously-audited PID-14036 session. |
| `0da022d7` / `1c0fa0a6` (overlapping) | 13:38–14:29 | up to 7,693 | Two overlapping session_ids in the same window is itself a **multi-writer / instrumentation artifact** worth noting (§17). |
| **`bb6b71be`** | **15:24:04–16:02:39** | 9,278 | **This is the previously-audited PID-14036 no-trade window** (`docs/audits/archive/ARGUS_LIVE_NO_TRADE_FORENSIC_AUDIT.md`). Confirmed via session_id match to that audit's own citation. |
| **`e14691df`** | **16:14:41–17:10:46** | 10,762 | **The window containing the one real NVDA SELL fill** (16:25:47–16:26:06Z) and the reconciliation-triggered pause (16:34:41–16:49:02Z). This is PID 15912 referenced in the prior audit as "new writer PID 15912 started 2026-08-20T16:14:49.018Z." |
| `0b39c017`, `cc043061` | 17:20–17:55 | up to 1,283 | Another restart gap. |
| **`7e30e65e`** | **17:57:10–18:17:21 (ongoing)** | 5,258 | **Current running session**, PID 15260 (`data/.argus_runtime_session.json`: `startedAt: 2026-08-20T17:56:01.441Z`, `cleanShutdown: false`). Contains the 17:58:58→17:59:02 manual EMERGENCY_STOP/resume toggle (4 seconds apart, actor `admin` both times — reads as an operator test/verification, not a real incident) (DATA). |

**Trading state / config, as of report compilation (DATA, `settings` table row id=1):** `trading_mode=PAPER`, `trading_state=TRADING_ENABLED`, `auto_bot_enabled=1`, `budget=$2000`, `max_trade_size=$3000`, `min_ai_confidence=75`, `adversarial_debate_mode=1`, `max_portfolio_drawdown_pct=0.15`, `peak_equity=$100,039.02`, `strategy_engine_enabled=0`.

**Conflict with this task's own stated premise, flagged as required:** the task brief stated "the live Argus process (PID 15260) had just restarted with Autobot OFF." **DATA contradicts this as of report time** — the current `settings.auto_bot_enabled` is `1` (ON). I cannot verify what Autobot's state was at the exact instant PID 15260 started (no historical point-in-time log of that specific flag was found), so I mark **that specific historical claim NOT VERIFIED**, while the **current** state is DATA-confirmed ON. Practically, this matters less than the brief implied: the one real trade this audit turns on happened under an *earlier* PID (`e14691df`/PID 15912), not PID 15260, so PID 15260's Autobot state doesn't gate the material finding either way.

**PAPER_TRADING_ONLY / LIVE readiness:** `settings.trading_mode=PAPER` (DATA). `.env` key `PAPER_TRADING_ONLY` exists (value not printed, per audit convention of not exfiltrating secrets/config values beyond presence) (RUN). No `LIVE` execution_environment rows exist anywhere in `trades` for 2026-08-20 or ever in the data pulled this session (DATA — only `REPLAY`, `PAPER`, `EXTERNAL_SYNC` appear). I did **not** independently query `GET /api/v2/live-readiness` this pass (would have required navigating session auth) — direct API confirmation of `LIVE_NO_GO` is **NOT VERIFIED this pass**, though the total absence of any LIVE trade or LIVE-arm kill-switch event is strong indirect DATA consistent with `LIVE_NO_GO`.

**Config change since the same-day earlier audit, worth flagging:** `ARGUS_OPPORTUNITY_IDEAS_ENABLED` — reported **MISSING** from `.env` in `docs/audits/archive/ARGUS_LIVE_NO_TRADE_FORENSIC_AUDIT.md` (§10, §11) — **now exists** in `.env` (RUN, `grep -c "^ARGUS_OPPORTUNITY_IDEAS_ENABLED=" .env` → 1). This correlates with `OpportunityScreener` actually emitting 8 BUY ideas today (DATA, `agent_predictions`), where the prior audit recorded `ideasEnabled=false, ideasEmitted=0`. This is a real, DATA-confirmed configuration change made sometime today.

---

## 3. System Health During Market

| Component | Status | Evidence |
|---|---|---|
| Argus process / runtime | **DEGRADED** (frequent restarts) but **RUNNING** at report time | RUN+DATA — 13+ distinct `session_id`s in one calendar day, several lasting under a minute; current PID 15260 alive, heartbeat current |
| SQLite / WAL | HEALTHY today | DATA (file listing) — WAL/SHM files current; the `.corrupt-20260809` / `.stale-preswitch-2026-08-10` artifacts are old, unrelated to today |
| MarketDataWorker | HEALTHY | DATA — `data_freshness` gate `priceAgeMs` values of 12ms–1,685ms across today's live risk assessments; real 1-minute OHLCV bars ingested for NVDA/AAPL/TSLA/QQQ/SPY/MSFT/IWM/GOOGL/META through ~17:02Z today |
| Broker connection (Alpaca, paper) | HEALTHY | DATA — real order accepted in 176ms, filled in ~19s; 106/108 reconciliation cycles today matched |
| Reconciliation | **DEGRADED transiently, recovered correctly** | DATA — 2/108 mismatches today; the 16:34:41Z one (a real, DATA-traced local-portfolio lag right after the NVDA fill, see §17) correctly fail-closed (`TRADING_PAUSED`) rather than silently resolving; never auto-resumed (operator resumed 16:49:02Z, ~14.5 min later) |
| Autobot | ENABLED (current) | DATA, `settings.auto_bot_enabled=1` |
| Emergency stop / kill-switch | Triggered once (test-like), immediately reversed | DATA — 17:58:58Z→17:59:02Z, both actor `admin`, 4 seconds apart; reads as an operator verification, not an incident |
| Chronos / KronosEngine | HEALTHY, very active | RUN (`npx tsx scripts/organic_paper_soak_status.ts` output: "Local Chronos inference service reachable at http://127.0.0.1:8008") + DATA (1,518 SELL + 320 BUY + 22 HOLD predictions today, avg confidence 0.83–0.85) — reachable and productive, though direction-skewed (83% of its calls SELL) all day |
| QuantEngine (regime/strategy evaluation) | HEALTHY (mechanically), zero output today | DATA — 1,061 `quant_assessments` rows today with real, plausible `RegimeEngine` output (SMA/EMA/ADX/ATR/Bollinger/Keltner math, e.g. GLD `SIDEWAYS_RANGE` conf 0.8, SMH `BEARISH_TREND` conf 0.4, XLF `BULLISH_TREND` conf 0.8); **0/1,061 ever set `emitted_trade_idea=1`** today |
| NewsAgent (clustering) | HEALTHY (clustering), DEGRADED (LLM scoring) | DATA — 523 `news_clusters` created today (clustering pipeline active); its own `fingpt:latest` LLM calls: 70 error / 3 success (~4% success rate) |
| FundamentalAgent / MacroAgent | Nominal-but-inert | DATA — 179/143 HOLD-at-0-confidence entries respectively, all day, matching documented behavior (no BUY/SELL signal from these two today) |
| TechnicalAgent | HEALTHY | DATA — 841 BUY / 20 SELL, real confidence variance (~0.60 avg BUY, ~0.75 avg SELL), deterministic (no LLM dependency, matches CLAUDE.md) |
| BullResearcher / BearResearcher (deepseek-r1:14b) | **FAILED (near-total)** | DATA, `ai_calls` today: BullResearcher deepseek-r1:14b 383 error / 11 success (2.8% success); BearResearcher deepseek-r1:14b 393 error / 5 success (1.3%); average error latency 67-69 **seconds** per call. Fallback ("default" provider) also errors near-instantly (~1s) for both agents (237/227 errors, 0 success shown). |
| ExplainabilityAgent | **FAILED** | DATA — 173 + 79 errors across two providers, 0 successes found in today's `ai_calls` for this agent |
| ConsensusDebate | **PARTIAL** | DATA — provider `72a7de39…`: 141 success / 0 error (avg 1.9s); provider `0430f552…`: 0 success / 177 error. One of two configured providers is fully healthy, the other fully dead — net usable via failover, but far from the "6-model" ideal |
| ReflectionEngine | PARTIAL | DATA — deepseek-r1:14b 46 success / 32 error (~59%); "default" provider 0 success / 31 error |
| OMS | HEALTHY (n=1) | DATA — clean submit→accept (176ms)→fill (~19s), correct `broker_order_id`/`request_id`, exactly one `fills` row with `cumulative_quantity=1` (P0.4 satisfied) |

**Overall read:** the mechanical/deterministic half of the stack (MarketDataWorker, TechnicalAgent, RiskEngine, OMS, broker, Kronos, QuantEngine's regime math, NewsAgent clustering) is healthy. The **LLM/AI-debate half is heavily degraded**, dominated by `deepseek-r1:14b` timeouts in the 60-90 second range — consistent with `HeavyModelMutex`'s documented `maxConcurrentHeavyModels: 1` becoming a severe bottleneck when BullResearcher, BearResearcher, and ReflectionEngine all default-route to that one model simultaneously (CODE-consistent inference from CLAUDE.md's own routing table; not independently source-traced this pass beyond the `ai_calls` symptom data).

---

## 4. Full Decision Funnel (2026-08-20, LIVE/organic only — REPLAY excluded)

| Stage | Count | Evidence |
|---|---:|---|
| Market ticks / bars ingested | Continuous all day | DATA (1-min OHLCV through 17:02Z; `data_freshness` gate passes throughout) |
| TechnicalAgent signals | 841 BUY, 20 SELL | DATA, `agent_reasoning_logs` |
| KronosEngine signals | 1,199 SELL, 266 BUY (agent_reasoning_logs count; `agent_predictions` shows slightly different 1,518/320 — see §17 note on the discrepancy) | DATA |
| FundamentalAgent / MacroAgent | 179 / 143 HOLD @ 0 confidence | DATA |
| PortfolioManager (risk-exit) | 49 SELL ideas (all NVDA) | DATA |
| OpportunityScreener | 8 BUY | DATA |
| **ChiefTraderAgent** | **2,181 VETO / 49 APPROVE** | DATA, `agent_reasoning_logs` |
| **RiskEngine (`risk_assessments`, live only)** | **50 assessments: 1 approved, 49 rejected** | DATA (split from 779 total by excluding `replay:true`-flagged gate rows — see query logic in §16/appendix) |
| OMS orders submitted | 1 | DATA |
| Broker accepted | 1 (176ms) | DATA |
| Fills | 1 FILLED, complete (qty 1/1) | DATA |

Funnel, honestly stated:

```
841+266+1199+179+143+49+8 ≈ 2,685 live agent signals today
  → ChiefTraderAgent: 2,181 VETO / 49 APPROVE (all 49 approvals = NVDA risk-exit SELL)
    → RiskEngine: 50 live assessments (49 from the approvals above + 1 manual override) → 1 approved
      → OMS: 1 order → 1 fill
```

The ~2,181 VETOs are overwhelmingly BUY-side ideas failing ChiefTrader's consensus math (confidence below 0.75 and/or fewer than 2 independent agreeing agents) — this is the same root cause (class **H**) as the prior forensic audit, still dominant today.

---

## 5. Why Did Argus Trade or Not Trade

Classification of every terminal decision reason today (live only), ranked:

| Reason class | Count | % of live terminal reasons | Source |
|---|---:|---:|---|
| **CONFIDENCE_BELOW_THRESHOLD / INSUFFICIENT_INDEPENDENT_AGREEMENT** | ~2,181 (ChiefTrader VETO) | dominant | DATA, `agent_reasoning_logs` action=VETO; confirmed via `transaction_traces.terminal_reason` bucketed by confidence: e.g. "24.2%"×315, "0.0%"×243, "43.6%"×239, "23.7%"×132, "5.7%"×106, "50.6%"×100, plus ~15 more distinct confidence values each with 16-74 occurrences |
| **NEWS_VETO** | 21 | 42% of live risk assessments | DATA — all NVDA SELL, 15:24Z–16:20Z, "High volatility news event detected, overriding AI decision" |
| **OTHER (market closed at evaluation time, pre/post-RTH SELL attempts)** | 19 | 38% of live risk assessments | DATA, `market_hours` gate fail, "Market is currently closed (Alpaca clock)." No explicit bucket in the given taxonomy fits "session-hours" cleanly; mapped to OTHER rather than force-fit |
| **AGENT_UNAVAILABLE (session hold / emergency_stop at eval time)** | 7 | 14% | DATA — same NVDA SELL idea repeatedly re-evaluated during the earlier `TRADING_PAUSED` window (13:xx) before the 13:42:16Z resume |
| **CAPITAL_LIMIT (argus_capital_allocation)** | 1 | 2% | DATA — the MSFT manual-override BUY, requested $2,850 vs $2,000 remaining allocation |
| **RISK_REJECTION (sell_position_exists — stale-local-state duplicate)** | 1 | 2% | DATA — a duplicate NVDA SELL idea generated ~4 min after the real fill, correctly rejected because the *broker* (not local cache) showed 0 shares — see §17 |
| **RISK_ENGINE APPROVED → OMS → FILLED** | 1 | 2% | DATA — the one NVDA SELL |
| SIZING_FAILURE / OMS_FAILURE / BROKER_REJECTION | 0 | 0% | Not observed live today |

---

## 6. Trade Performance Audit

**ORGANIC_ARGUS_PAPER_TRADES this session: 1** (with the entry-leg caveat below). No REPLAY/BACKTEST/SIMULATION/EXTERNAL_SYNC trade is counted here as organic.

| Field | Value | Grade |
|---|---|---|
| Order id | `dec6df82-dadb-4508-a5d4-33a077e26373` | DATA |
| Transaction id | `ARG-2026-08-20-000199` | DATA |
| Symbol / side | NVDA / SELL | DATA |
| Quantity | 1 share | DATA |
| Originating agent | PortfolioManager (risk-exit path, skips debate + min-2-agent rule per documented exception) | DATA + CODE-consistent |
| ChiefTrader consensus | approved=1, weighted_confidence=0.85, threshold=0.75, agreements=1, `debate_used=0` | DATA |
| RiskEngine gates | **20/20 passed**, `news_veto` cleared (`matchingClusters:0` at this check, vs ≥3 earlier the same afternoon) | DATA |
| Submitted → Accepted → Filled | 16:25:47.338Z → 16:25:47.514Z (176ms) → 16:26:06.363Z (~19s from accept) | DATA |
| Fill price | $216.85 | DATA |
| Entry (opening) trade | **`EXTERNAL_SYNC`**, 1 share @ $206.85, dated 2026-06-12T15:24:51.088Z, `trace_id="baseline-sync-…"` — **not an Argus-organic BUY decision** | DATA |
| Gross P&L | **CALCULATED ≈ +$10.00** (($216.85 − $206.85) × 1), before any commission | CALCULATED |
| `trades.profit_loss` (stored) | **NULL** — never computed by OMS for this fill (see §17 root cause) | DATA |
| Stated exit reason | "EXIT_CODE=TARGET_REACHED Quant strategy (MOMENTUM_BREAKOUT) target reached: $216.78 >= $121.90" — **the $121.90 figure is the historical REPLAY-contamination artifact**, timestamped before the same-day fix (see §16) | DATA + CODE (timeline) |
| Holding duration | ~69 days on the broker side (June 12 → Aug 20) — not an Argus decision-duration, since entry wasn't Argus-decided | CALCULATED |
| MFE/MAE | NOT VERIFIED / INSUFFICIENT DATA for the full 69-day hold (no intraday history spanning that whole period was queried); for the ~1 hour around the exit, real 1-min bars exist — see §8 |

No other non-REPLAY FILLED SELL exists anywhere in the database's history (DATA — `trades` grouped by `execution_environment` for all-time FILLED SELLs returns only `PAPER: 1` and `REPLAY: 59`).

---

## 7. Performance Metrics

**INSUFFICIENT SAMPLE SIZE TO ESTABLISH EDGE.** n=1 closed organic-exit trade, and that one trade's entry leg was not an Argus decision. Win rate, profit factor, expectancy, Sharpe, drawdown streaks, etc. cannot be meaningfully computed from a single data point and are not reported as numbers. The official tooling agrees: `organic_paper_soak_status.ts` (RUN) returns `"sharpe": {"status": "INSUFFICIENT_SAMPLE", "sampleSize": 0}` and `"summary": {"sampleSize": 0, "grossPnl": null, "winRate": null, ...}` — its count is 0 rather than 1 because of the `profit_loss = NULL` gap documented in §6/§17, but even at n=1 no metric would be meaningful.

---

## 8. Missed Opportunity / Counterfactual Analysis

Real 1-minute OHLCV bars for NVDA were available for today (DATA, `ohlcv_bars` timeframe='1Min', 882 rows), which allowed one genuine, bounded counterfactual on the one meaningful delay this session contains — the `news_veto` block on the NVDA exit. All other symbols' rejections (the ~2,181 BUY-side VETOs) are **NOT VERIFIED / INSUFFICIENT DATA** for counterfactual purposes: computing a real one for even a bounded sample of them would require picking specific candidate ideas among thousands and fetching/joining bar data per timestamp, which was judged out of scope for this pass — flagged rather than fabricated.

**NVDA news-veto delay counterfactual (real bar data, DATA):**

| Time (UTC) | NVDA close (1-min bar) | Event |
|---|---:|---|
| 15:24 | $216.88 | First `news_veto` block (matchingClusters≥3) |
| 16:16 | $216.34 | Still blocked |
| 16:20 | $216.41 | Still blocked (last block before approval) |
| 16:25 | $216.88 | ChiefTrader/RiskEngine approve (`matchingClusters:0`) |
| 16:26 | $216.90 | Fill executes at $216.85 |
| 16:31 (+5m) | $216.62 | |
| 16:41 (+15m) | $216.90 | |
| 16:56 (+30m) | $217.195 | |
| 17:02 (latest bar available) | $217.48 | Bars stop here — market hadn't closed; **+1h bar (17:26) NOT VERIFIED / unavailable** |

**Classification: NEUTRAL-UNCLEAR, immaterial.** The ~61-minute news-veto delay (15:24→16:25) cost/gained about **$0.03/share** (216.88 vs 216.85 realized) — not a real difference on one share. Looking forward from the actual fill, price drifted **up** over the next 30-60 minutes (+$0.35 to +$0.63/share) — a purely mechanical reading would call the exit "slightly early," but this is a single observation on a take-profit exit, which by construction often looks early in short-term hindsight; it says nothing about whether the news_veto gate itself is well-calibrated. **GOOD REJECTION vs BAD REJECTION does not meaningfully apply here** — the veto delayed a sell that turned out fine either way; it neither caused nor prevented meaningful gain/loss in this one instance.

---

## 9. Consensus Quality Analysis

Confidence-band distribution of today's live `transaction_traces.consensus_score` (DATA):

| Band | Count |
|---|---:|
| 0.00–0.09 | 559 |
| 0.10–0.19 | 167 |
| 0.20–0.29 | 750 |
| 0.30–0.39 | 115 |
| 0.40–0.49 | 569 |
| 0.50–0.59 | 116 |
| 0.60–0.69 | 10 |
| 0.70–0.74 | **1** |
| 0.75–0.84 | 0 |
| 0.85–1.00 | 49 (all NVDA risk-exit) |
| null (no score recorded) | 499 |

Agent-count agreement, by `contributing_agents` pattern (top patterns, DATA): the dominant patterns are 2-3-agent combinations (e.g. `KronosEngine+ConsensusDebate+ChiefTraderAgent`=757, `TechnicalAgent+ChiefTraderAgent`=315, `KronosEngine+TechnicalAgent+ConsensusDebate+ChiefTraderAgent`=225). **None of these multi-agent combinations ever reached the 0.75-0.84 band** — every single approval today is the 0.85 risk-exit shortcut (1 agreeing agent, min-2 explicitly waived by design for exits). There is exactly **one** near-miss at 0.70-0.74 (1 row) — the closest any BUY-side idea came to clearing threshold today.

**Does higher confidence correlate with better subsequent counterfactual outcome?** **Cannot be assessed — INSUFFICIENT DATA.** With zero organic BUY-side approvals and only one exit (which used the confidence-agnostic risk-exit shortcut, not the graded consensus math), there is no population of graded-confidence-approved trades to check against outcomes. This question requires either (a) intraday-bar-backed counterfactuals across the VETO population (not done this pass, see §8) or (b) more organic trades over time.

---

## 10. Agent Performance Comparison

Per-agent signal stats today (live only, DATA, `agent_reasoning_logs` / `agent_predictions`):

| Agent | Signals | Side split | Avg confidence | Availability |
|---|---:|---|---:|---|
| ChiefTraderAgent | 2,230 | 2,181 VETO / 49 APPROVE | 0.26 (VETO) / 0.89 (APPROVE) | HEALTHY (deterministic gate math) |
| KronosEngine | 1,465 | 1,199 SELL / 266 BUY | 0.85 (SELL) / 0.84 (BUY) | HEALTHY, but heavily direction-skewed (82% SELL) |
| TechnicalAgent | 861 | 841 BUY / 20 SELL | 0.60 (BUY) / 0.75 (SELL) | HEALTHY, deterministic |
| FundamentalAgent | 179 | 179 HOLD | 0.00 | Nominal, non-contributing |
| MacroAgent | 143 | 143 HOLD | 0.00 | Nominal, non-contributing |
| PortfolioManager | 49 | 49 SELL (all NVDA risk-exit) | 0.85 | HEALTHY (single-symbol, single-condition) |
| RiskAgent | 50 | 49 VETO / 1 APPROVE | 0 (VETO) / 1.0 (APPROVE) | HEALTHY, deterministic |
| OpportunityScreener | 8 | 8 BUY | 0.55 | Newly active today (config flag added, §2) |

**Agent-combination comparison (incremental information value, not a "winner" — sample too small for that):** every observed multi-agent combination this session failed to clear consensus. The only approval bypassed the graded-confidence math entirely (risk-exit shortcut). This means **today's data cannot show whether adding KronosEngine, ConsensusDebate, or News to Technical improves outcomes** — there is no approved multi-agent BUY to compare. The one thing observable: solo-Technical-only ideas (315 at confidence ~0.24 per the terminal-reason buckets) and solo-Kronos-plus-debate ideas (757, similarly low) both cluster well under 0.75 — consistent with the prior audit's finding that single- or dual-agent agreement structurally cannot clear the 2-independent-agent-minimum + 0.75 bar for BUY-side ideas under current signal quality.

---

## 11. Strategy Performance

| Strategy | Signals seen | Approved | Rejected | Actual trades | Label |
|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | Cited on the one NVDA exit's reasoning text (contaminated historical value, §6/§16) | 1 (the NVDA exit) | — | 1 (exit only; not an organic entry) | **INSUFFICIENT DATA** — the "strategy" label on the one real trade describes a stale historical artifact, not a genuine live strategy-attributed entry |
| All 5 CORE quant strategies (MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION, MEAN_REVERSION, TREND_FOLLOWING, RANGE_REVERSION) via live QuantSignalAgent | 1,061 `quant_assessments` evaluated today | 0 | — (never reached idea-emission) | 0 | **INSUFFICIENT DATA / UNDERPERFORMING-BY-SILENCE** — `emitted_trade_idea=0` on every single row today; the regime engine runs real math but nothing downstream fires |
| TechnicalAgent (RSI/MACD/Bollinger, not a "quant strategy" per se but the dominant idea source) | 861 | 0 (never cleared consensus alone) | 861 | 0 | **UNDERPERFORMING** in the narrow sense of "never produces an approved trade alone," though this reflects the consensus gate design (min-2-agents), not necessarily bad signal quality |

No strategy this session can be labeled PROMISING with real evidence — sample size is zero-to-one across the board.

---

## 12. No-Trade Quality Scorecard

- **The 0.75 / min-2-agents bar:** cannot be judged "too strict" or "appropriate" from this data — no counterfactual evidence exists showing what would have happened had a sub-threshold BUY idea actually been filled (§8/§9 limitations). What is verifiable: it is being applied consistently and correctly (DATA — every VETO traced to a real confidence/agreement computation, not a crash or silent drop).
- **SAFETY REJECTION vs INFRASTRUCTURE-CAUSED MISSED OPPORTUNITY**, explicitly separated:
  - **SAFETY REJECTION (correct, by design):** the 2,181 ChiefTrader VETOs (consensus math working as documented); the 21 news_veto blocks (direction-blind veto correctly firing, matching `newsVetoMinImpactScore`/`newsVetoWindowMs` config); the 1 manual-override capital-allocation rejection (correctly enforcing `settings.budget=$2000` against a $2,850 request); the 1 sell_position_exists rejection (correctly refusing to double-sell a position the broker no longer held).
  - **INFRASTRUCTURE-CAUSED (real, but not obviously "missed opportunity" in dollar terms today):** BullResearcher/BearResearcher's near-total failure (§3) means the Bull/Bear research contribution to any consensus decision was effectively absent all day; ExplainabilityAgent fully down; one of two ConsensusDebate providers fully down. Whether any of these degraded providers would have flipped a VETO to an APPROVE cannot be determined from this data (they contribute evidence/weight, not a hard override, per CLAUDE.md) — flagged as a real gap in system capability, not a demonstrated missed trade.

---

## 13. Market Regime Analysis

Using real `quant_assessments.regime` output today (DATA, `RegimeEngine.ts` — indicator math verified plausible: real SMA/EMA/ADX/ATR/Bollinger/Keltner values, not placeholders):

| Symbol (sample) | Regime | Confidence | Volatility |
|---|---|---:|---|
| GLD | SIDEWAYS_RANGE | 0.8 | LOW |
| SMH | BEARISH_TREND | 0.4 | NORMAL |
| XLF | BULLISH_TREND | 0.8 | LOW |
| XOM | BULLISH_TREND | 0.8 | LOW |
| JPM | BULLISH_TREND | 0.8 | LOW |

**No strategy-vs-regime alignment causal claim can be made** — since 0/1,061 quant assessments emitted a trade idea today (§11), there is no approved-or-rejected quant trade to check against these regime labels. NVDA itself was not scored by `quant_assessments` in the reviewed sample (its exit came from the older, PortfolioMonitor-embedded quant-target mechanism, not a fresh regime-classified quant idea). **This section is therefore mechanically confirmed (the regime classifier works and outputs sane numbers) but causally NOT VERIFIED** for "which strategies were aligned vs fighting the regime," because there is no strategy activity to compare.

---

## 14. RiskEngine Quality

Live-only (50 assessments), gate-by-gate, DATA (`risk_gate_results` joined to today's live `risk_assessments`):

| Gate | Evaluations | Passed | Failed |
|---|---:|---:|---:|
| emergency_stop | 50 | ~43 | 7 |
| autobot_enabled | 50 | 50 | 0 |
| same_symbol_cooldown | 50 | 50 | 0 |
| post_loss_cooldown | 50 | 50 | 0 |
| daily_trade_limit | 50 | 50 | 0 |
| duplicate_signal | 50 | 50 | 0 |
| invalid_account_equity | 50 | 50 | 0 |
| daily_loss | 50 | 50 | 0 |
| consecutive_loss | 50 | 50 | 0 |
| portfolio_drawdown | 50 | 50 | 0 |
| order_rate_limit | 50 | 50 | 0 |
| **market_hours** | 50 | ~31 | ~19 |
| data_freshness | 50 | ~50 | ~0 |
| **news_veto** | 50 | ~29 | **21** |
| price_validity | 50 | 50 | 0 |
| order_notional_cap | 50 | 49 | 1 (n/a — SELL exempt path) |
| sufficient_size | 50 | 50 | 0 |
| symbol_concentration / sector_concentration / correlation_exposure / open_positions_cap | ~44 (skipped/n-a for pure SELL-exit rows) | all pass | 0 |
| sell_position_exists | ~49 (BUY rows omit it) | 48 | 1 |
| **argus_capital_allocation** | 50 | 49 | **1** |
| daily_buy_notional | 50 | 50 | 0 |

*(Counts above are reconstructed from the split-by-replay query joined on the `emergency_stop` gate row per trace; small (±1) rounding is possible where a trace had a partially-recorded gate set — noted as CALCULATED-from-DATA rather than a raw single query output.)*

**news_veto focus:** all 21 failures are NVDA SELL, spanning 15:24Z–16:20Z (7 distinct evaluation cycles roughly every 5 minutes, matching PortfolioMonitor's re-emission cadence). Reasoning text: "High volatility news event detected, overriding AI decision." — direction-blind as documented. `matchingClusters` was ≥3 at the blocked evaluations and dropped to 0 by 16:25:47Z, i.e. the veto genuinely expired/cleared rather than being bypassed (DATA, gate `detail` JSON). Subsequent market behavior after the veto lifted: see §8 — price was essentially flat (±$0.03) at the moment the veto cleared, then drifted mildly upward over the next 30-60 minutes. **No recommendation to weaken this gate is made or implied.**

**No gate is recommended for weakening anywhere in this audit.**

---

## 15. Execution Quality

One organic PAPER order reached the broker this session. It is not a statistically meaningful sample, but it is real and clean:

- Submit → Accept: **176ms** (16:25:47.338Z → 16:25:47.514Z)
- Accept → Fill: **~19 seconds** (16:25:47.514Z → 16:26:06.363Z)
- Fill: complete, single fill row, `cumulative_quantity=1` matches order `quantity=1` (P0.4 satisfied, no duplicate-watermark issue)
- Signal-vs-execution price difference: the RiskEngine gate recorded `currentPrice: 216.78` at approval (16:25:47Z); actual fill was `216.85` — a **$0.07/share** difference over the ~19-second submit-to-fill window (CALCULATED), consistent with normal market movement, not slippage in any adverse-execution sense
- Reconciliation accuracy: **degraded immediately after this fill** — see §17 for the local-portfolio-lag finding that produced a real (if transient) mismatch and a ~14.5-minute trading pause

Given n=1, this cannot be generalized into an "execution quality score" with statistical meaning, but unlike a total absence of orders, this is real, directly observed OMS behavior — not "EXECUTION QUALITY NOT TESTED." I score it 78/100 in §19 specifically because the one real execution was clean end-to-end, discounted for the reconciliation side-effect it triggered.

---

## 16. Comparison With Previous Audits

Against `docs/audits/archive/ARGUS_LIVE_NO_TRADE_FORENSIC_AUDIT.md`, `docs/audits/archive/ARGUS_NO_TRADE_REMEDIATION_STATUS.md`, and `docs/audits/archive/ARGUS_PHASE2_FORENSIC_AUDIT.md`:

1. **Kronos fail-closed fix:** Phase 2 said CONFIRMED FIXED. Today's data is consistent — KronosEngine remained active and voting all day with the Chronos service reachable (RUN, soak-script output); no `KRONOS_UNAVAILABLE`-during-vote pattern was found in today's data. **RUNTIME-CONSISTENT with the fix.**
2. **NVDA target-provenance fix ("CONFIRMED FIXED AND TESTED 16/16" per Phase 2):** **Runtime evidence is a genuine, narrow exception, not a contradiction.** Every single NVDA PortfolioManager cycle *today, from 12:42Z through 16:30:45Z* — i.e., including several cycles that ran hours before this trade's 16:25-16:26Z fill — still emitted the old contaminated reasoning ("target reached: $2xx.xx >= $121.90"). Cross-checked against the fix itself: `src/server/services/PortfolioMonitor.ts`'s `resolveOpeningTradeForLiveExit()`/`isValidLongQuantTarget()` (CODE, current source) would **not** produce this output today, because NVDA's only valid (non-REPLAY) opening trade has `quant_target_price=NULL` — under current code this falls through to the generic percentage-based exit message, not the strategy-quoted one. The file's mtime is `2026-08-20 16:45:05 UTC` and its fix commit (`c8285f6f`) is `2026-08-20 17:46:51 UTC` — **both are after this trade's 16:25-16:26Z fill.** Conclusion: **this specific trade predates the fix's presence in the running process; it is the last live occurrence of the historical bug's effect, not evidence the fix failed.** Practically moot going forward since the NVDA position is now fully closed (portfolio shows only GLD).
3. **Quant/Alpaca 429 handling ("PARTIALLY FIXED — no request-dedup cache" per Phase 2):** consistent with today — 1,061 quant_assessments ran without any 429-cascade signature in the sampled data, but no new evidence either way on the dedup-cache gap specifically (not independently re-tested this pass).
4. **News tick-success telemetry (fixed in Phase 2's own pass):** consistent — 523 `news_clusters` created today with no `lastSuccessfulTickAt=null` symptom re-observed (not independently re-queried against the pipeline-agents API this pass, but the clustering volume is real DATA of genuine activity).
5. **New finding not in any prior audit:** the `trades.profit_loss = NULL` / `activeBroker.positions()` silent-catch defect (§6, §17) — this is a **previously undocumented, currently-live gap**, only exposed now because it's the first session with a real fill to expose it.
6. **New finding not in any prior audit:** the transient local-`portfolio`-table lag after a real fill causing a reconciliation mismatch and a ~14.5-minute auto-pause (§17) — likewise only observable now that a real fill occurred.
7. **Config change since the earlier same-day audit:** `ARGUS_OPPORTUNITY_IDEAS_ENABLED` went from MISSING to present in `.env` sometime today (§2), and `OpportunityScreener` is now actually emitting ideas (8 today) where the prior audit recorded zero.

---

## 17. Data Integrity Warnings

1. **DATA INTEGRITY WARNING — `trades.profit_loss` NULL on the only real FILLED SELL.** Root-caused to `OrderManagement.ts`'s silent `catch (e) {}` around the pre-trade `activeBroker.positions()` lookup (§6). Consequence: a naive run of `docs/sql/10_realized_pnl.sql` reports `sum_profit_loss: 0, sells_missing_pnl: 1` for NVDA — **understating** real P&L (~+$10) as zero, and the official soak counter (`organic_paper_soak_status.ts`) reports `closedTradeCount: 0` for the same reason, not because the trade doesn't qualify as organic on environment grounds (it does — `classifyTradeEnvironment` would return `PAPER`).
2. **DATA INTEGRITY WARNING — transient local `portfolio` state lag after a fill.** Reconciliation sequence (DATA): `16:29:41Z` matched (1) → `16:34:41Z` mismatched, `{"symbol":"NVDA","type":"MISSING_REMOTELY","localQty":1,"remoteQty":0,"approxDollarImpact":216.89}` → `16:39:41Z` matched again. A duplicate PortfolioManager SELL idea for NVDA fired at `16:30:45Z` (after the real fill) citing the same stale reasoning, which RiskEngine correctly rejected at `sell_position_exists` ("Cannot sell - no existing position in broker portfolio") because that gate checks the live broker, not the lagging local cache. **Exact code path causing the several-minute lag in the `portfolio` table itself is NOT VERIFIED this pass** (would require tracing the fill-to-portfolio-update pipeline beyond OMS) — the sequence and consequence (a correct fail-closed pause, never auto-resumed, resumed by operator 14.5 minutes later) are DATA-confirmed; root cause is a reasonable but unconfirmed inference.
3. **DATA INTEGRITY WARNING — two overlapping `session_id`s in `observability_events` (13:38:56Z–14:29:44Z window, `0da022d7…` and `1c0fa0a6…` running concurrently).** Consistent with a multi-writer artifact (DEF-18 class) previously documented; not independently root-caused this pass.
4. **Minor discrepancy, not integrity-threatening:** `agent_predictions` counts KronosEngine at 1,518 SELL / 320 BUY today, while `agent_reasoning_logs` counts 1,199 SELL / 266 BUY for the same agent/day. These are two independently-written tables (ReflectionEngine's prediction log vs the reasoning-log writer) and are not expected to match 1:1 by design, but the gap (≈300-400 rows) is large enough to flag rather than silently reconcile.
5. **REPLAY contamination correctly excluded, confirmed:** 729/779 raw `risk_assessments` today and 114 FILLED / 138 REJECTED `trades` today are `REPLAY` (Argus Historical Evaluation, MODE B) rows, correctly excluded from every "organic" figure in this report via the `emergency_stop` gate's `replay` flag and `execution_environment`/`trace_id` prefix checks. Naive unfiltered queries (e.g., raw `SELECT COUNT(*) FROM risk_assessments WHERE created_at >= today`) would badly overstate live activity (779 vs the real 50) — flagged explicitly so this isn't silently miscounted.
6. **Stale-target reasoning text is itself a data-integrity concern** even though the underlying trade decision was reasonable — see §6/§16 item 2. An operator or future auditor reading `trades.reasoning` for this order without this report's context would be misled about why the sale actually made sense (a real +4.8% gain vs. a fictitious -47% "target").

---

## 18. TradingAgents Comparison

**NOT ACTIVE — NO COMPARISON DATA.** No vendored TradingAgents source exists in the repository (confirmed by the prior two audits and consistent with a codebase-wide check this pass — no new integration files, flags, or `placeOrder` paths referencing TradingAgents were found). It remains inspiration-only per CLAUDE.md and README.

---

## 19. Final Performance Verdict

| Dimension | Score | Justification |
|---|---:|---|
| System reliability | 68/100 | Real fills work end-to-end; RiskEngine/OMS/reconciliation are fail-closed and correct. Docked heavily for: many short-lived process restarts in one day, the profit_loss silent-failure gap, and the transient portfolio-lag/reconciliation-pause. |
| Market data quality | 82/100 | Real intraday bars, real `data_freshness` gate passes, real regime-classifier math. Not a perfect score only because bar coverage stopped mid-afternoon (17:02Z) rather than continuing through close. |
| Agent availability | 46/100 | TechnicalAgent/Kronos/RiskEngine/OMS solid; BullResearcher/BearResearcher/ExplainabilityAgent near-total failure; one of two ConsensusDebate providers dead; NewsAgent's LLM scoring ~4% success. Roughly half the agent roster meaningfully degraded today. |
| Consensus quality | 74/100 | The math itself is working exactly as designed (0.75/min-2, direction-blind news veto, risk-exit exception correctly scoped) — scored on *correctness of mechanism*, not on trade volume. Docked for zero graded-confidence approvals ever reaching 0.75-0.84, meaning the mechanism, while correct, has not been observed to work end-to-end for a genuine multi-agent BUY. |
| Risk management | 90/100 | 20/20 gates evaluated and passed correctly on the one real trade; capital-allocation gate correctly blocked an oversized manual override; news_veto correctly direction-blind and correctly time-bound; never auto-flattened, never auto-resumed a pause. |
| Execution quality | 78/100 (n=1, explicit small-sample caveat) | Clean submit/accept/fill timing, correct fill ledger, no duplicate watermark — genuinely tested, not "NOT TESTED," but statistically meaningless at n=1. |
| Observed trading performance | **INSUFFICIENT DATA** | n=1 closed trade, entry leg non-organic, `profit_loss` field itself not even populated by the system's own tooling. |
| **Evidence of trading edge** | **NONE** | One data point, half of which (the entry) wasn't even an Argus decision, cannot support any edge claim under any reasonable statistical standard. Consistent with CLAUDE.md's own framing that empirical edge is not established. |

**What Argus did well today:** correctly refused ~2,181 sub-threshold BUY ideas; correctly and repeatedly blocked a risk-exit under an active news veto rather than bypassing it; correctly executed the one real risk-exit once the veto genuinely cleared, in a fast, clean OMS→broker round trip; correctly fail-closed a reconciliation mismatch into a pause rather than auto-resolving it; correctly rejected an oversized manual-override BUY at the capital-allocation gate.

**What Argus did poorly today:** silently lost the P&L figure on the one trade that mattered most to prove (a code gap, not a trading-logic gap); ran roughly half its AI-agent roster in a failed or severely degraded state for the entire session (dominated by `deepseek-r1:14b` timeouts); showed a multi-hour internal inconsistency where its own `portfolio` table disagreed with the broker right after a fill.

**Most important bug/weakness:** the `preTradeEntryPrice`/`profit_loss` silent-failure path in `OrderManagement.ts` (§6, §16, §17) — it directly undermines the system's own ability to know whether it is making money, on the one trade this whole audit is about.

**Most important success:** the full spine — TRADE_IDEA_GENERATED → ChiefTraderAgent (risk-exit approval) → RiskEngine (20/20 gates, including a genuinely-time-bound news veto) → OMS → real Alpaca paper fill — worked correctly, cleanly, and fail-closed at every checkpoint along the way, on the first real occasion it was asked to.

---

*End of audit. Report path: `ARGUS_POST_MARKET_PERFORMANCE_AUDIT_2026-08-20.md` (repo root).*
