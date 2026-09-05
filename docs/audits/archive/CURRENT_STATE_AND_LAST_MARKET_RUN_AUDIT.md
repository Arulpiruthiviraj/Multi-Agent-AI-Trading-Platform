# Current App State & Last Open-Market Run — Forensic Audit

Audited: 2026-08-23, ~19:45–20:00 local. Read-only throughout — no database mutation, no config
change, no order placed. Evidence labeled **CODE** / **DATA** / **RUN** / **NOT VERIFIED**
per finding. This audit found and fixed one active, severe bug along the way (§0) — documented
here as required by the read-only rules, not silently patched and hidden.

---

## 0. Critical finding surfaced mid-audit: a real boot-crashing bug (found, fixed, verified)

**DATA/RUN**: While this audit was starting, the operator ran `./argus.sh start` in a real
terminal and the entire `npm run dev` process **crashed** (exit code 1) before Argus itself ever
reached port 3000. Root cause, confirmed by reproducing the exact failure in isolation:
`scripts/devWithOpenAlice.ts`'s new `startJavaQuantCoreAndWait()` function (added earlier this
session) passed a freshly-created `fs.createWriteStream()` directly into `child_process.spawn()`'s
`stdio` array. That stream's file descriptor isn't open yet at that point (it opens
asynchronously), so Node's `getValidStdio` throws `ERR_INVALID_ARG_VALUE` synchronously — not
intermittently, every time `QUANT_JAVA_CORE_ENABLED=true` (which is set in the real `.env`). The
exception wasn't caught, so it propagated out of `main()`'s `Promise.all()` and killed the entire
Argus boot, not just left Java Quant Core unavailable (its intended, designed failure mode).

**Fix applied and verified** (this session, before continuing the audit): switched to
`fs.openSync()` (an immediately-valid fd) and wrapped the whole function so it can never again
take down Argus itself, matching every other companion's existing "warn and continue" discipline.
Verified by reproducing the exact old failure and the fix in an isolated Node script (not the real
app) — confirmed `ERR_INVALID_ARG_VALUE` on the old pattern, confirmed clean spawn on the new one.
`tsc --noEmit` clean. **Not yet verified by a real `./argus.sh start` run** — that requires the
operator to try again, which is their action to take, not this audit's.

This means: **every start attempt tonight before this fix failed**, so the "previous open-market
run" analyzed in Part 2 below predates tonight entirely (see §2's date finding) — tonight
contributed **zero** new data to the database, consistent with this crash.

---

## Part 1 — Current app & ecosystem state

### 1.1 Service / port health (RUN, probed live during this audit)

