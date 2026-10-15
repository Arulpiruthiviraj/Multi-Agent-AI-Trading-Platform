# ARGUS October 15, 2026 - intraday fixes and release record (LIVE DOCUMENT)

Environment: IBKR PAPER. LIVE: NO_GO. Production runs `32613911842dfce05b722360bf67b7fb673dbb7b` (pid 25116, started 07:50 ET) and has NOT been restarted. Statuses used: FIXED_AND_TESTED, MERGED_TO_MAIN, CERTIFIED, DEPLOYED, VERIFIED_IN_PAPER, DEFERRED, FAILED, NOT_VERIFIED, NOT_PROVEN, BLOCKED. A fix is never described as deployed while it is only merged.

## 1. Why Argus did not trade 09:30-10:10 ET
Correct abstention: after calibration no round reached 0.75 (13 of 3,182 reached 0.60) and almost every round had one independent evidence group. First pipeline stage with zero throughput: consensus. Details and evidence: `ARGUS_OCT15_1000_LIVE_MARKET_FORENSICS.md`. This is a research-evidence limitation, not an engineering block; nothing here lowers a threshold.

## 2. Production safety action taken (owner-directed)
At ~12:30 ET new entries were paused (`argus pause`, kind `ENTRIES_ONLY`) because the **running** release still has the protective-exit idea-cap defect: the cap was saturated (118/120 in the window, 11,331 ideas dropped since boot) and no broker-side stop exists (protective exits are software-managed through the same idea path). Monitoring and protective exits remain active; reconciliation MATCH; no positions or working orders; no emergency stop. Entries stay paused until the certified release is deployed and resumed through the guarded CLI.

## 3. Defect tracker
| ID | Defect | Fix commit | Tests | Main | Release |
|---|---|---|---|---|---|
| D1 | Global 120/min idea cap applied to protective exits | `8b0a47e3` | `pipelineRateLimit.test.ts`, `EventBus.protectiveExitRate.test.ts`, Test C replay `D1_protectiveExitUnderIdeaSaturation.test.ts` (fails on `32613911`, passes on fix) | MERGED_TO_MAIN | in candidate; not DEPLOYED |
| D7 | Jev configured/implemented but receiving zero events (shadow flag unset) | ledger dedupe + status + e2e `3e327626`; failure modes (401/429/timeout) `c2d558ce` | `JevShadowIntegration.e2e.test.ts` (6), `JevShadowFailureModes.e2e.test.ts` (3), `featureParity.test.ts`; real isolated API call on the exact candidate SHA | MERGED_TO_MAIN | code in candidate; **activation needs `ARGUS_JEV_SHADOW_SCORING_ENABLED=true` + restart (not DEPLOYED)** |
| D5 | Calibration lookup could return a per-provider row | `d6efe67b` | `ChiefTraderAgent.calibrationProviderSelection.test.ts` | MERGED_TO_MAIN | in candidate. Measured effect: NewsAgent only (off) |
| D8 | Default 24h operator funnel stalled the event loop | `a084d853` + corrected in `eb92f821` | `tradingFunnelWindow.test.ts`, `operatorReportGuard.test.ts` | MERGED_TO_MAIN | in candidate |
| D11 | `NEWS_PROVIDER_FAILED` persisted as `{}` | `9720c01a` | `instrumentEventBus.test.ts` | MERGED_TO_MAIN | in candidate |
| D3 | ~28 near-identical Kronos predictions/symbol/30 min | - | - | - | DEFERRED (changes vote counts; needs validation) |
| D9/D10 | Retention-sweeper DELETE (2 s) and synchronous observability persist (0.5-1 s) stall the loop | - | - | - | DEFERRED |
| D2 | Movers funnel kept 0 of 100 | - | - | - | Reclassified: genuine rejection (not a defect) |
| CLI | stop/start/restart/resume/pause/status code and lifecycle fixes; `npm run test:cli-lifecycle` | `da9cf783`, `df764864` | `scripts/cli/lifecycle.isolation.test.ts` (13) + existing | MERGED_TO_MAIN | in candidate |
Process finding: my first D8 attempt added a nested guard that deadlocks against `operatorReportGuard`; the full suite caught it before release.

