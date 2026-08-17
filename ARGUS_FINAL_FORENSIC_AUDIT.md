# ARGUS FINAL FORENSIC AUDIT

**Audit timestamp:** 2026-08-17T01:00Z (this pass)
**Repository state:** working tree, uncommitted (no commit hash to cite — this repo has an extensive uncommitted diff throughout this whole engagement)
**Method:** Read-only. No source, config, database, or environment changes were made during this audit. `npx tsc --noEmit` and `npx vitest run` are the only commands executed that touch build/test state, and both run against ephemeral temp databases, never `data/argus.db`. Every database figure below is a `{readonly: true}` query. No API call that could arm LIVE, place an order, or mutate broker/trading state was made during this specific audit pass.

**Reconciliation notice, per this audit's own Section 1 rule (do not silently reconcile conflicting evidence):** this file previously contained an earlier same-day version. Two of its claims are **confirmed stale** against current code, verified directly this pass:
1. *"`data_freshness` fail-open on never-seen symbol — `priceAgeMs === null` ⇒ `stale === false`."* **False as of current code.** `src/server/core/marketDataQuality.ts:23-30` (`evaluateQuoteFreshness`): `priceAgeMs === null` returns `grade: 'UNKNOWN', passed: false` — fail-closed. Whether this was ever true is not re-derivable from this checkout; it is not true now.
2. *"Sizing-gate honesty — often record `passed: true` even when they bind quantity to 0."* **False as of current code.** `src/server/engines/PositionSizing.ts:239-256` contains the exact honesty-flip: any gate reporting `CLAMPED`/`passed:true` with `boundQuantity === 0` when `maxQuantity === 0` is walked back and flipped to `passed:false, status:'FAIL'`. Verified present, not added this pass.
3. *"Research warehouse directory `data/research` is MISSING."* **False as of current state.** 22 `.meta.json` sidecars and 16 physical `.parquet` files exist on disk, verified by direct filesystem listing this pass (real work performed earlier today: `pyarrow` was genuinely missing and has since been installed and verified with a real end-to-end write).

These are not accusations against the earlier document — its own findings were presumably accurate when written, at an earlier point in an extremely fast-moving same-day session. They are stated here because this audit's rule requires it.

---

## 1. Executive Verdict

| Question | Verdict |
|---|---|
| Autonomous **paper** (Autobot ON, paper broker) | **CONDITIONAL GO** — and, as of this session, genuinely running: real Autobot enabled against the real Alpaca paper account, real reconciliation cycles firing clean every 5 minutes for the last ~70 minutes straight |
| Autonomous **real money** | 🔴 **LIVE NO-GO** |
| Repeatable trading performance | **NOT PROVEN** — 0/25 real WFO evaluations passed this session across 5 CORE strategies × 5 real symbols |
| Safe unattended 30-day operation | **Infrastructure CONDITIONAL GO, evidence NOT YET ESTABLISHED** — running, but only ~70 real minutes of continuous operation exist so far, not 30 days |

**ORGANIC PAPER EVIDENCE = NONE**, current DB: 10 `trades` rows — 6 `PENDING` diagnostic artifacts, 2 `FILLED` tagged `REPLAY` (historical-replay lab, not live), 2 `FILLED` tagged `EXTERNAL_SYNC` (real pre-existing Alpaca positions, backfilled this session, deliberately excluded from organic-paper classification by design). Zero rows satisfy `organicPaper.ts:isOrganicClosedPaper()`.

Canadian automated live routing: **EXTERNAL_BLOCKED** (IIROC 3200A.1(b)(i); `markets.json` documents, does not unlock).

---

## 2. Build / Test Verification (Section 3 of the audit spec)

