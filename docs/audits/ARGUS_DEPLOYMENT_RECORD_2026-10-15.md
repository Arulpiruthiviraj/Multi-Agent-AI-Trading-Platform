# ARGUS deployment record, October 15, 2026 (supervised PAPER)

Owner-approved deployment of the certified candidate `32613911842dfce05b722360bf67b7fb673dbb7b` (previous: `3a5eacdc`). PAPER only; LIVE_NO_GO unchanged. Times are ET.

## What was done
| Time | Step | Result |
|---|---|---|
| 07:41 | Pre-deploy verification (read-only) | Production checkout clean at `3a5eacdc`; engine pid 5704 up 18.8 h; PAPER on the IBKR paper account (DU class); `TRADING_ENABLED`, Autobot on; reconciliation MATCH; 0 open positions; 0 trades today; 84/90 fresh quotes; event loop normal; free disk 29.6 GB |
| 07:42-07:50 | Backup | See "Backup" below |
| 07:43 | `watchdog-stop`, then `argus stop` | Graceful shutdown confirmed (process stopped answering /health); WAL checkpointed to 0 bytes; database file unmodified afterwards (29,216,944,128 bytes) |
| 07:44 | `git checkout --detach 32613911...` in the production checkout | Clean tree; `git diff 3a5eacdc..HEAD -- drizzle src/server/db` empty (no schema change) |
| 07:50 | `ARGUS_SKIP_OLLAMA=true argus start` | Boot completed; watchdog started detached (no lockout) |
| 07:51-07:55 | Post-boot verification | See below |
| 07:55 | `argus resume --reason=...` | `TRADING_ENABLED`, phase RUNNING |

## Backup (deviation from the plan, disclosed)
A full pre-deployment copy of the 27.9 GB database was **not possible** on this disk (29.6 GB free): three attempts (online backup, direct copy, chunked copy with per-part NTFS compression) either could not finish while the engine was writing or consumed free space faster than compression released it. Each was aborted by a disk guard before free space fell below the safety floor, and only my own partial files were removed; the production database was only ever read. Instead:
* **Critical-state backup:** `argus_predeploy_critical_state_20261015.db` (40 MB, SHA-256 `ac579066b4c1dbe773b93c701cd74ffc2c1222ad8ca38993a10d287be854336e`) taken with the engine stopped: settings 1, trades 497, fills 195, portfolio 0, kill_switch_events 438, reconciliation_events 7,677, config_overrides 1, learning_versions 82,388, agent_confidence_calibration 41, agent_performance_stats 13, learned_rules 190, trade_plans 776.
* **Full snapshot:** the Oct 14 post-close consistent snapshot (SHA-256 verified, SQLite `quick_check` ok) plus production's own Oct 13 backup remain.
* **Rollback needs no database restore:** the candidate has no migration and no schema change, and the database file was untouched by the checkout.

## Runtime verification after boot (actual outputs)
| Check | Result |
|---|---|
| Runtime SHA | `32613911842d` (`argus readiness`: PASS) |
| PAPER, LIVE_NO_GO | `tradingMode=PAPER`; `evaluateLiveReadiness() = LIVE_NO_GO (23 failed mandatory gates)` |
| Broker / account | `ibkr_gateway` Healthy; paper account; 90-line cap |
| Market data | connected; 30/30 active symbols with a fresh quote at 07:55 (lines fill up to 20 per discovery scan toward the 90 cap) |
| Discovery | scan ran: 122 scanned, 122 shortlisted, 20 subscriptions requested; dwell ages are time-based |
| Repaired settings | `temporaryDataRescueRoutineRenewalGrantsImmunity=false`, `minDynamicDwellReleasesOnTicks=false` in the running checkout |
| Reconciliation | latest cycle MATCH, no mismatches |
| Positions / orders | 0 open positions, 0 trades today |
| Event loop | mean 22.9 ms, p95 21.5 ms after boot settling (mean 2.3 s during boot) |
| Watchdog | running, no storm lockout |
| RiskEngine, OMS, ChiefTrader, PortfolioMonitor | always-on, enabled |
| Strategy authorization | **FAIL (known, not an infrastructure fault):** no strategy has quant-policy authority; missing lifecycle = 20, ineligible = 1 (PULLBACK_CONTINUATION RETIRED). UNTESTED baseline dry run recorded 4 rows (MOMENTUM_BREAKOUT, MEAN_REVERSION, TREND_FOLLOWING, RANGE_REVERSION) and skipped PULLBACK_CONTINUATION; **not applied** |
| AI providers | advisory only: 1 of 10 healthy (quota/billing/unavailable); quant unaffected |

## Final state
Automated PAPER entries are **enabled** (`TRADING_ENABLED`, Autobot on) under the unchanged consensus (0.75, >= 2 independent evidence groups), RiskEngine (27 gates) and OMS. Another zero-trade day remains plausible: no agent has demonstrated out-of-sample predictive skill and no CORE strategy has authority.

## Not done / deferred
No lifecycle baseline applied; no calibration, ChiefTrader threshold or confidence change; no flag changed. Calibration and grading fixes are developing on the isolated branch `dev/calibration-grading` and are not part of this runtime.