## 4. Release candidate
* CANDIDATE_SHA: `eb92f821d58ee6e1f145367ec0f10408cd26c003` (frozen; no optional changes added). `main` has since advanced only with test/doc commits (`c2d558ce`).
* Differences from the deployed SHA: **no schema/migration change, no config change in the repository; 12 runtime source files.** The deployment additionally changes the production `.env` (`ARGUS_JEV_SHADOW_SCORING_ENABLED=true`), which is NOT in git: **rollback must restore the previous effective configuration (remove that line) as well as checking out `32613911`.**

## 5. Certification status for `eb92f821`
| Gate | Status | Evidence |
|---|---|---|
| Typecheck, production build | CERTIFIED | tsc rc 0; build rc 0 |
| Full test suite (excluding the heavy universal-discovery simulations) | CERTIFIED with one known flake | 874/875 files, 7,123 tests pass. One failure `selectRowsOffThread.test.ts`: **`Test timed out in 5000ms`** (two 6M-row recursive queries inside vitest's default 5 s); intermittent on a tree with database code identical to the deployed release (pass/fail/pass), 6 consecutive isolated passes later; no assertion about event-loop blocking failed. Disposition: environmental timing flake, no concurrency defect indicated; hardening the timeout is a test-only follow-up |
| Protective-exit saturation (Test C D1) | CERTIFIED (part of the suite) | fails on old code, passes on fix |
| Jev end-to-end, real authenticated call | CERTIFIED (isolated) | BIDU article, model jev-1.13.0, 263 ms, 910 tokens; duplicate recorded once; empty input sent nothing |
| Jev failure behaviour | CERTIFIED | 500, malformed, outage (6 tests) + 401, 429, timeout (3 tests): caller never held, nothing persisted |
| Test A (production-calibrated abstention) | RUNNING (started 12:25 ET, ~80 min) | |
| Test B (positive BUY->Risk->OMS->fill->monitor->SELL) | RUNNING | |
| Universal-discovery simulations | NOT RUN yet | scheduled after A/B |
| Restart/recovery battery | NOT RUN yet | needs a quiet machine |
| Session mutation tests / resource-stress | NOT RUN yet | |
| Jev shadow CONFIGURATION_PARITY | NOT_PROVEN until deployed and a real eligible event is observed | `JEV_SHADOW_PARITY` check; the deployed configuration currently reports blocked (flag unset) |
| REAL_MARKET_ALPHA_VALIDATION | NOT_PROVEN | mechanical tests prove nothing about profitability |

## 6. Deployment readiness (to be completed)
* Current production SHA `32613911`; candidate `eb92f821`; PAPER; LIVE_NO_GO; `TRADING_PAUSED` (`ENTRIES_ONLY`); reconciliation MATCH; no positions or working orders.
* Backup/recovery: **no complete recoverable database backup**; a critical-state export is not one. The release has no migration, so rollback is code + `.env` only. Free disk 23 GB (floor 15 GB); `argus.db` 31.3 GB growing ~3 GB/session.
* REQUIRED_OWNER_APPROVAL: yes, explicit, after the remaining gates pass.
* Post-deployment verification (not yet done): runtime SHA, protective exits unthrottled, Jev real events/requests/responses/persistence, event-loop/memory/DB growth.

## 7. HOTFIX DEPLOYMENT RECORD (13:31-13:39 ET) - supersedes the "no restart" statement in section 1
Owner-authorized, conditional on certification. The larger release `eb92f821` is NOT deployed and its remaining gates (Tests A/B, restart battery) are unmet; the hotfix was certified separately on its own smaller scope.
* **DEPLOYED SHA:** `db14216b899a8881cc4dffda2ee22a5559c479af` (branch `hotfix/protective-exit-cap`, pushed to origin; based on `32613911` + cherry-pick of `8b0a47e3`). Runtime files changed vs the previous deployment: `src/server/core/EventBus.ts`, `src/server/core/pipelineRateLimit.ts` only. No schema, config, calibration, strategy, Risk, consensus or `.env` change. Jev shadow activation, CLI lifecycle fixes, calibration fix, funnel window, news-provider payload fix are NOT in this deployment (they remain in `eb92f821`, MERGED_TO_MAIN, not DEPLOYED).
* **Policy basis (verified in code):** `readinessTiers.ts` gates `FULL_SESSION`/`WALL_CLOCK_SOAK` only for UNATTENDED_PAPER and above, Jev checks only for LIVE; controlled supervised PAPER is gated by the remaining checks. There is no written hotfix rule in the repository; applying it as a delta certification over the certified base `32613911` is a judgement the owner authorized.
* **Hotfix certification (exact SHA):** typecheck PASS; production build PASS; full suite 870/870 files, 7,081 tests PASS (3 expected-fail, 2 skipped; universal-discovery simulation tests excluded for memory, they exercise unchanged discovery code and passed on `32613911`); safety subset 121 files / 866 tests PASS (core event path, risk, OMS, ChiefTrader, PortfolioMonitor, exit logic, saturation replay); 16/16 unit mutations CAUGHT incl. M13-M16 (control GREEN); protective-exit saturation replay PASS.
* **NOT RUN (disclosed):** Test A, Test B, restart battery on this SHA (heavy sessions repeatedly consumed ~8 GB of temporary disk and breached the 15 GB production floor twice; source of the spike NOT identified - ruled out: production DB/WAL, mutation runner, pagefile growth, snapshot attach); `certify-next-session` (needs a 30 GB production snapshot; it is the pre-market production-state check, no evidence it was run for the `32613911` deployment; the 40 MB critical-state export was NOT substituted).
* **Restart sequence executed:** state verified (flat, reconciliation MATCH, paused, disk 20.6 GB) -> `watchdog-stop` -> `argus stop` (graceful, confirmed) -> independently verified old pid 25116 gone, port 3000 free, WAL 0 bytes, no engine children -> `git checkout --detach db14216b` -> `npm run build` OK -> `ARGUS_SKIP_OLLAMA=true argus start` (new pid 29184, `SAFE_MODE`, paused, watchdog restarted, no lockout) -> reconciliation MATCH, no positions -> **guarded `argus resume` -> TRADING_ENABLED at 13:38 ET**.
* **Post-resume verification:** phase RUNNING, PAPER, LIVE_NO_GO, no emergency stop; 90/90 subscriptions fresh; Technical/Kronos TICKING, Macro SUCCESS, Quant active; consensus rounds occurring (first SOXL round declined: 1 of 2 agents, confidence 0.50); 80 ideas generated, 0 dropped in the first minutes, `ideasDroppedByAgent` field present (new code loaded); reconciliation MATCH; no positions, no new orders; engine RSS 715 MB; disk 21.3 GB; WAL 54 MB; watchdog running, 0 restarts.
* **PROTECTIVE-EXIT FIX:** code ACTIVE (new snapshot fields present, certified by replay/mutations). Behaviour under real saturated traffic is NOT_VERIFIED in production (no position open; no production order will be created to test it).
* **Remaining issues:** (1) `BUDGET_MISMATCH` readiness alert: `settings.budget=$20,000` (allocation profile, operator decision 2026-10-12) vs stale `ARGUS_EXPECTED_BUDGET=10000` in `.env`; observability only, present all session; fix at the next restart after the owner confirms $20,000. (2) Boot-time stalls observed in the first 3 minutes: 5.3 s event-loop lag, retention-sweeper DELETEs of 1.5-2.6 s, a 6.9 s `kronos_predictions` select (D9/D10/D3 class, deferred): relevant for any future restart with an open position. (3) Still no broker-side protective stops; no full recoverable DB backup. (4) Old CLI lifecycle defects remain until `eb92f821` is deployed. (5) Jev remains idle until the larger release.
* **ROLLBACK:** stop gracefully, `git checkout --detach 32613911842dfce05b722360bf67b7fb673dbb7b`, start paused, reconcile, guarded resume. No schema or `.env` difference, so no data or configuration restore is needed; database records written after restart are not recoverable from a Git rollback.

## 8. SECOND RESTART (14:02-14:04 ET): Jev shadow scoring flag enabled
Owner-directed. Same certified code (`db14216b`); only `.env` changed (`ARGUS_JEV_SHADOW_SCORING_ENABLED=true`, previous `.env` backed up). Sequence: state verified (flat, reconciliation MATCH, disk 21.1 GB) -> `watchdog-stop` -> `argus stop` (graceful) -> pid 29184 gone, port 3000 free, WAL 0 -> `ARGUS_SKIP_OLLAMA=true argus start` (pid 29024, `SAFE_MODE`, paused; watchdog 19084, no lockout) -> reconciliation MATCH, no positions -> guarded `resume` -> TRADING_ENABLED, 30 subscriptions ramping. **Correction to section 3 D7 / the Jev document:** Jev's API was already live through the advisory path; only the shadow ledger was idle. First shadow ledger row: NOT yet verified at the time of writing. Rollback for this step: delete the `.env` line, restart. The stale `ARGUS_EXPECTED_BUDGET=10000` was deliberately not changed (needs owner confirmation of $20,000).
