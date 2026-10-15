# Argus October 14, 2026 — Remediation and Certification Plan

Status vocabulary as in the session audit. No implementation or deployment is proposed here beyond what is already on the unmerged candidate branch; each item needs its own approval. Read-only audit output. No credentials.

## 1. Repair candidate state (not deployed; production is 3a5eacdc)

Branch `fix/oct14-report-freeze` (worktree `argus-fix-0814`), latest head at the time of writing **25811fb0**:

| Change | Commit | Evidence of correctness today | Verified effect on real conditions |
|---|---|---|---|
| Report freeze: constant-query `rescue-outcomes`; `guardHeavyReport` on `rescue-outcomes`, `discovery-challengers` | 4fe4d906 | regression: 910 queries → ≤ 8 (fails on old code) | NOT reproduced on the live DB |
| Rescue pinning: routine renewal of an already-streaming symbol no longer extends eviction immunity (config-gated, default off) | 6a70ff71 | reproduction test: all renewed symbols pinned under old, all evictable under new | Oct 14 shows 14,536 such renewals; effect on outcomes NOT_PROVEN |
| Held-position eviction protection (`setHeldSymbols`) | c0ba89ef | unit regression; 382 critical tests passed | not exercised (no positions today) |
| Dwell protection time-based (CCI/CIEN) | 25811fb0 | regression reproduces the 28 s case; 517 related tests pass | would have prevented 26 quick evictions (6.8 % of promotions) |
| Session guard (resolved config, no credentials, sanitized manifest) + flags-only `.env` | d32d4617, 60f11a0b | 5 tests; canonical session manifest shows no problems | — |
| Lifecycle baseline tooling (UNTESTED only, CORE only, no authority) | da622a58 | 5 tests | **not applied**; owner authorized "CORE 5 only" |

Exact-SHA certification of 25811fb0 (suite, canonical, lifecycle, multi-trade 22/33, restart cases) was started after the close and was **still running when this document was written**; it is not a deployment gate result yet. Two earlier suite runs: 7,029 passed / 2 failed (unrelated timing/ECONNRESET tests under load, pass in isolation) — classification, not proof.

## 2. Prioritized issue list

P0 = safety/state-integrity · P1 = major legitimate-trading capability blocker · P2 = material discovery/ranking/performance limitation · P3 = observability/reporting/test-harness weakness.

