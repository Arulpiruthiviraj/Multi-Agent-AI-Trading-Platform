# Argus handoff — 2026-10-14

## Production state at the time of writing (07:40 ET)
* Checkout `C:\WorkProjects\Multi-Agent-AI-Trading-Platform` is at **3a5eacdc** (detached). Branch of origin: `repair/oct13-defect-release` (worktree `C:\WorkProjects\argus-release`).
* Engine RUNNING (pid 19784), PAPER, `TRADING_ENABLED`, budget $20,000, daily loss limit $250, `LIVE_NO_GO`.
* IBKR Gateway socket CONNECTED/authenticated, 70 active market-data lines; reconciliation **MATCH**; no open positions (`positions --json` empty).
* Java Quant Core: **CONNECTED (HTTP 200, QUANT_HEALTHY)** — the earlier DISCONNECTED was a startup timeout (service had just been restarted under CPU load). Chronos READY. Watchdog READY (restarted).
* Ollama: an Ollama process runs independently of Argus (started outside it); Argus was started with `ARGUS_SKIP_OLLAMA=true` so it did not launch it, and `AIRouter.ts:636` treats the local provider as **unroutable** under that flag. "READY" = reachable, not "used".
* `marketDataAuthenticated=false`: it is `MarketDataWorker.getFeedStatus().authenticated`, an Alpaca-WebSocket flag that nothing sets on the IBKR path. With IBKR the meaningful signals are `marketDataConnected=true`, no `marketDataLastError`, `ibkrPaths.gatewaySocket=CONNECTED`, 70 lines. Benign.
* Services I restarted by hand after the overnight environment restart killed them: Java core (`java -jar quant-core-java/target/quant-core-java-0.0.1-SNAPSHOT.jar`, :8085) and Chronos (`python scripts/local_ai_service.py`, :8008). They are plain child-less processes, not supervised.

## Safe restart (usage-limit / crash)
```
cd C:\WorkProjects\Multi-Agent-AI-Trading-Platform     # the production checkout, detached at 3a5eacdc
$env:ARGUS_SKIP_OLLAMA = "true"
npm run argus-cli -- restart --resume --reason="safe handoff"
npm run argus-cli -- status ; health ; reconciliation-status ; positions --json ; orders --json
```
Never restart from `argus-discovery` or any uncertified commit. Do not force-enable if reconciliation fails or EMERGENCY_STOP is active.

## Release gate on the exact SHA 3a5eacdc (evidence)
| Gate | Result |
|---|---|
| Full suite | 859 files / 7,021 tests PASS (`/tmp/H/suite4.log`) — suite run on 3a5eacdc |
| `tsc --noEmit`, `npm run build` | PASS |
| Canonical + lifecycle + 5 matrix sessions | PASS; accounting/risk/lineage oracles clean (`/tmp/J/…`) |
| Multi-trade (seeds 11/22/33, 10 symbols) | 1 / 9 / 4 orders; all three oracles clean (net P&L +0 / +655 / +325 after fees; open positions monitored) |
| Restart matrix 7 conditions × 2 seeds | **14/14 PASS** on this SHA |
| Soak | **NOT PROVEN on this SHA yet** — the 110-session soak launched 02:39 was destroyed by the environment restart (56+58 sessions recorded as child-killed, only 12 real). A second soak (seed 11000, 3 concurrent, hard stop 09:15) was started 07:31; see its log. Earlier SHA (056aedec) soak: 30 clean sessions + 1 failure (harness drain defect, fixed in 3a5eacdc, verified on 3 thin-liquidity sessions). |

Production-code delta from the first release candidate to 3a5eacdc: ChiefTraderAgent flush of debate-pending ideas at planned stop; harness-only changes otherwise (session engine end-of-session OMS convergence drain, oracle tooling).