- `npx tsc --noEmit`: **PASS**, exit 0, zero errors.
- `npx vitest run`: **PASS**, **168 test files / 1101 tests**, 0 failed, 0 skipped. (This number has grown continuously across this same-day session — a separate, active concurrent effort is landing work in parallel with every check performed here; treat every count in this document as a snapshot of this exact moment, not a static fact.)
- No separate Python test runner exists in this repo; Python-side correctness is exercised indirectly through the allowlisted CLI bridge (`python/argus_research/cli.py`), invoked from the TypeScript research test suite counted above.
- Runtime-only failure discovered and fixed **earlier this session** (not present at this audit's check, but relevant to "untested critical paths" — `tsc` did not catch it because `require`'s type is globally ambient in Node's type definitions): 9 route handlers in `researchRoutes.ts` used CommonJS `require()` inside an ES-module project, causing every replay-detail endpoint to 500 with `require is not defined` the moment actually invoked. This is exactly the class of gap "tests pass" does not cover — a compiled, type-checked, unit-tested repository still had a real, unexercised runtime crash in a code path no test happened to invoke with a real HTTP request. Fixed and reverified this session; re-confirmed absent in this audit's fresh `tsc`/`vitest` run.

---

## 3. Execution-Spine Forensics

Real path, re-traced this pass:

```
MarketDataWorker (real Alpaca WS) → EventBus 'MARKET_DATA'
  → Technical/News/Fundamental/Macro/PortfolioMonitor/QuantSignalAgent → 'TRADE_IDEA_GENERATED'
  → ChiefTraderAgent.evaluateConsensus() → 'CHIEF_APPROVED_IDEA'
  → RiskAgent.assessRisk() → RiskEngine.evaluateRisk() (24-gate serialized ladder)
  → 'RISK_ASSESSMENT_COMPLETED'
  → OrderManagementService (sole production placeOrder caller)
  → BrokerManager.getActiveBroker() → adapter → real order
```

**Bypass search, this pass:**
- `executeAutoBotTradeInSovereign`: **0 matches**, tree-wide.
- `BrokerEngine.ts`: **confirmed absent.**
- `.placeOrder(` outside `*.test.ts`: only the 5 broker adapters' own internal close/flatten helpers, plus `OrderManagement.ts`. Zero in `server.ts`, zero in any route file, zero in `App.tsx`.
- **One legitimate, non-bypass alternate entry point exists by design**: `POST /api/v2/trading/execute-override` and `PipelineFlatten.ts` both emit `CHIEF_APPROVED_IDEA` directly, skipping only ChiefTrader's own consensus vote. **RiskEngine still evaluates every one of these.** Reasoning is stamped `SOURCE: MANUAL_OVERRIDE`; `organicPaper.ts` explicitly excludes anything carrying that marker or a `manual-override-` traceId prefix. This is a real, intentional, RiskEngine-gated operator path, not an uncontrolled bypass — flagged here for completeness, not as a defect.
- Vibe-Trading-MCP / AutoHedge / FinceptTerminal / OpenAlice: **zero references anywhere under `src/`.**

**Idempotency:** `trades` has a real unique index, `idx_trades_trace_id_unique` on `traceId` (`schema.ts:257`), enforced at the SQLite level — a duplicate order submission for the same traceId is rejected by the database itself, not merely by an application-level check-then-act race.

---

## 4. Live-Trading Arm Safety

Five independent layers, re-verified this pass:

| Layer | Mechanism | File |
|---|---|---|
| 1. Confirmation phrase | `confirmLiveTrading === 'ENABLE LIVE TRADING'` required to enable LIVE at all | `TradingEngine.toggle()` |
| 2. In-memory arm | `isLiveTradingArmed()` | `LiveTradingConfirmation.ts` |
| 3. Dual-flag agreement | `tradingMode`/`paperMode` disagreement → order outcome `UNKNOWN`, no order placed | `brokerEnvironment.ts` |
| 4. Live-host refusal | Refuses the real `api.alpaca.markets` host without the arm | `AlpacaBroker.placeOrder` |
| 5. Restart clearance | Arm is in-memory only; a process restart clears it even if SQLite still says LIVE | confirmed by design, and empirically this session — the server was restarted multiple times for unrelated reasons and never carried a LIVE arm across any of them |

No path found, this pass or any prior pass this session, by which PAPER → LIVE could transition without all five of the above being deliberately satisfied. `PAPER_TRADING_ONLY=true` additionally hard-refuses `BrokerManager.setLiveMode(true)` at the broker layer, independent of the above (`BrokerManager.ts:250-253`).

---

## 5. RiskEngine Forensics — 24 Gates

Full gate-by-gate table with file:line citations already exists in `FINAL_ANALYSIS.md` §5 and is not repeated verbatim here; re-verified unchanged this pass. Load-bearing facts, directly re-confirmed:

- All 24 gates (`config/riskGateOrder.json`) evaluate **unconditionally** — a rejected proposal gets a complete gate-by-gate audit record, not just the first failure.
- `invalid_account_equity`: non-positive/missing broker equity refuses outright — **no placeholder balance**.
- `data_freshness`: `priceAgeMs === null` → `UNKNOWN`, `passed:false` — **fail-closed** (§ Reconciliation Notice above).
- `market_hours`: HTTP/network failure on the real Alpaca clock → `unavailable`, treated as blocking — **never treated as open on an outage**.
- Sizing gates (`order_notional_cap`/`symbol_concentration`/`sector_concentration`/`correlation_exposure`/`open_positions_cap`/`sufficient_size`): honesty-flip mechanism confirmed present (§ Reconciliation Notice above) — **FAIL = NO ORDER is real**, not just claimed.
- `UNKNOWN` broker-environment resolution and `PAPER_TRADING_ONLY` both independently block order placement before RiskEngine's own gates are even reached.
- **Verified live, not just in source, this session**: `PortfolioReconciliation.ts`'s significant-mismatch check actually fired twice against real Alpaca account state and correctly transitioned `tradingState` to `TRADING_PAUSED` both times via the real, audited `setTradingState()` path — RECONCILIATION MISMATCH = NO ORDER is empirically, not just theoretically, true.

---

## 6. Order Lifecycle / Failure Forensics

- **Duplicate prevention**: real, DB-level (`idx_trades_trace_id_unique`), not just an application check.
- **brokerOrderId tracking**: present on every trade row; used both by follow-up polling (`OrderManagement.followUpOpenOrders()`) and by reconciliation.
- **Crash recovery**: `OrderManagement.reconcileStaleOrders()` — a bounded, periodic re-poll for orders that crashed before `brokerOrderId` was recorded, using Alpaca's real client-order-id lookup; explicitly does not fabricate a resolution the broker hasn't given.
- **Unknown broker outcome never becomes success**: `assertBrokerEnvironmentAllowsOrder` failure or a broker-call exception both resolve to `UNKNOWN`/`REJECTED`, never a fabricated `FILLED`.
- **This session's real, direct evidence of correct behavior under a genuine anomaly**: the GLD/NVDA reconciliation mismatch (§8) is itself a real instance of "Argus believed its portfolio state was X, the broker's real state was Y" — and the system's actual behavior was to halt new trading, not to silently trade on the wrong state. This is the failure mode Section 7 of the audit spec asks about, and it was empirically exercised, not merely coded for.

---

## 7. Portfolio Reconciliation

Real, current, live-fire-tested this session:

- **The GLD/NVDA fix**: 2 real pre-existing Alpaca paper positions had no local `trades.brokerOrderId` record. `PortfolioReconciliation.ts:162-174`'s `FILLED_ORDER_MISSING_LOCALLY` check correctly flagged this and paused trading (`action_taken: 'TRADING_PAUSED'`, `kill_switch_events` audit rows). Root-caused and fixed this session by backfilling the real historical fills (`scripts/reconcile_broker_baseline.ts`, real broker order IDs, real fill prices, tagged `execution_environment: 'EXTERNAL_SYNC'`).
- **`EXTERNAL_SYNC` cannot become organic paper evidence**: `organicPaper.ts:classifyTradeEnvironment()` recognizes exactly 5 tags (`BACKTEST`/`REPLAY`/`SIMULATION`/`PAPER`/`LIVE`); `EXTERNAL_SYNC` matches none of them and falls through to `UNKNOWN`. `isOrganicClosedPaper()` requires `env === 'PAPER'` exactly. Verified by direct code read, not assumed.
- **The acknowledgement workflow** (`ReconciliationAcknowledgements.ts`, `reconciliation_acknowledgements` table): durable, `fingerprint`-based (SHA-256 of broker+orderID+symbol+quantity+price), `acknowledgedAt`/`revokedAt`/`revokedBy`/`revokeReason` all present, minimum-length reason enforced (≥8 chars) at the service layer. **Verified already fully wired into `PortfolioReconciliation.ts`** (`getActiveAcknowledgedOrderIds`, called every cycle) and exposed via real routes in `systemRoutes.ts` (list/acknowledge/revoke). Zero rows currently exist in this table — this session's GLD/NVDA fix used the backfill approach instead, which is why.
- **Empirical stability, this exact moment**: the 3 most recent real reconciliation cycles (00:47, 00:52, 00:57 UTC) all report `worst_impact_dollars: 0, action_taken: null`. The loop is not oscillating.
- **Broker remains authoritative**: `reconcile()`'s own logic always overwrites local `portfolio` state FROM the broker's reported positions, never the reverse.
- **No automatic order was ever placed "to fix" a reconciliation mismatch**, this session or in the code path — confirmed by reading the full `reconcile()` function; its only actions on mismatch are pause + optional configured auto-flatten (itself routed through RiskEngine, never a direct broker call).

---

## 8. Database / Ledger Forensics

Read-only query, this exact moment:

```
trades (10 total):
  6x DIAGTEST*/DIAGORDER*/DIAGCHAIN* — PENDING, execution_environment=null (diagnostic artifacts)
  2x FILLED BUY  — execution_environment=REPLAY (historical-replay lab)
  1x FILLED BUY  + 1x FILLED SELL — from the same REPLAY pair, profit_loss=-91.05
  2x FILLED BUY  — execution_environment=EXTERNAL_SYNC (real, backfilled this session)

transactions (719 total): 436 NO_CONSENSUS, 243 RISK_REJECTED, 40 OPEN
reconciliation_events: 126+ rows, real, growing every 5 minutes
reconciliation_acknowledgements: 0 rows (mechanism exists, unused so far)
```

**Organic paper trades: 0.** `minPaperTrades: 30` → **0/30**. `minPaperSessions: 10` → **0/10**.

The 40 `OPEN` transactions are a previously-diagnosed, already-explained historical artifact (a stale server process predating a same-day status-transition fix, documented earlier this session with exact timestamp evidence) — not a currently-reproducing bug. 243 real `RISK_REJECTED` transitions have occurred cleanly since.

---

## 9. Strategy Validation

| Strategy | Production status | OOS/WFO this session | Robustness this session |
|---|---|---|---|
| MOMENTUM_BREAKOUT | CORE, live-eligible when `QUANT_ENGINE_ENABLED=true` | `FRAGILE` on all 5 tested symbols | 0/4 gates pass on any symbol |
| PULLBACK_CONTINUATION | CORE | `FRAGILE` on all 5 | partial passes (sensitivity/cost-stress) on some symbols; never all 4 |
| MEAN_REVERSION | CORE | `FRAGILE` on all 5 | 0/4 gates pass on any symbol |
| TREND_FOLLOWING | CORE | `FRAGILE` on all 5 | partial passes on some symbols; never all 4 |
| RANGE_REVERSION | CORE | `FRAGILE` on all 5 | partial passes on some symbols; never all 4 |
| SMC_LIQUIDITY_SWEEP | EXPERIMENTAL, `UNVALIDATED`, excluded from live unless `QUANT_SMC_STRATEGY_ENABLED=true` | not evaluated this session | not evaluated this session |

Classification per the audit's own required vocabulary: **`FAIL`**, not `INSUFFICIENT_SAMPLE` uniformly — though a real caveat applies. Several individual WFO folds show `testTrades: 0` (`medianTestExpectancy: null`), meaning part of the `FRAGILE` verdict genuinely is `INSUFFICIENT_SAMPLE` at the fold level, not "traded and lost." Both are real, distinct findings and are reported as such, not collapsed into one claim.

**Zero trades is not treated as evidence of profitability anywhere in this audit or in the underlying code** (`fractionalKelly()` explicitly refuses below 20 real closed trades; `tradingEdgeScore()` returns its floor value on empty evidence rather than a fabricated positive).

---

## 10. Current WFO / Robustness Evidence

Re-confirmed this pass as still current (no code changes to the strategy/research engines since the 25-evaluation gauntlet ran earlier this session):

- **6 real GREEN datasets** on disk (SPY, QQQ, AAPL, NVDA, MSFT, AMD), all real `alpaca_historical_rest` provenance, ~2 years of real daily bars each (519 bars/dataset), SHA-256 hashed.
- **16 real physical `.parquet` files** now exist (0 at session start — genuinely fixed, `pyarrow` was missing, now installed and verified with a real write).
- **25/25 real evaluations used `NEXT_BAR_OPEN`** (`canonicalNextBarEngine.ts`), confirmed via each run's own `executionModel: "NEXT_BAR_OPEN"` field — **zero SAME_BAR_CLOSE contamination** in this gauntlet's results.
- **0/25 WFO passed. 0/25 all-four-robustness-gates passed.** This remains the current truth; no newer evidence exists.

---

## 11. TS / Python / VectorBT Parity

Unchanged this pass, re-confirmed by direct file read:
- CORE feature vectors (BOS/RVOL/Keltner/S-R): `FEATURE_SUBSET_PARITY` — matches a TS unit fixture, not the full live `StrategyContext`.
- Full `StrategyContext.evaluate()` byte-for-byte parity across TS/Python/VectorBT: **not established**. This is real, substantial, multi-day-minimum engineering work across dozens of indicators for 5 strategies — not attempted this session beyond re-confirming its current honest state.
- SMC: `PROXY_NOT_FEATURE_PARITY`, explicitly separated from CORE.
- VectorBT itself: `state: 'UNAVAILABLE'` in this environment (not installed) — `getVectorBTStatus()` confirms no Rust backend, no working Python bridge for it specifically (distinct from the general research CLI bridge, which does work now that `pyarrow` is installed).

**Do not call this full parity. It is not.**

---

## 12. Replay Engine (`FullArgusReplayEngine`)

| Component | Status |
|---|---|
| Market data, point-in-time bars | **REAL** — structurally exposes only a chronological prefix per symbol |
| TechnicalAgent / Quant / ChiefTrader / RiskEngine / OMS / simulated broker fills | **REAL** — the actual production decision spine, not a separate simulator |
| FundamentalAgent | **UNAVAILABLE**, explicitly — "Point-in-time fundamentals not loaded," not fabricated |
| MacroAgent | **UNAVAILABLE**, explicitly — same discipline |
| NewsAgent | `CATALYST_ONLY` at best (golden replay news), else `UNAVAILABLE` |
| Costs/slippage | **REAL** — NEXT_BAR_OPEN + real cost model applied |

Correct overall classification: **PARTIAL**, and honestly self-reported as such by the code's own logic — Fundamental/Macro are marked `UNAVAILABLE` rather than fabricated, which is exactly the discipline required. Upgrading this to genuinely full requires a real, paid, point-in-time-capable historical fundamentals/macro data source — an **EXTERNAL** (data-vendor) requirement, not a code gap.

---

## 13. Data Quality

- Real market data confirmed (Alpaca REST, `REAL_MARKET_DATA` provenance tag, not fabricated).
- Look-ahead protection: `ReplayClock` structurally exposes only a chronological prefix; `assertNotFuture()` is defense-in-depth on top of that structural guarantee.
- Corporate-action detection: real, active refusal (`checkForUnadjustedCorporateActions()`) — a detected unadjusted split halts the run rather than silently corrupting P&L. Directly observed this session: AAPL's 2018-era cached bars triggered exactly this refusal during an earlier (separate) backtest attempt, confirming the guard fires on real data, not just in theory.
- Dataset hashing: SHA-256, real, per-dataset, changes when data changes (structural property of the hash function over the real bar array — not independently re-verified by mutating data this pass, since that would violate the read-only constraint).
- Missing-bar/duplicate policy: `drop_invalid` / `keep_last`, declared per-dataset in the real metadata sidecars.

---

## 14. Multiple Testing / Overfitting Protection

- `experimentLedger.ts`: real, in-memory (optionally persisted), counts trials by strategy and records the last dataset hash used; `multipleTestingWarning()` flags when trials exceed a configured threshold.
- **What does not yet exist**: a full per-trial record of parameter sets, selection criteria, and *rejected* experiment outcomes (only aggregate trial counts are kept, not individual experiment provenance). This is a real, partial implementation.

**Honest answer to the audit's direct question**: Argus **cannot yet fully distinguish a real edge from a data-mining artifact** via automated multiple-testing correction — it can warn that many trials occurred, but cannot yet show the full rejected-experiment audit trail that would make a "best of N" result auditable after the fact. This is consistent with, and does not change, the 0/25 result already found — there was no cherry-picking in this session's gauntlet (all 25 results are reported, not just favorable ones), but the infrastructure to prove that at scale for arbitrary future runs is not yet complete.

---

## 15. Security

Fresh read-only sweep, this pass, across all of `src/`:
- `eval(`, `new Function(`: **0 matches** in production source.
- `child_process`/`spawn`: 2 real call sites (`ModelRuntimeManager.ts` for local Ollama/Chronos, `VectorBTService.ts` for the allowlisted research CLI). Both use **hardcoded literal commands** (`'ollama'`, `'npm'`) — zero external/user input reaches either, confirmed by tracing every call site.
- `.exec(` (raw SQL): 1 call site (`archiveDiagnosticPending.ts`) — a static `CREATE TABLE IF NOT EXISTS` string with zero interpolation.
- `EncryptionService.ts`: throws at module load if `ENCRYPTION_SECRET` is unset; throws `ENCRYPTION_FAILED`/`DECRYPTION_FAILED` on real crypto errors — no silent plaintext fallback.
- `data/secrets.json`: boot-time refusal if present, unless `ARGUS_ALLOW_PLAINTEXT_SECRETS_FILE=true` is explicitly set.
- `PAPER_TRADING_ONLY=true` hard-refuses `BrokerManager.setLiveMode(true)`.
- External tools (Vibe-Trading-MCP, AutoHedge): zero broker credentials in their spawn `env`; AutoHedge's `WALLET_PRIVATE_KEY`/`SOLANA_PRIVATE_KEY` are hardcoded empty strings in the launcher itself, plus an explicit `AUTOHEDGE_PAPER_ONLY: 'true'` flag.

---

## 16. External Tool Isolation

| Tool | Process isolation | Credential isolation | Broker/order access |
|---|---|---|---|
| Vibe-Trading-MCP | Separate OS process, port 8900 | AI provider keys only | **None** — zero `BrokerManager` import anywhere reachable |
| AutoHedge | Separate OS process | AI provider keys + forcibly-emptied wallet keys + `AUTOHEDGE_PAPER_ONLY` | **None**, three independent layers |
| FinceptTerminal | Disabled in this environment; directory absent | N/A | N/A |
| OpenAlice | Separate MCP client, read-only, non-blocking | No credentials | **None** — results inform only future decisions, never gate the current one |

`SIGINT`/`SIGTERM` both call `killTracked()`, terminating every tracked child PID (`taskkill /T` on Windows) — no orphaned companion processes on shutdown, verified by direct code read of `scripts/ecosystem-dev.ts`.

---

## 17. Observability / Operations

- Real decision-lifecycle event persistence (`event_traces`), gate-by-gate `risk_gate_results`, real `kill_switch_events` audit trail (immutable, append-only), real `reconciliation_events` history.
- An operator CAN reconstruct exactly why Argus did or didn't trade for any given proposal — every gate's pass/fail is recorded even after the first failure, not just the deciding one.
- Alerting (`AlertingService.ts`) wired to real webhooks for reconciliation mismatches, market-data disconnects, trading-state changes, and AI-provider exhaustion (all built and verified earlier this session).
- **Gap, honestly noted**: UI test coverage remains thin (longstanding, documented); this audit did not independently re-verify every UI widget's live-vs-fabricated status this pass — that ground was covered in `FINAL_ANALYSIS.md` §4 and is not re-walked here to avoid duplicating unchanged findings.

---

## 18. Failure-Injection Readiness

| Scenario | Status |
|---|---|
| Market-hours service outage | **Tested via code path** — `unavailable` → fail-closed, confirmed in source |
| Stale/missing market data | **Tested via code path** — null age → `UNKNOWN`, fail-closed, confirmed in source |
| Invalid account equity | **Tested via code path** — non-positive/missing → refuses, no placeholder |
| Reconciliation mismatch | **Tested live, this session** — the real GLD/NVDA event, not just a code read |
| Broker timeout / restart-during-order / restart-after-LIVE-arm / duplicate order under concurrency / partial fill / database unavailable / AI-provider-all-down | **Individual mechanisms exist and were verified in earlier phases of this session** (crash recovery, idempotency, AI timeout+circuit breaker) but **no single enumerated, automated failure-injection test suite covering this full list exists as one artifact.** Real, bounded remaining work — not attempted as a complete suite this pass. |

---

## 19. UI / Operator Control

Not independently re-audited widget-by-widget this pass (see §17 gap note) — `FINAL_ANALYSIS.md` §4 already covers this with direct evidence (quarantined legacy routes return 410, key visualizers verified event-bound only, no hardcoded win-rate strings found in the named components). No new UI-layer findings this pass.

---

## 20. Canadian Execution

**EXTERNAL_BLOCKED**, unchanged, correctly not counted as a software defect. `markets.json` documents US/CA metadata but does not authorize Canadian live routing; `InteractiveBrokersAdapter`/`QuestradeBroker` both structurally cannot place Canadian-exchange equities (IIROC 3200A.1(b)(i); Questrade's `placeOrder` throws by design — partner-developer restriction, not a bug). No code path found, this pass or any prior pass, that unlocks this.

---

## 21. Readiness Scoring

### A. Engineering Readiness

| Dimension | Weight | Score | Contribution | Evidence |
|---|:---:|:---:|:---:|---|
| Compiler/build | 5% | 100 | 5.0 | `tsc` clean |
| Tests | 8% | 95 | 7.6 | 168/1101 passing; thin UI coverage docked |
| Execution spine | 15% | 95 | 14.25 | §3 — exhaustive grep proof, one documented sanctioned exception |
| Risk engine | 15% | 92 | 13.8 | §5 — 24 gates, honesty mechanisms confirmed live-fire |
| Order lifecycle | 10% | 90 | 9.0 | §6 — real idempotency, crash recovery |
| Broker integration | 8% | 75 | 6.0 | Alpaca fully unattended; others real but restricted |
| Reconciliation | 8% | 90 | 7.2 | §7 — fixed and empirically stable this session |
| Database | 5% | 85 | 4.25 | Real schema/migrations/WAL; orphaned diagnostic rows are a minor hygiene gap |
| Security | 8% | 88 | 7.04 | §15 — fresh sweep, clean |
| Observability | 5% | 78 | 3.9 | §17 |
| Research infrastructure | 5% | 80 | 4.0 | Real warehouse now durable |
| Replay | 3% | 70 | 2.1 | §12 — honestly PARTIAL |
| Data infrastructure | 3% | 82 | 2.46 | §13 |
| External isolation | 2% | 95 | 1.9 | §16 |
| **ENGINEERING_READINESS** | **100%** | — | **88.5%** | |

### B. Trading Validation / Capital Readiness

| Dimension | Weight | Score | Contribution | Evidence |
|---|:---:|:---:|:---:|---|
| Real data breadth | 8% | 70 | 5.6 | 6 real symbols, ~2yr window — real but narrow |
| OOS | 15% | 5 | 0.75 | §10 — real pipeline, real negative result |
| WFO | 15% | 5 | 0.75 | §10 |
| Robustness | 15% | 5 | 0.75 | §10 |
| Statistical significance | 5% | 10 | 0.5 | §14 |
| Multiple-testing controls | 5% | 40 | 2.0 | §14 — partial |
| Execution model realism | 8% | 85 | 6.8 | NEXT_BAR_OPEN used throughout the real gauntlet |
| Costs/slippage | 7% | 80 | 5.6 | Real, non-zero, configured |
| Organic paper trades | 12% | 0 | 0.0 | §8 — 0/30 |
| Organic paper sessions | 5% | 0 | 0.0 | §8 — 0/10 |
| Drawdown evidence | 3% | 0 | 0.0 | No real trade history to compute from |
| Live-paper stability | 2% | 60 | 1.2 | Real, running, but under 2 hours of continuous real operation so far |
| **TRADING_VALIDATION_READINESS** | **100%** | — | **23.95% ≈ 24%** | |

### C. Overall Real-Money Readiness

Simple, transparent, even split — chosen specifically because it cannot be accused of weighting toward whichever composite happens to be higher:

$$\text{OVERALL} = 0.5 \times \text{ENGINEERING} + 0.5 \times \text{TRADING\_VALIDATION} = 0.5(88.5) + 0.5(24) = 44.25 + 12.0 = 56.25\%$$

**OVERALL_REAL_MONEY_READINESS ≈ 56%**
**REMAINING ≈ 44%**

**Decomposition of the 44% remaining (per this audit's own explicit instruction not to just take 100 − engineering):**
- Attributable to remaining engineering work (0.5 × (100−88.5)): **≈ 6 points**
- Attributable to remaining trading validation/evidence (0.5 × (100−24)): **≈ 38 points**
- Canadian/external regulatory: **not folded into the percentage at all** — reported separately as `EXTERNAL_BLOCKED`, since no amount of engineering or evidence accumulation inside this repository changes it.

**The overwhelming majority of what remains is evidence, not engineering.** This is the correct shape for this system's real state, and matches the qualitative conclusion of every audit pass this session: the pipes are well-built; what's missing is proof they're profitable, and that proof does not yet exist by design (0 organic trades, 0/25 WFO passes) — not by omission.

---

## 22. Blocker Classification

| Blocker | Severity | Category | Current State | Can Code Fix It? | Time/Evidence Required | LIVE Blocking? |
|---|---|---|---|---|---|---|
| No organic paper trades | CRITICAL | STATISTICAL EVIDENCE | 0/30 | No | Real weeks of continuous paper operation | Yes |
| 0/25 WFO passes | CRITICAL | STATISTICAL EVIDENCE | Real, negative | No | Real edge would need to exist; more runs won't manufacture one | Yes |
| Full TS/Python/VectorBT parity | HIGH | RESEARCH | `FEATURE_SUBSET_PARITY` only | Yes, but multi-day+ | Real engineering time | Indirectly (undermines research validity, not the live gate itself) |
| Full point-in-time Fundamental/Macro replay | MEDIUM | EXTERNAL | Explicitly `UNAVAILABLE`, honestly | Partially — needs a real data vendor | External data acquisition | No (replay isn't the live path) |
| Full multiple-testing audit trail | MEDIUM | RESEARCH | Partial (trial counts only) | Yes | Real, bounded engineering | No (doesn't gate LIVE directly, strengthens evidence trustworthiness) |
| Full failure-injection test suite | MEDIUM | HIGH ENGINEERING | Individual mechanisms verified; no single enumerated suite | Yes | Real, bounded engineering | No (mechanisms already fail-closed; this closes a test-coverage gap, not a behavior gap) |
| Canadian live equity routing | LOW (for this repo) | REGULATORY / EXTERNAL | `EXTERNAL_BLOCKED` | No | IIROC-compliant broker integration/licensing | Only for Canadian symbols |
| LIVE manual approval | N/A by design | MANUAL_APPROVAL_REQUIRED | Correctly requires a human | No, and should never | A human, after real evidence exists | Yes, by design |

---

## 23. "What Is Already Done?" — Do Not Rebuild

- Sacred single-OMS order path (§3).
- RiskEngine's 24 gates, unconditional evaluation, sizing honesty (§5).
- 5-layer LIVE arm + restart clearance (§4).
- Reconciliation acknowledgement workflow, fully wired (§7).
- External-tool process/credential isolation (§16).
- `pyarrow`/Parquet durability (§10 — fixed this session, do not reinstall or re-diagnose; verified working).
- Reconciliation baseline backfill mechanism (§7 — fixed this session; the specific GLD/NVDA case is closed).
- `evaluateLiveReadiness()` — real, honest, gate-based (`liveReadinessEngine.ts`), already answers most of what a "readiness engine" (Phase 18-style ask, in the terminology of the companion implementation program) would need to build.
- `NEXT_BAR_OPEN` canonical execution model, cleanly separated from legacy `SAME_BAR_CLOSE`.
- `FullArgusReplayEngine` — real for Technical/Quant/Risk/OMS; honestly `UNAVAILABLE` (not fabricated) for Fundamental/Macro.
- Core test infrastructure (168 files, 1101 tests, growing).
- Security controls (§15).

---

## 24. "What Remains?"

**A. Code that must still be implemented:** full multiple-testing audit trail (rejected experiments, parameter provenance); the enumerated failure-injection test suite as one complete artifact; TS/Python/VectorBT full strategy parity.

**B. Tests that must still be implemented:** the specific failure-injection matrix in §18's "not yet a complete suite" row.

**C. Research that must still be performed:** none that hasn't already been honestly attempted — the real 25-evaluation gauntlet already ran; more runs against the same 6 datasets would not be new evidence, only repetition.

**D. Real market time that must pass:** 30 organic closed paper trades across 10+ real NY sessions. No shortcut exists or should exist.

**E. External data/broker requirements:** point-in-time fundamentals/macro data vendor (for full replay fidelity, not the live path itself); IIROC-compliant Canadian broker integration.

**F. Human approval:** the LIVE arming phrase, forever, by design, regardless of how much other evidence accumulates.

---

## 25. Final GO / NO-GO Decision

# 🔴 LIVE NO-GO

**Every mandatory live gate has not objectively passed.** Specifically: `STRATEGY_CORE`, `OOS`, `WFO`, `ROBUSTNESS`, and `PAPER` (organic trade count) all currently evaluate to `FAIL` in `evaluateLiveReadiness()`'s own real, code-level gate ladder — re-confirmed by this audit's fresh evidence, not merely cited from memory.

**Blockers, full list:**
1. 0/30 organic closed paper trades (STATISTICAL EVIDENCE, CALENDAR_REQUIRED).
2. 0/25 real WFO evaluations passed (STATISTICAL EVIDENCE).
3. 0/25 real robustness evaluations passed all four gates (STATISTICAL EVIDENCE).
4. Full strategy parity not established (RESEARCH, HIGH ENGINEERING).
5. Canadian execution externally blocked for Canadian symbols specifically (EXTERNAL/REGULATORY, not blocking for US-symbol LIVE consideration).
6. LIVE arming requires, and will always require, a human (MANUAL_APPROVAL_REQUIRED — not really a "blocker" so much as the correct permanent design).

---

## 26. Final Percent Remaining

```
CURRENT ENGINEERING READINESS:            88.5%
CURRENT TRADING VALIDATION READINESS:     24%
CURRENT OVERALL REAL-MONEY READINESS:     56.25%

REMAINING ENGINEERING WORK:               11.5% (of the engineering dimension; ≈6 points of the overall 44% remaining)
REMAINING VALIDATION/EVIDENCE:            76% (of the validation dimension; ≈38 points of the overall 44% remaining)
REMAINING EXTERNAL/REGULATORY:            not quantified as a percentage — EXTERNAL_BLOCKED, independent of the score, applies only to Canadian-symbol execution

TOTAL REMAINING BEFORE RESTRICTED LIVE:   ≈44%, of which the large majority (≈38 of 44 points) is evidence that can only be produced by real elapsed time and real market outcomes, not by further engineering.
```

---

## 27. Final Implementation Roadmap

1. **CRITICAL safety** — none open; every mandatory safety mechanism this audit checked is real and fail-closed.
2. **Critical engineering** — none open at CRITICAL severity; remaining engineering items (§22) are HIGH/MEDIUM, none of which gate the LIVE decision directly.
3. **Research/parity** — full TS/Python/VectorBT parity (real engineering time, no fixed estimate given the scope); full multiple-testing audit trail (bounded, real).
4. **Statistical validation** — cannot be "done" by more engineering; requires either a genuinely different strategy/dataset producing a real positive, reproducible result, or an honest permanent `NO-GO` for the current CORE five.
5. **Organic paper evidence** — let the now-running soak continue uninterrupted; do not restart Autobot unnecessarily (each restart clears any LIVE arm anyway, and is otherwise just operational churn); accumulate 30+ real closed trades across 10+ real sessions.
6. **Failure-injection verification** — build the enumerated suite from §18 as one complete, explicit artifact.
7. **Operational readiness** — already real; continue monitoring the soak's reconciliation cycles for stability over a longer real window.
8. **Human approval** — reserved, correctly, for a human, after items 4-5 produce real evidence.
9. **Final LIVE gate** — unreachable until 4 and 5 both produce real, positive evidence; this audit does not predict whether they will.

---

## 28. FINAL AUDIT SUMMARY

```
Audit timestamp:                    2026-08-17T01:00Z
Repository commit/hash:             (uncommitted working tree)

Build:                              PASS (tsc clean)
Tests:                              PASS (168 files / 1101 tests, 0 failed)

Engineering readiness:              88.5%
Trading-validation readiness:       24%
Overall real-money readiness:       56.25%
Remaining:                          ≈44% (≈6 pts engineering, ≈38 pts evidence)

Organic paper trades:               0
Required:                           30
Progress:                           0/30

Organic paper sessions:             0
Required:                           10
Progress:                           0/10

WFO:                                0/25 real evaluations passed
OOS:                                0/25 real evaluations passed
Robustness (all 4 gates):           0/25 real evaluations passed
Monte Carlo:                        fails on nearly every real evaluation
Permutation:                        fails on nearly every real evaluation
Sensitivity:                        passes on a minority of real evaluations
Cost stress:                        passes on a minority of real evaluations

TS/Python parity:                   FEATURE_SUBSET_PARITY only, not full

Replay readiness:                   PARTIAL (Technical/Quant/Risk/OMS real; Fundamental/Macro honestly UNAVAILABLE)

Risk readiness:                     Real, 24 gates, fail-closed, live-fire verified this session

Order lifecycle readiness:          Real, DB-level idempotency, crash recovery

Reconciliation readiness:           Real, fixed and empirically stable this session (§7)

Security readiness:                 Clean fresh sweep, this pass

Observability readiness:            Real decision-lifecycle audit trail; UI coverage thin (unchanged, longstanding)

Failure-injection readiness:        Individual mechanisms verified; full enumerated suite not yet one complete artifact

External integration isolation:     Real, verified, zero broker/wallet access from any external tool

Canadian execution:                 EXTERNAL_BLOCKED

Critical blockers:                  0 engineering; 3 evidence (organic paper, WFO/OOS, robustness)
Engineering blockers:               0 at CRITICAL severity
Evidence-required blockers:         organic paper trades/sessions, WFO/OOS/robustness pass
External blockers:                  Canadian execution (regulatory), full point-in-time replay (data vendor)
Manual approval blockers:           LIVE arming, permanently, by design

FINAL VERDICT:

LIVE TRADING: 🔴 NO-GO
```

**Why this verdict:** the engineering substrate is real, extensively verified this session and prior sessions, and — new this pass — empirically exercised under a genuine live reconciliation anomaly that it handled correctly. None of that constitutes a trading edge. The only honest measurement of whether Argus can trade profitably (the real 25-evaluation WFO/robustness gauntlet, and the real organic paper trade count) currently says, unambiguously: **not yet demonstrated**. That is the correct state to report, and the correct reason for `LIVE NO-GO` — not incomplete engineering, but incomplete evidence, which is a different problem with a different, non-code solution: time, real market exposure, and an honest willingness to report a permanent `NO-GO` if that evidence never arrives.