| ID | Pri | Issue | Evidence | Root cause | Production code | Fixture | Minimum repair | Regression | Uncertainty |
|---|---|---|---|---|---|---|---|---|---|
| A | P0 | Operator report froze the engine ~6 min (heartbeat gap, watchdog restart) | 12:48:35→12:54:37 ET; 5.5-min event gap | PROBABLE: unguarded N+1 synchronous queries in `rescue-outcomes` | `observabilityRoutes.ts`, `rescueOutcomeReport.ts` | event table ≥ 1 M rows + monitor running | batch queries + guard (done in candidate) | query-count regression (done) + route-inventory + load test | not reproduced; 36 other routes un-audited |
| B | P0/P1 | System drive 4.3 GB free; production DB 24.8 GB; tests leave ~40 GB of temp DBs | `Get-PSDrive` before/after cleanup | no artifact cleanup; DB growth | test infrastructure; retention/compaction | — | global test teardown, DB size/free-space preflight and alert | teardown assertion; preflight in certification scripts | whether DB retention (14 d) is actually pruning: UNKNOWN |
| C | P1 | Real agents cannot reach 0.75: 2 of 27,191 rounds ≥ 0.75; Kronos reliability 0.50; Technical uncalibrated (N=1); Macro placeholder HOLD 99.7 %; no third evidence family | `oct14_cons2.json` | agent evidence quality + AI-provider outage | `ChiefTraderAgent` inputs, `KronosForecastAgent`, `TechnicalAgent` calibration, AIRouter | calibration-seeded fixture (Report 3 #1) | **no threshold change.** Evidence work: establish whether calibration of Technical/Kronos is truthful or a cold-start artifact; restore LLM providers; add independent evidence families only through the reviewed path | fixture + fidelity oracle | whether Kronos truly has no edge or is mis-calibrated: NOT_PROVEN |
| D | P1 | Quant removed from consensus: 20/21 strategies NOT_AUTHORIZED | `quant-readiness`; ≈1,660 checks / 19 symbols | operator decision never recorded (deliberate design) + no research evidence for ACTIVE_EXPLORATION | lifecycle (data), `certificationBridge` | authorized / unauthorized scenarios | apply the owner-authorized CORE `UNTESTED` baseline (routes ideas to consensus, grants no authority) after release gate; produce research evidence (backtest/OOS/walk-forward on real next-bar data) for any promotion | scenarios (Report 3 #2) | whether any CORE strategy can pass OOS/WFO: NOT_PROVEN |
| E | P2 | Dwell released at 10 ticks → promoted symbols evicted in 2–48 s (26 / 381), 4 delays > 10 min | `oct14_lags.json` | `isWithinDynamicDwell()` | `MarketDataWorker.ts` | time-compressed promote/evict | time-based dwell (done in candidate) | done + promotion-before-expiry scenario | impact on recall NOT_PROVEN |
| F | P2 | Swap budget (1/cycle at full capacity) blocks 4,348 promotion attempts / 157 symbols; `OTHER` 5,790 unexplained | discovery events | design cap; label unrecoverable | `OpportunityDiscovery.ts` | production-faithful 90-line replay | **investigate before changing:** add the missing reason breakdown; run the perfect-ranking counterfactual under real occupancy | replay comparison | all of it |
| G | P2 | Rescue pinning: 14,536 routine renewals; 453 INCUMBENT_NOT_EVICTABLE (4.3 %) | events | routine renewal extends immunity | `MarketDataWorker.requestTemporaryDataRescue` | N renewed symbols + challengers | candidate fix | done + soak assertion | smaller direct effect than earlier hypothesis |
| H | P2 | Front-of-funnel latency: HALO first seen 70 min after its move; BSP held by SPREAD for ~85 min then swap cap; IBRX admitted 4 h late | per-symbol traces | `RANK_CAP`, spread screen, 15-min broad cadence, `gapPct` = since-open return | `MarketUniverseScanner`, `OpportunityDiscovery` | Oct 14 replay | **investigate**: gap-vs-previous-close evidence, cadence vs window | per-symbol latency assertions | whether faster discovery would have produced approvals: NOT_PROVEN (C dominates) |
| I | P2 | Ranking: synthetic traps scored 8–12 vs valid 1.2–4 (raw-gap dominated) | counterfactual matrix | no liquidity/persistence term in challenger score | `scoreBroadUniverseChallenger` | holdout seeds | **none until decomposed**: trap decomposition + holdout evaluation | precision/recall assertions | not seen on Oct 14 (traps were filtered by PRICE) |
| J | P3 | Synthetic coverage gaps (13 rows in Report 3) | Report 3 | — | harness | — | as listed | as listed | — |
| K | P3 | Telemetry gaps: `OTHER` label; Quant bridge outcome fields; NVAX/BSP stage timestamps need a per-symbol funnel view | — | — | observability | — | emit reason codes for every non-promotion branch | schema test | — |
| L | P3 | Evidence hygiene: my temp cleanup removed earlier synthetic-session DBs | disclosed in Report 1 | operator action | — | — | keep certification session DBs for the life of the release evidence bundle | bundle completeness check | — |

## 3. Reproducing October 14 in the lab

Data actually available:
* Per-candidate point-in-time Alpaca snapshot evidence (price, open, previous close, dollar volume, spread, ADV, gap, timestamps) for 1,055 observed symbols — in `observability_events` (admitted/filtered payloads).
* Discovery cadence, promotions, evictions, rescue grants/renewals/denials (event stream) — enough to reproduce occupancy and renewal behavior.
* Real consensus inputs (`participatingAgents`, calibration values) for 27,191 rounds — enough to build the calibrated-agent fixture.
* 15-minute independent bars through the IBKR connector for symbols requested individually.
* **Not available:** full-universe 1-minute bars, quote/bid-ask history, order-book data. The replay is therefore a *snapshot-cadence* replay (what Argus could see at each scan), not a tick replay; limitation must be stated in every result.

Fixture design:
1. Provider seam so the real `MarketUniverseScanner`/`OpportunityDiscovery`/`SnapshotScanner`/`MarketDataWorker` run unchanged and only the Alpaca/IBKR boundary is replaced by Oct 14 snapshots (replayed on the recorded cadence).
2. Initial state: 90 lines with the 08:17 ET composition (3 core, 87 dynamic, rescue holders per `rescue-occupants`).
3. Agents: calibration values from the Oct 14 records; lifecycle table as it was (1 row, PULLBACK_CONTINUATION RETIRED).
4. Service faults: Macro/LLM unavailable, a 5.5-minute loop freeze at 12:49 ET, Java connected.
5. No symbol injection, no approvals injected, no future data: each scan sees only data timestamped before it.
6. Oracles: Opportunity (independent bars), Lineage (per-symbol path with timestamps), Accounting/Risk as before.

Controlled comparison (to be run after the fixture exists; **not run yet**):
| Arm | Release | Variable changed |
|---|---|---|
| A | 3a5eacdc | none |
| B | A + rescue fix only | `temporaryDataRescueRoutineRenewalGrantsImmunity=false` |
| C | B + dwell fix + held-position protection | candidate head |
| D | C + diagnostic perfect ranking (oracle ordering, never fed to production code) | counterfactual only |
Metrics per arm: opportunities discovered, promotion latency, time to first analysis, quick-eviction count, INCUMBENT_NOT_EVICTABLE count, swap-cap count, Quant reachability, consensus rounds, approvals, orders, API/DB/CPU cost, precision/recall on independently verified opportunities.

## 4. Readiness gates for the next market session

Hard requirements (all must hold on the exact deployed SHA):
1. Typecheck, build, full suite green with each failure classified; critical Risk/OMS/protective-exit/reconciliation suites green.
2. Canonical, lifecycle, multi-trade sessions with accounting/risk/lineage oracles passing **with the sanitized production-equivalent configuration manifest** and **production-calibrated agent fixture**.
3. Restart battery 14/14.
4. Route-inventory and report-load tests passing; disk-free preflight ≥ 20 GB.
5. Discovery scenario: qualifying hidden opportunity reaches Quant before expiry under a 90/90 occupied state.
6. Mutations 1–4 of Report 3 turn the certification red.
7. DB backup and 3a5eacdc rollback available; reconciliation MATCH, flat, no unexpected orders before restart; resume only through the normal CLI path.

Explicit non-goals: no change to the 0.75 threshold, the two-group requirement, $20K research capital, $250 daily loss, position sizing or protective-exit rules; no VALIDATED/CHAMPION without evidence.

## 5. What is proven and not proven after Oct 14

Proven (CONFIRMED): production abstained correctly under its rules; discovery→analysis latency for promoted symbols is short (p50 1.4 s); dwell and routine-renewal behaviors are real and measurable; synthetic certification does not model calibration, discovery, or lifecycle.
Not proven: that real agents can reach a 0.75 consensus at all; that any CORE strategy can qualify; the effect of any candidate fix on real outcomes; protective exits on real data; the NVAX/BSP/HALO front-of-funnel causes beyond the stages named; AI-degradation side effects; freeze reproduction.