## Audit of yesterday's requirements (COMPLETE / PARTIAL / MISSING / REGRESSED)
| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 2 | Historical queue priorities, coalescing, expiry, preemption, deadline abort | COMPLETE | `src/brokers/ibkrHistoricalScheduler.ts` + 17 tests incl. FAILURE MODE test; QuantSignalAgent.intradayDeadline tests |
| 2 | Negative cache / backoff for failing old windows | COMPLETE | same file; 24 h / 300-window stress test (rate converges downward); live classes never cached |
| 3 | Pause / protective-exit semantics through real spine | COMPLETE | `protectiveExitUnderPause.e2e.test.ts` (5 cases), exit-ownership tests A–H, gate 1 ENTRIES_ONLY; broker-fault e2e incl. retry-before-reconcile |
| 4 | Main-thread DB / off-thread queries, index, bounded ranking | COMPLETE (code) | `selectRowsOffThread`, migration 0100, evaluator pages off-thread. **Cause of the original hot `trades` SELECT remains UNPROVEN**; attribution (`dbCallerContext`, rowCount) now added |
| 5 | $20K research basis in sizing/risk | COMPLETE | `RiskEngine.researchCapitalCaps`, riskOracle differential + metamorphic property tests (broker equity 50k/1M/5M gives same quantity) |
| 6 | Quant scheduling telemetry/deadlines | PARTIAL | unit tests pass; combined scheduler+held-position+backfill+DB-pressure simultaneous test NOT built |
| 7 | Symbol hygiene | COMPLETE | `symbolFormat.test.ts` (19), classifyEquityRouting, BRK.B resolution |
| 8 | AI failure isolation | PARTIAL | provider cooldown code + existing tests; 401/402/429/500/timeout matrix not re-proven tonight; every full session runs an all-AI-unavailable window and passes |
| 9 | Java Quant | PARTIAL | verified connected via CLI health (HTTP 200); degraded-abstention evidence not tested tonight |
| 10 | Wall-clock family | PARTIAL | MarketDataWorker sim clock, OMS replay-clock stamps + `replayAwareNowMs`, wall-clock baseline ratchet + runtime audit recorder + classification. Not every `Date.now()` is individually classified (ratchet + observed-caller review only) |
| 11 | Commission / P&L semantics | PARTIAL | brakes net of commissions (`researchEquity`); `profit_loss` stays gross; consecutive-loss/post-loss cooldown still gross; explicit gross/commission/other-fees/net fields NOT introduced |
| 12 | $20K synthetic allocation | COMPLETE | `riskProfile` plumbing; allocation visible in sessions (`allocated $20000`); no permanent unit regression test for the old $3K default beyond session evidence → add |
| 13 | Consensus idea lifecycle | COMPLETE | expiry record, planned-stop flush incl. debate-pending; tests in `ChiefTraderAgent.shutdownFlush.test.ts`; lineage oracle zero UNTERMINATED. Unplanned crash still loses in-memory ideas (inherent) |
| 14 | Oracles | COMPLETE | accounting/risk/lineage oracles + adapters + CLIs + property tests |
| 15 | Multi-trade sessions | PARTIAL | oracle-clean; organic aggregate bar (≥5 trades, 2W/2L, 3 sizes) met across the 3 final sessions only partly; capital-reuse/cooldown/position-cap rejections are not shown in these three; soak population needed |
| 16 | Broker faults | COMPLETE | `FaultInjectingBroker` + 7 e2e cases; disconnect/reconnect and fill-after-timeout-with-real-late-fill beyond UNKNOWN case: PARTIAL |
| 17 | Restart matrix | COMPLETE | 14/14 PASS on 3a5eacdc |
| 18 | Profitable / losing / no-trade fixtures | PARTIAL | MULTI_TRADE_DAY (profitable-leaning), matrix quiet/noise (no-trade), losing exist; a net-positive-after-costs requirement is reported, not asserted per fixture |
| 19 | Soak / resource growth | PARTIAL | driver + invariants built; exact-SHA soak incomplete (see above) |
| 20 | Exact-SHA certification | PARTIAL | everything above except soak is on 3a5eacdc; the readiness battery report is generated separately |
| 21–30 | Universal discovery | PARTIAL / MISSING | See below |
| 31 | Final readiness table | PARTIAL | `scripts/sim/certificationBattery.ts` output; discovery/alpha rows NOT_PROVEN |

## Universal discovery (separate branch `cert/universal-discovery`, worktree `C:\WorkProjects\argus-discovery`, commit 557c8bb9; NOT in production)
Built: 500-symbol hidden-truth market (`SyntheticDiscoveryMarket`), independent `OpportunityOracle` (recall, precision, Recall@K, MRR, latency, miss classes), harness driving the REAL `runOpportunityScan`/SnapshotScanner/ComposableRanking/hot-swap planning minute by minute with production feed cadences (15-min broad gap, 5-min movers), integrity guards, report `docs/audits/ARGUS_UNIVERSAL_DISCOVERY_BASELINE_2026-10-14.md`.
Baseline: inside curated lists 94–100 % recall; **outside lists 0–37 %**; 3 of 8 traps promoted; challenger score ≈1.2–1.5 vs weakest incumbent ≈1.8–1.9 (information asymmetry); first blocking stage mostly `OFFERED_BY_MOVERS_NOT_PROMOTED`.
PROVEN DEFECT (real MarketUniverseScanner code, commit on cert/universal-discovery): broad-universe `getCachedBroadUniverseGapPct` / `getCachedBroadUniverseCandidatesWithVolume` serve the last refresh's evidence with NO age limit (45 min after the last successful refresh the +8 % gap is still returned; test `MarketUniverseScanner.staleEvidence.test.ts`). It feeds the challenger score; age is only recorded. Fix belongs to the next gate cycle (separate fresh-evidence vs universe-membership), not tonight.
MISSING: provider seam so the REAL `MarketUniverseScanner` runs on synthetic data (needed to test screens, ADV, IEX dollar-volume, stale broad cache); Quant/idea/Chief/Risk/OMS leg inside the 500-symbol run; heavy-load/pressure variants; restart-fairness test; mutation testing of discovery; the stale-cache and cadence tests; 100+ seeds. **Universal discovery is NOT_PROVEN/FAIL and must not be assumed today.**