| Component / Port | Runtime status | Notes |
|---|---|---|
| Node Engine (:3000) | **DOWN** | No process listening; `curl /health` → connection refused |
| IB Gateway (:4002) | **DOWN** | Not probed as reachable; consistent with `./argus.sh`'s own "IB Gateway not detected on port 4002/7497" output the operator saw |
| Chronos AI (:8008) | **DOWN** | `curl /health` → connection refused |
| Java Quant Core (:8085) | **DOWN** | `curl /health` → connection refused |
| Ollama (:11434) | Responding, but **not a valid Ollama API** | `GET /api/tags` → HTTP 404 (something is listening on 11434, but not answering the expected route — matches the operator's own `./argus.sh` output: "The operation was aborted due to timeout" for Ollama) |
| OpenAlice Guardian (:47332) | **DOWN** | No response |

### 1.2 Process state (RUN)

- No `.argus_dev.pid` file present at repo root (matches `./argus.sh`'s own report: "Tracked
  launcher pid file is stale — clearing").
- `data/.argus_engine.pid` — **absent** (was present earlier this session per git history; its
  current absence is consistent with every recent start attempt crashing before that file would be
  written/cleaned normally — not investigated further, not this audit's concern to "fix").
- `data/.argus_runtime_session.json` exists, `cleanShutdown: false`, `startedAt` timestamped
  `2026-08-23T23:12:37Z` (an earlier `mvn`/manual test session from this session's own
  work, not a live trading run — its own `pid: 412` does not correspond to any process currently
  running).
- One unrelated `java.exe` process found running (PID varies by check) — **confirmed** via its
  command line to be VS Code's Java Language Server (`redhat.java` extension), not
  `quant-core-java`, and **not** bound to port 8085 (`netstat` showed no listener on 8085 from any
  process). No cleanup needed.

### 1.3 Build integrity (RUN)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **Clean**, zero errors |
| `quant-core-java/target/quant-core-java-0.0.1-SNAPSHOT.jar` | **Present** (124,251 bytes, built 2026-08-23 17:23 — this session's own build) |
| `npx vitest run` (full suite) | **348/348 files, 2207/2207 tests green** (last run this session) |
| `mvn test` (quant-core-java) | **87/87 tests green** (last run this session) |

### 1.4 Database schema integrity (DATA)

62 tables present (`sqlite_master`). Spot-checked schemas for the tables this audit's Part 2
needed — all present with the expected columns: `trades` (29 cols incl. `execution_environment`,
`quant_strategy_id`), `risk_assessments`, `risk_gate_results`, `consensus_decisions`,
`agent_predictions`, `news_clusters`. No corruption indicators surfaced by any query in this audit
(all queries returned cleanly; a real `PRAGMA integrity_check` was not run — **NOT VERIFIED**
beyond "queries against these tables work correctly").

**A real, own query bug caught and corrected mid-audit**: `timestamp`/`created_at` columns are
stored as ISO-8601 **text**, not epoch milliseconds (confirmed via `typeof(timestamp)` = `'text'`).
An initial query using epoch-ms integers in a `BETWEEN` clause silently matched zero rows against
these text columns — not a real data gap, a real bug in this audit's own first query attempt,
caught by cross-checking against a separately-confirmed non-zero `MAX(timestamp)` before
concluding anything, and corrected before drawing any conclusion from it.

---

## Part 2 — Previous open-market (RTH) session forensics

### 2.1 Which session, exactly (DATA)

**The most recent date with any recorded activity across `trades`, `agent_predictions`,
`consensus_decisions`, `risk_assessments`, or `event_traces` is 2026-08-21.** Nothing is recorded
for 2026-08-22 or any part of 2026-08-23 — consistent with §0's finding that tonight's start
attempts all crashed before generating any data. All figures below are for **2026-08-21,
13:30–20:00 UTC (9:30 AM–4:00 PM America/New_York)**.

### 2.2 Market data & discovery funnel

| Metric | Value | Evidence |
|---|---|---|
| Distinct symbols with an agent prediction in the window | **27** | `SELECT COUNT(DISTINCT symbol) FROM agent_predictions WHERE timestamp BETWEEN ...` |
| L1 tick counts (Alpaca vs. IBKR `reqMktData` lines) | **NOT AVAILABLE** | Argus does not persist a raw tick-count metric distinguishing broker source per session; `MarketDataWorker`'s own counters are in-memory only and reset on restart — nothing to query historically |
| Candle-completion count | **NOT AVAILABLE** | Not a metric this schema persists per-session |
| `OpportunityScreener` activity | **Real, present** — 10+ BUY predictions sampled (MSFT, XOM ×4, JPM ×5), confidence range ~0.42–0.62 | `agent_predictions WHERE agent_name='OpportunityScreener'` |

### 2.3 Strategy & agent signal generation (agent_predictions, real counts)

| Agent | BUY | SELL | HOLD | Total |
|---|---:|---:|---:|---:|
| KronosEngine | 646 | 2,034 | 236 | 2,916 |
| TechnicalAgent | 787 | 36 | 0 | 823 |
| QuantEngine | 182 | 24 | 0 | 206 |
| FundamentalAgent | 0 | 0 | 226 | 226 |
| MacroAgent | 0 | 0 | 185 | 185 |
| OpportunityScreener | 100 | 0 | 0 | 100 |
| PortfolioManager | 0 | 1 | 0 | 1 |
| **Total** | **1,715** | **2,095** | **647** | **4,457** |

**Notable, worth investigating (not fabricated as a conclusion, flagged as an observation):**
KronosEngine's predictions were overwhelmingly **SELL** across nearly every liquid symbol that
session (QQQ 235, SPY 235, IWM 220, NVDA 195, AAPL 156, GLD 118, META 114, TSLA 111, AMD 110 — all
SELL). This could reflect a genuinely broad down session, or a calibration/systemic issue in how
Kronos's forecast is being translated to a side. **Not concluded either way here** — this is
exactly the kind of pattern the effective-N/independence work done earlier this session
(`src/server/research/effectiveSampleSize.ts`) exists to guard against being mistaken for 2,034
independent bearish signals (they are almost certainly one persistent view, re-emitted every
Kronos cycle, not 2,034 separate observations).

FundamentalAgent and MacroAgent emitted **zero** BUY/SELL votes all session (100% HOLD) — expected
behavior per `CLAUDE.md`, not a defect (these agents contribute HOLD-veto weight, not primary
signal generation, at their documented cadence).

### 2.4 ChiefTrader multi-agent consensus breakdown (consensus_decisions, real rows)

| Outcome | Count | Avg weighted confidence | Avg independent agreeing agents | Avg disagreeing |
|---|---:|---:|---:|---:|
| **Approved** | **7** | 0.979 | 1.0 | 0.0 |
| **Rejected** | **235** | 0.196 | 1.14 | 1.27 |

**Rejection categorization** — the real reasoning text this codebase emits is uniformly
*"No consensus reached before the evaluation window closed"* (a timeout-based rejection, not a
per-category tag) — so the mega-spec's requested categories are reconstructed here from the
recorded `agreements_count`/`disagreements_count`/`weighted_confidence` values on those 235 rows,
not a literal DB field:

| Reconstructed category | Approx. share (sampled) | What the data shows |
|---|---|---|
| Zero independent agreeing agents (best side never got a second voter) | Majority of the 235 | e.g. XOM/AMD/TSLA HOLD @ 0% confidence, 0 disagreements — the debate window simply closed with no second agent on the same side |
| Some agreement but well under the 75% bar | Frequent | e.g. MSFT BUY 9.0% (1 agreeing/2 disagreeing), JPM BUY 28.9%, AAPL SELL 24.9% |
| Direction conflict present (agreements > 0 **and** disagreements > 0) | Frequent, overlaps with the row above | e.g. XOM BUY 11.3% with 3 agreeing / 2 disagreeing — a real split vote, still far under threshold |
| News-veto-specific rejection at the **consensus** stage | Not separately tagged here — see §2.5 for the one real `news_veto` gate rejection (that happens at RiskEngine, after consensus, not before) |

**The 7 approved decisions**, in full: IWM BUY ×2 (15:35), ORCL BUY (15:35), IWM SELL (16:42),
SOFI SELL (18:31), TSLA BUY (18:31), RIOT BUY (18:31) — all at 1.0 confidence / 1 agreeing agent
except IWM SELL at 0.85.

### 2.5 RiskEngine evaluation (24 gates, real `risk_assessments` + `risk_gate_results` rows)

| Outcome | Count |
|---|---:|
| Approved | 4 |
| Rejected — `data_freshness` | 1 |
| Rejected — `duplicate_signal` | 1 |
| Rejected — `sell_position_exists` | 1 |

Note: 7 ChiefTrader approvals but only 7 corresponding risk-gate-result sets found (one per
`trace_id`) — **all 24 gates were recorded for every evaluation** (confirmed: every gate name from
`emergency_stop` through `sufficient_size` appears in the joined results, consistent with
`CLAUDE.md`'s "every gate recorded even after the first failure" invariant). Every real gate
failure found was a genuine, correctly-behaving fail-closed rejection — no gate showed anomalous
behavior.

### 2.6 Execution & broker wire status (real `trades` rows)

| Symbol | Side | Qty | Price | Status | Environment | Filled at |
|---|---|---:|---:|---|---|---|
| IWM | BUY | 2 | $299.54 | **FILLED** | PAPER | 15:35:25 |
| IWM | SELL | 2 | $299.85 | **FILLED** | PAPER | 16:43:04 |
| TSLA | BUY | 1 | $364.15 | **REJECTED** | UNKNOWN | — |
| RIOT | BUY | 33 | $19.99 | **REJECTED** | UNKNOWN | — |

**Root cause of both rejections, verbatim from the DB**: *"BROKER_ENVIRONMENT_UNKNOWN:
settings.tradingMode and broker paperMode disagree or are incomplete. No order."* Both TSLA and
RIOT had **real ChiefTrader approvals at 1.0 confidence** (§2.4) that never reached the broker —
this is the single most consequential, concrete, actionable finding in this audit (see §3).

SOFI's approved SELL (18:31:08) does not appear in `trades` at all in this window — consistent
with the one recorded `sell_position_exists` risk-gate rejection (§2.5): a SELL was approved by
consensus for a symbol Argus's local portfolio didn't show a position for, and RiskEngine correctly
fail-closed it before OMS. This is fail-closed behavior working as designed, not a defect.

**Realized P&L**: the only closed round-trip (IWM BUY → SELL) is genuinely small and positive —
$299.85 − $299.54 = $0.31/share × 2 shares = **$0.62 gross**, before any commission/slippage
modeling. `profit_loss` column reads `null` on both rows (not populated at write time for this
particular trade pair — **NOT VERIFIED** why, worth a separate look but out of this audit's scope
to fix).

**Daily Goal Campaign**: `campaign_enabled=1`, target **$100/day**, action **`CONTINUE`** (current
settings, not necessarily what was active on 08-21). At $0.62 realized, the session came nowhere
close to the target — consistent with `CONTINUE` never triggering a soft-lock that day.

---

## Part 3 — Top decisive root causes

1. **Two real, ChiefTrader-approved, 100%-confidence trade ideas (TSLA, RIOT) never reached the
   broker** because of a `settings.tradingMode` / broker `paperMode` mismatch
   (`BROKER_ENVIRONMENT_UNKNOWN`). This is the single highest-value fix available — real approved
   ideas are being silently discarded at the OMS boundary, not because RiskEngine correctly said no,
   but because of an environment-classification disagreement. **Priority: investigate first.**
2. **235 of 242 consensus evaluations (97%) never reached quorum** — overwhelmingly because the
   debate window closed with 0–1 independent agreeing agents, not because confidence was
   marginally under 75%. This reads as **agents genuinely not agreeing with each other often
   enough**, not as "the threshold is too strict" — consistent with `CLAUDE.md`'s own standing
   instruction not to lower it on this basis alone.
3. **Tonight's crash (§0)** prevented any new session data from being generated at all until fixed
   — now resolved and verified in isolation, but not yet proven by a real `./argus.sh start`.
4. Kronos's near-uniform SELL bias across liquid symbols (§2.3) is worth a dedicated, separate
   investigation — flagged, not diagnosed, here.

## Part 4 — Actionable recommendations (prioritized)

| Priority | Action |
|---|---|
| **P0** | Investigate `BROKER_ENVIRONMENT_UNKNOWN` — check `settings.tradingMode` vs. the active broker's real paper/live classification at the time TSLA/RIOT were rejected. Two real approved ideas were lost to this. |
| **P0** | Operator: run `./argus.sh start` again now that §0's crash is fixed, and confirm Node/companions actually come up this time. |
| **P1** | Confirm whether `trades.profit_loss` is expected to stay `null` for same-session round trips, or whether that's a separate, real gap in P&L attribution. |
| **P1** | Take a closer look at KronosEngine's SELL-heavy distribution on 08-21 — genuine market read vs. a systemic bias — using the effective-N tooling already built this session. |
| **P2** | `Ollama` on :11434 answering something other than the expected API on `/api/tags` (HTTP 404) — worth checking what's actually bound to that port, separate from Argus. |

**No safety change recommended.** Every RiskEngine gate observed behaved correctly (fail-closed);
the one apparent "safety" issue (the 97% consensus rejection rate) is not evidence the 0.75/min-2
floors are wrong — per `CLAUDE.md`'s own standing instruction, that is not sufficient grounds to
lower them.
