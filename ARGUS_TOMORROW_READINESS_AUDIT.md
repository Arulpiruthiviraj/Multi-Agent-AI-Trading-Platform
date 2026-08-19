# ARGUS — Current Architecture + Tomorrow Paper-Trading Readiness Audit

**Type:** Read-only forensic audit. No source, config, `.env`, database, or trading-state was modified to produce this report.
**Audit window observed:** live DB/process state as of **2026-08-19T03:10 UTC** (America/New_York ≈ 2026-08-18 23:10 ET, overnight/closed).
**Method:** direct read-only `better-sqlite3` queries (`{readonly:true}`) against `data/argus.db`, static source reading, `.env` file read, `git status`, process/port introspection (`netstat`, `wmic`, `tasklist`), one unauthenticated `curl /health`. Authenticated HTTP endpoints (`/api/v2/live-readiness`, `/api/v2/observability/metrics`) returned `401 unauthorized` — no credentials were used or guessed, so those two views are absent here; everything below is reconstructed from the database and files instead, which is a strictly stronger source per this audit's own rules (§2, runtime truth over file existence).

---

## 0. Bottom line

**Paper (supervised): mechanically runnable tomorrow, but not "genuinely ready" in the sense of a clean, understood system.** Three unresolved, undiagnosed anomalies from the last 36 hours would carry into a fresh boot unless someone looks at them first:

1. A **process-crashing idea-generation storm** (500+ ideas/min, 15k+ AI calls/min) happened once already (2026-08-18 19:29 UTC) and was stabilized with an operator-described "missing per-symbol debounce" fix — but no corresponding code diff was located in this audit's scope, so whether the fix is durable across a restart is **unverified**, not confirmed.
2. **Two portfolio-reconciliation mismatches of nearly identical size** (~$403.94 on 08-17, ~$403.20 on 08-18) each auto-paused trading. Both were manually resumed without a documented root cause in the kill-switch log. A third occurrence tomorrow is not ruled out.
3. An **unexplained 10-second EMERGENCY_STOP→TRADING_ENABLED cycle** at 2026-08-19T02:07:39–02:07:49Z has no reasoning text beyond "Manually triggered" / "reviewed current reconciliation evidence" — too short to have involved real review, and the cause (test? mis-click? scripted?) could not be determined from available records.

**LIVE remains `LIVE_NO_GO`** — not in question, not close, not audited further here since CLAUDE.md and `ARGUS_LIVE_READINESS.json` already settle it (6/28 mandatory gates, `tradingEdgeScore: 8/100`). One thing this audit adds: that 6/28 snapshot is **stale** (generated 2026-08-18T04:10Z) and was computed while `QUANT_DEFAULT` still passed because quant was off. The `.env` on disk **right now** has `QUANT_ENGINE_ENABLED=true` and all 14 experimental quant flags `true` — if `evaluateLiveReadiness()` were re-run today, `QUANT_DEFAULT` would very likely flip to FAIL, which would make it **5/28, not 6/28**. This is a real regression in the mandatory-gate count that nobody has re-certified.

---

## 1. Current runtime truth (not file-existence)

| Fact | Value | Source |
|---|---|---|
| Server process | PID 26068, listening on :3000 | `netstat -ano`, confirmed via `curl /health` → `200` |
| Process created | `2026-08-19T03:05:16Z` | `wmic process where "ProcessId=26068" get CreationDate` |
| `.env` last modified | `2026-08-19T02:56:38Z` (`2026-08-18T22:56:38-04:00`) | filesystem mtime |
| Relationship | PID 26068 started **~8.5 min after** the `.env` edit → **this running process loaded the current `.env` content**, including all experimental quant/multi-asset/penny flags | derived |
| Prior process | Crash cascade in `logs/argus-dev.log` ends ~03:02:55Z ("Argus-core exited code=1" → orchestrator stopped pid 21440/36784/9308) | log read |
| Interpretation | PID 26068 is a **fresh boot that already happened tonight**, not a long-lived process from earlier in the day. The crash cascade is 2.5 minutes before PID 26068's creation — consistent with a restart, not proof of a clean one. No crash.log entry was found to corroborate *why* the prior process exited 1 (P0.6's `crash.log` was not located/read in this pass — **gap**, not a conclusion either way). |
| `trading_state` | `TRADING_ENABLED` | `settings` row |
| `auto_bot_enabled` | `1` (ON) | `settings` row |
| `pipeline_agent_enabled_json` | all 6 agents `true` (Technical, News, Fundamental, Macro, Kronos, Quant) | `settings` row |
| `budget` | `$2000` | `settings` row |
| `max_trade_size` | `$3000` (binds before 20% symbol cap per CLAUDE.md) | `settings` row |
| `position_sizing_mode` | `FIXED_DOLLAR` | `settings` row |
| Open positions | GLD ×1 @ $387.97 (current $≈ unspecified), NVDA ×1 @ $206.85 (current $219.25 per latest snapshot) | `portfolio`, `portfolio_snapshots` |
| Most recent reconciliation | `2026-08-19T03:06:56Z`, `matches:1`, healthy — **and** a `portfolio_snapshots` row at `03:10:32Z`, i.e. reconciliation is actively cycling **right now**, not stale | `reconciliation_events`, `portfolio_snapshots` |
| `.env` safety posture | `PAPER_TRADING_ONLY=true`, `ARGUS_TRADING_MODE=PAPER` — correct, LIVE cannot arm | `.env` read |
| `.env` scope creep vs CLAUDE.md guidance | All 14 `QUANT_*_ENABLED` flags `true`, `QUANT_SMC_STRATEGY_ENABLED=true`, `ARGUS_MULTI_ASSET_ENABLED=true`, `ARGUS_PENNY_STOCK_ENABLED=true` — directly contradicts CLAUDE.md's "Do not enable flags to see if it works." This is a **currently loaded runtime condition**, not a hypothetical. | `.env` read |