## Remaining work, in order
1. Finish/inspect the exact-SHA soak (`/tmp/J/soakF.log`, `/tmp/J/soakF/soak-results.json`); any real failure → seed becomes a regression.
2. Run `certificationBattery` with `--soak` and attach the table.
3. Build the synthetic provider seam for MarketUniverseScanner (extend `cert/universal-discovery`), then the stale-cache / cadence / IEX tests, mutation tests, then the 500-symbol end-to-end funnel.
4. Explicit gross/commission/fees/net fields; combined pressure scenario; AI-error matrix; permanent $3K-allocation regression test.
5. Any production change → restart the full exact-SHA gate.

## Update 08:20 ET - findings since the first write
* **Seed 11 (multitrade) is NOT an Argus failure.** AMZN +13.8% held at the session peak; take-profit 15%, trail 5% from peak never triggered; 112 PortfolioMonitor decisions recorded; all 8 risk rejections legitimate. `POSITION_CLOSED` is the wrong gate for MULTI_TRADE_DAY (harness spec defect), and the end-of-session broker summary mark is stale (equity excludes ~$407 unrealized: harness reporting defect). Release SHA not changed; fix on the dev branch later (OPEN_POSITION_VALID vs INVALID semantic + mark-to-market regression).
* **selectRowsOffThread test** fails 5/5 under 6 CPU spinners, passes 3/3 unloaded. Production worker is a long-lived singleton with a 120 s timeout and null => callers skip the cycle. Classified: test defect (fixed timeouts), implementation acceptable, extreme-saturation behaviour NOT_PROVEN.
* **Event loop** (synthetic, 60x, 3 parallel sessions): seed 11 p50 719 / p95 1240 / p99 1972 / max 2552 ms; soak max 3460 ms. Not production latency; correlation with PortfolioMonitor gap / DB / Quant / GC still OPEN.
* **Discovery counterfactuals (branch cert/universal-discovery 461a534d):** 12 slots 37% recall; 90 free slots 100%; unlimited challenger limit or zero score edge alone no help; the same 3 of 8 traps promoted in every run (trap scores 8-12 vs valid 1.2-4; raw-gap dominated). Recall problem = free capacity; precision problem = ranking quality. Production at 08:07 ET: 90/90 lines, ~38 temporary-rescue holders (ROUTINE_RECOVERY), so free discovery capacity is unknown. Evidence snapshot: C:/Users/ithay/AppData/Local/Temp/J/prod-capacity-0814ET (market-data-diagnostics, subscription-queue, rescue-occupants).
* AI router AI_DEGRADED (1/10 providers healthy) and OpenAlice FAILED: both non-gating; not verified under load.

## Update 13:50 ET - same-day fix candidate (NOT deployed)
* Production: engine on 3a5eacdc, PAPER, TRADING_ENABLED. At 12:48 ET an operator report burst (rescue-outcomes N+1 sync queries) froze the engine ~6 min; watchdog force-restarted it at 12:54:37 and trading was resumed via the normal `resume` path at ~12:56 (flat, MATCH).
* Candidate branch fix/oct14-report-freeze (worktree C:\WorkProjects\argus-fix-0814), HEAD 5e36e191 on top of 3a5eacdc: (1) freeze fix (batched rescue-outcomes + guardHeavyReport), (2) rescue-pinning fix (temporaryDataRescueRoutineRenewalGrantsImmunity=false), (3) owner-authorized lifecycle baseline tooling (CORE only, UNTESTED only), docs. Full suite on previous SHA ceb0adf8: 7029 pass / 2 fail (fixtures relying on routine-renewal immunity; fixed in 5e36e191). Exact-SHA certification of 5e36e191 running from 13:47 ET (/tmp/J/cand): suite, canonical, lifecycle, multitrade 22/33, restart cases.
* Deploy (only if every gate passes, after 16:00 ET): in C:\WorkProjects\Multi-Agent-AI-Trading-Platform `git checkout 5e36e191`; `$env:ARGUS_SKIP_OLLAMA="true"; npm run argus-cli -- restart --resume --reason="Certified PAPER repair"` (verified: stops gracefully, restarts, resumes only if trading was enabled and reconciliation is clean); then verify status/reconciliation/positions/orders/health; then `strategy-lifecycle-baseline --reason=... ` dry run, then `--apply`. ROLLBACK: `git checkout 3a5eacdc` in the production checkout and the same restart command; if reconciliation is not MATCH or the engine refuses, leave paused.