**`git status`**: 131 lines of uncommitted changes spanning this entire multi-session work window (mine and a concurrent session's), plus untracked `scratch_exit_calib.mjs` (orphaned scratch file, harmless, not cleaned up per the read-only constraint). Nothing here blocks a boot; it just means "tomorrow" runs off working-tree state, not a committed snapshot — worth knowing if anyone wants to `git stash` and compare against last known-good.

---

## 2. Incident history (last 36 hours) — the part a readiness verdict can't skip

Read from `kill_switch_events`, newest-relevant first:

| When (UTC) | Transition | Actor | Reason (verbatim) |
|---|---|---|---|
| 08-19 02:07:49 | `EMERGENCY_STOP → TRADING_ENABLED` | admin | "Operator reviewed current reconciliation evidence and resumed via POST /api/v1/system/resume." |
| 08-19 02:07:39 | `TRADING_ENABLED → EMERGENCY_STOP` | admin | "Manually triggered emergency stop." |
| 08-18 19:30:46 | `TRADING_PAUSED → TRADING_ENABLED` | admin | "Operator reviewed current reconciliation evidence and resumed..." |
| 08-18 19:29:15 | `TRADING_ENABLED → TRADING_PAUSED` | admin | **"Emergency stabilization: idea-generation loop firing 500+ ideas/min and 15k+ AI calls/min for SPY/QQQ/IWM/DIA, saturating the event loop and crashing the process. Pausing to stop the bleeding while the missing per-symbol debounce is fixed."** |
| 08-18 17:22:35 | `TRADING_PAUSED → TRADING_ENABLED` | admin | "Reconciliation independently re-verified stable (7/7 clean cycles post-fix); resuming for controlled Phase 18 end-to-end paper-trading validation..." |
| 08-18 14:25:42 | `TRADING_PAUSED → TRADING_PAUSED` | gracefulShutdown | "Process shutdown drain — no new orders until restart recovery." |
| 08-18 13:06:44 | `TRADING_ENABLED → TRADING_PAUSED` | system:PortfolioReconciliation | **"Portfolio reconciliation found a ~$403.20 mismatch vs Alpaca - trading paused pending manual review."** |
| 08-18 04:09:05 | `EMERGENCY_STOP → TRADING_ENABLED` | admin | "Operator acknowledged and resumed from the emergency banner." |
| 08-18 02:06:37 | `TRADING_PAUSED → EMERGENCY_STOP` | admin | "Manually triggered emergency stop." |
| 08-17 11:23:43 | `TRADING_ENABLED → TRADING_PAUSED` | system:PortfolioReconciliation | **"Portfolio reconciliation found a ~$403.94 mismatch vs Alpaca - trading paused pending manual review."** |

Three things stand out under this audit's "do not assume previous fixes are working" rule:

- **The event-loop-saturation incident (19:29) is real and severe** — "crashing the process" is in the operator's own words. The described root cause (missing per-symbol idea-generation debounce) was not independently re-derived from source in this pass (out of scope for a DB-driven audit), so its fix status is **UNVERIFIED**, not confirmed. If it recurs on a fresh boot with 6 idea-producing agents all enabled plus quant/multi-asset/penny all on, the failure mode is not hypothetical — it already happened once.
- **The ~$403 reconciliation mismatch recurring twice, one day apart, at almost the same dollar figure**, is a pattern, not two unrelated events. Both were manually cleared without a recorded root-cause note (only "reviewed... and resumed"). Nothing in the DB says what caused either mismatch or why it's confidently resolved rather than merely re-hidden. `reconciliation_events` currently reads healthy, but DEF-23 in CLAUDE.md's own defect table already documents a related class of false-mismatch bug "not soak-proven on a real open" — this pattern is consistent with that still being live.
- **The 10-second EMERGENCY_STOP cycle (02:07:39→02:07:49)** has no incident description, unlike every other transition in the table. Ten seconds is not enough time for a human to have meaningfully "reviewed reconciliation evidence" as the resume reason claims. This reads like a smoke-test of the kill switch rather than a real stop — plausible, but **unconfirmed**, and it is the kind of ambiguous record that would concern an operator relying on this log as an audit trail.

None of this blocks a supervised paper session tomorrow. All of it means "tomorrow" inherits an active, not-fully-explained incident history from tonight, not a clean slate.

---

## 3. Full pipeline map — EXISTS / CONFIGURED / ENABLED / STARTED / RUNNING / PRODUCING / CONNECTED / REACHES-EXECUTION

Per stage, classified against the pipeline in CLAUDE.md §1 and the user's own diagram. "PRODUCING" and "CONNECTED" are judged from actual rows written in the last few hours, not from code presence.

| Stage | Exists in source | Configured | Enabled | Started (this boot) | Currently running | Producing real data (evidence) | Connected to next stage | Reaches order execution |
|---|---|---|---|---|---|---|---|---|
| **Bootstrap** | Yes | Yes (`.env` loaded per §1) | — | Yes, `03:05:16Z` | Yes (`/health` 200) | n/a | n/a | n/a |
| **Market Data (Alpaca WS)** | Yes | Yes | Yes | Started at boot per CLAUDE.md ("always") | Presumed yes — `portfolio_snapshots.current_price` for NVDA (`$219.25`) is fresher than `average_price`, implying live quotes are reaching the reconciliation path | Yes, indirectly (reconciliation depends on live broker price) | Yes | n/a |
| **Universe/Scanner/Opportunity Discovery** | Yes (`src/server/continuous/OpportunityDiscovery.ts`) | `ARGUS_OPPORTUNITY_LOOP_ENABLED=false` in `.env` | **OFF** | Not started (flag off) | No | No | N/A while off | No — architecturally cannot (never emits `TRADE_IDEA_GENERATED`, verified by `architecture.protection.test.ts`) |
| **Candidate Selection** | Bound to whichever agents are enabled (no separate "candidate selector" stage exists as distinct code) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **TechnicalAgent** | Yes | Yes | `true` (pipeline_agent_enabled_json) | Yes | Yes — **51,014 total predictions**, most recent `2026-08-18T20:58:33Z` (≈6h before this snapshot; market was closed for that whole gap, consistent with RTH-only ticks) | Yes, by far the most active agent (deterministic, no LLM) | Yes (feeds ChiefTrader) | Yes, structurally |
| **QuantSignalAgent / Quant CORE+experimental** | Yes | `QUANT_ENGINE_ENABLED=true`, all experimental flags `true` in current `.env` | Yes (per current `.env`) | Since 03:05Z boot | Ambiguous — `quant_assessments` has 614 total rows but the most recent is `2026-08-19T02:42:57Z`, which is **before** this boot (03:05Z). No `quant_assessments` row has been observed since the restart at the time of this audit. | **Not confirmed post-restart** — only ~5 minutes elapsed between boot and this snapshot, too short to rule out a longer cycle interval; genuinely indeterminate, not a negative finding | Yes structurally (`agent_predictions` has 1 QuantEngine row historically, well before this restart) | Yes structurally, but real evaluateAll() activity under the *current* flag set is unverified |
| **KronosForecastAgent** | Yes | Chronos `:8008` presumed reachable (not independently curl'd in this pass — **gap**) | Yes | Yes | Yes — 272 predictions total, most recent `2026-08-18T20:59:36Z` | Yes (pre-restart; RTH-gated like Technical) | Yes | Yes structurally |
| **FundamentalAgent** | Yes | Yes | `true` | Yes | Stale relative to now — last activity `2026-08-18T04:28:57Z` (~23h old), consistent with its documented ~60s cadence only firing on tracked symbols during active sessions, not a defect by itself | Yes (659 total predictions) | Yes | Yes structurally |
| **MacroAgent** | Yes | Yes | `true` | Yes | Same as Fundamental — last `2026-08-18T04:28:27Z` | Yes (527 total) | Yes | Yes structurally |
| **NewsEngine/NewsAgent** | Yes | Yes | `true` | Yes | **Materially stale — last activity `2026-08-13T01:37:42Z`, ~6 days before this snapshot.** This is the one agent whose "producing real data" answer is a clear **no** right now, independent of market hours. | 547 total predictions, all old | Ambiguous whether still wired — no recent evidence either way | Unconfirmed — cannot currently observe it reaching ChiefTrader |
| **ChiefTraderAgent (consensus/debate)** | Yes | Yes | Yes | Yes | Yes — `transaction_traces` shows continuous `ANALYZING`→terminal activity through `2026-08-18T20:59:36Z` (e.g., "Confidence 44.3% did not clear 75%" on SPY) | Yes | Yes | Yes, structurally confirmed (1 `FILLED` lifecycle status exists historically) |
| **RiskEngine (24 gates)** | Yes | Yes | Yes | Yes | Yes — 216 total `risk_assessments` rows, `211` rejected / `5` approved. Recent rejections are dominated by `duplicate_signal` and `emergency_stop` gate hits, both expected/fail-closed behavior, not defects | Yes | Yes | Yes |
| **OMS / BrokerManager / Alpaca Paper** | Yes | Yes | Yes | Yes | Only 4 `trades` rows exist **ever** in this database: 2 are `REPLAY` (AAPL round-trip, `execution_environment=REPLAY`, explicitly excluded from organic soak per CLAUDE.md), 2 are `"Imported during manual baseline reconciliation — real pre-existing Alpaca order, not an Argus-originated decision"` (GLD, NVDA). **Zero organic, Argus-originated, live-tick-driven trades exist in this database's entire history.** | Yes structurally | Reaches execution only via REPLAY or manual-import so far, never via the live idea→consensus→risk path in this DB's lifetime |
| **Fills** | Yes | Yes | Yes | Yes | Only **2** `fills` rows exist, both for the REPLAY AAPL trades. **The GLD and NVDA baseline trades have no corresponding `fills` rows at all** — they were inserted directly as `trades`, bypassing the fill ledger entirely, which is consistent with "imported baseline," not an OMS defect, but means P0.4's unique-fill-ledger guarantee has never actually been exercised by a real order in this database | Yes | n/a | n/a |
| **Portfolio / Reconciliation** | Yes | Yes | Yes | Yes | **Actively producing right now** — reconciliation checks and `portfolio_snapshots` rows are seconds old at the time of this audit (`03:10:32Z`) | Yes | Yes (feeds PortfolioMonitor) | n/a (never places orders itself) |
| **PortfolioMonitor / Exit-Sell decision** | Yes | `ARGUS_EXIT_INTELLIGENCE_ENABLED=false` (new engine off, as intended for an unvalidated addition); legacy take-profit/trailing-stop/thesis-invalidation checks are always active | Legacy checks: yes. New ExitIntelligenceEngine: no | Yes | Presumed yes (runs on ~60s timer per CLAUDE.md); no SELL-side risk_assessments were observed in the recent sample to directly confirm an exit was evaluated tonight | Not directly observed producing an exit decision in this snapshot window | Yes structurally | Yes, via the same ChiefTrader/Risk/OMS spine (only for full TAKE_PROFIT/EXIT/EMERGENCY_EXIT, not PARTIAL, per existing wiring) |

**AI routing layer** (cuts across News/Fundamental/Macro/ChiefTrader-debate): `ai_providers` table shows every cloud provider **disabled or offline** — Gemini `enabled:0`, most others `enabled:0`, NVIDIA `enabled:1` but `health:'Offline'`, `success_rate:10`, `last_success:null`. `observability_events` contains repeated `AI_PROVIDERS_EXHAUSTED` ERROR entries across the last 24h (at least 10 distinct occurrences sampled). CLAUDE.md's router-native default path is local Ollama, which this DB-only audit **cannot directly confirm is healthy** (no Ollama health probe was queried; the `ai_providers` table tracks the cloud-provider fallback chain, not Ollama specifically) — but the recurring `AI_PROVIDERS_EXHAUSTED` errors mean *something* in the routing chain is failing open to HOLD/confidence-0 with some regularity, per `AIOutputValidator`'s documented fail-closed behavior. This is a genuine gap in tomorrow's readiness picture that this audit could not fully close from the database alone.

---

## 4. Database evidence summary (organic soak, restated precisely)

- `trades`: 4 rows total, all `FILLED`. 2 REPLAY, 2 manually-imported baseline. **0 organic Argus-originated fills of any kind, ever, in this database.**
- `fills`: 2 rows, both belonging to the REPLAY trades.
- `consensus_decisions`, last 24h: 97 decisions, **0 approved** (`SUM(approved)=0`). Every recent decision terminated as "No consensus reached... Best side confidence below 75% threshold." This is fail-closed working as designed, not an error — but it does mean the consensus layer has not approved anything recently, so the risk/OMS layers below it are currently exercised only by rejections.
- `risk_assessments`: 216 total, 211 rejected / 5 approved (all 5 approvals trace to the same REPLAY session on 08-16).
- This matches CLAUDE.md's own stated ground truth exactly: **organic closed paper FILLED SELL P&L = 0 / 30 trades, 0 / 10 sessions, 0 / 30 calendar days.** Nothing in this audit contradicts that; it independently reproduces it from raw rows.

---

## 5. Direct answer to the question asked

**"If Argus is started fresh tomorrow morning and allowed to operate in PAPER mode under supervised autonomous operation, what EXACTLY will happen?"**

1. The process will boot with `PAPER_TRADING_ONLY=true` — LIVE cannot arm. Confirmed safe.
2. `TRADING_ENABLED` + `auto_bot_enabled=1` are already the persisted state, so a fresh boot resumes trading immediately without requiring a manual toggle — the operator should not assume a fresh boot starts paused.
3. All 6 pipeline agents will start. TechnicalAgent and Kronos will produce ideas as soon as ~30–50 ticks accumulate after market open. Fundamental/Macro will produce on their ~60–75s cadence for tracked symbols. **NewsAgent's most recent real activity is 6 days old** — whether it resumes cleanly tomorrow is unverified by this audit; worth an operator spot-check early in the session.
4. Quant will run with **all experimental strategies enabled** (not just the 5 CORE), because that's what `.env` currently holds and CLAUDE.md's own "do not enable flags to see if it works" guidance is currently being violated in the live config. Confidence for off-regime experimental strategies is discounted, not zeroed, per CLAUDE.md — so this isn't a silent no-op, it's genuinely more surface area than the documented default posture.
5. Given the 19:29 idea-storm incident already happened once under active multi-agent/multi-symbol conditions, and today's config is *more* permissive (quant+multi-asset+penny all on, vs. whatever was on when the storm occurred — not established here which flags were live at 19:29), there is a real, evidenced possibility of the same failure mode recurring, not a theoretical one. This is the single most important operational risk for tomorrow.
6. Reconciliation will keep running every cycle exactly as it is right now (essentially real-time). Given two ~$403 mismatches in two days, don't be surprised by a third — the operator playbook (never auto-flatten, never auto-resume, manual review) is being followed procedurally each time, but the recurring root cause has not been identified in any record this audit could find.
7. Consensus will very likely keep rejecting almost everything at the 75% threshold, exactly as it has for the last 24h (0/97 approved) — this is expected, fail-closed behavior, not a bug to fix before tomorrow.
8. LIVE stays `LIVE_NO_GO` all day, unconditionally. No action tomorrow changes that.

**Is it "genuinely ready"?** For supervised paper observation with an operator watching reconciliation and the idea-generation rate closely — yes, mechanically. For "start it and walk away" — no: the idea-storm root cause is unverified-fixed, the reconciliation mismatch has recurred twice without a documented cause, and the AI-provider layer is showing recurring exhaustion errors. None of these are new information relative to CLAUDE.md's own honesty about the system, but this audit adds three concrete, timestamped, unresolved incidents from the last 36 hours that a "start fresh tomorrow" decision should weigh explicitly.

---

## 6. Gaps in this audit (things not verified, stated honestly per this audit's own rules)

- Authenticated live-readiness/metrics endpoints were not queried (no credentials available/used) — everything here is DB-and-file-derived, which is strong but not identical to what the running process would self-report.
- `data/logs/crash.log` (P0.6's target) was not located/read in this pass — the true cause of the pre-03:05Z process exit(1) remains unconfirmed beyond "restart correlates with the `.env` edit timestamp."
- Ollama local-model health was not independently probed; only the cloud-provider fallback chain (`ai_providers` table) was inspected.
- Whether the "missing per-symbol debounce" fix referenced in the 19:29 kill-switch reason actually exists in the current source tree was not verified by reading the relevant idea-generation code — this audit is DB/log-first and did not re-open that investigation.
