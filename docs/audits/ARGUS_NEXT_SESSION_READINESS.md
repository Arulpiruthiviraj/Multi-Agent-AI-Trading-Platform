# ARGUS next-session readiness: deployment, rollback and verification (Thursday, October 15, 2026)

PAPER only. LIVE_NO_GO. Nothing in this document has been executed against production. **Deployment requires explicit permission through the platform's approval interface; a denied permission is not worked around.**

## 1. Candidate and what it changes in production
* Code candidate SHA: see `ARGUS_FINAL_RELEASE_READINESS.md` (frozen at `32613911842dfce05b722360bf67b7fb673dbb7b` unless that file says otherwise). Currently running: `3a5eacdc`.
* Production-behavior delta versus `3a5eacdc` (everything else in the diff is tests, synthetic harness, docs):
  1. `operatorReportGuard` mounted on 22 CLI report routes; `rescue-outcomes` / `exploration-health` queries batched (removes the freeze path).
  2. `temporaryDataRescueRoutineRenewalGrantsImmunity=false`, `minDynamicDwellReleasesOnTicks=false` (`config/continuousIntelligence.json`).
  3. `MarketDataWorker.setHeldSymbols` (called each `PortfolioMonitor` cycle): held symbols are never eviction candidates.
  4. `SCORE_EDGE_NOT_MET` reason code (observability only).
  5. `POST /api/v1/system/strategy-lifecycle-baseline` + CLI (dry-run by default; **not applied by deployment**).
  6. `core/alpacaTls.ts` synthetic provider seam: inert unless `SYNTHETIC_SIMULATION=true` in a synthetic/test process.
* No change to: consensus thresholds, independence rules, RiskEngine gates, sizing, OMS, brokers, lifecycle authorization, kill switch, PAPER/LIVE arming.

## 2. Deployment plan (executed only after approval)
1. Precondition check: `argus-cli status`, reconciliation MATCH, no open orders in unknown state; note the open positions and current `trading_state`.
2. Back up: `GET /api/v1/system/export-db` or a consistent online-backup copy (free disk >= 15 GB; ~40 GB currently free after lossless snapshot compression).
3. Graceful stop through the CLI (`argus-cli stop`; in-process drain via `POST /api/v1/system/shutdown`).
4. In the production checkout (`C:\WorkProjects\Multi-Agent-AI-Trading-Platform`, currently detached at `3a5eacdc`, clean tree): `git fetch`, `git checkout <candidate SHA>`. The engine runs from source with `tsx`; no build is needed for runtime (`dist/` is not used).
5. Start with `ARGUS_SKIP_OLLAMA=true` set in the environment of the start command (see the restart runbook), wait for the first reconciliation cycle to report MATCH (an initial `ACCOUNT_VALUATION_UNAVAILABLE` blip can occur), then `resume` only if reconciliation is clean. Do not ack-and-resume blindly; do not auto-flatten.
6. Do **not** enable any flag. Do **not** apply the lifecycle baseline as part of deployment (separate owner action; see section 5).

## 3. Rollback plan
* Trigger: any failed verification item below, an engine freeze, unexpected position/order divergence, or the owner's instruction.
* Procedure: graceful stop; `git checkout 3a5eacdc` in the production checkout; start with the same sequence (skip Ollama, wait for reconciliation MATCH, resume only if clean). The database is forward-compatible (no migration is part of the candidate: `git diff 3a5eacdc..<candidate> -- drizzle` is empty), so the backup is a safety net, not a required restore.
* Evidence retained for rollback decisions: pre-deploy backup, `data/logs`, the verification outputs below.

## 4. Post-deployment verification (all must be reported, with actual outputs)
| Check | How |
|---|---|
| Runtime SHA is the candidate | `git rev-parse HEAD` in the checkout and the engine's reported build/health info; process start time after the checkout |
| PAPER, not LIVE | `PAPER_TRADING_ONLY=true`, `GET /api/v2/live-readiness` = `LIVE_NO_GO`, no LIVE arm |
| Active broker and account class | `argus-cli status`; account id class DU* (paper) per `ibkrAccountClassification.json` |
| Market data healthy | `GET /api/v2/runtime/...` feed status: connected, 90-line cap reported, subscriptions occupied, at least one fresh valid quote |
| Reconciliation | latest cycle MATCH; no unresolved `RECONCILIATION_MISMATCH` |
| Risk protections | `trading_state`, gates present (`riskGateOrder.json`), PortfolioMonitor cycling, held positions (if any) have live marks; kill switch states reachable |
| Strategy authorization | `argus-cli strategy-lifecycle-baseline --reason=... ` **dry run** output; confirm that without the owner applying it Quant remains `NO_LIFECYCLE_RECORD` |
| Report guard | one heavy report returns normally; a concurrent second returns 429 `CONCURRENT_HEAVY_REPORT` (do not burst production) |
| Monitoring | watchdog running (`watchdog-status`), event-loop lag normal, disk free |

## 5. Decisions only the owner can make (none taken)
1. Apply the UNTESTED lifecycle baseline for the four non-retired CORE strategies (grants no authority; restores Quant's votes into consensus). Expected effect on tomorrow: Quant votes appear but, with its current calibration and EV/R:R filters, approvals remain unlikely.
2. Whether to change STRONG-tier calibration-sufficiency policy or the outcome-grading order (see forensics document). Neither is in the candidate.
3. Whether to free disk by pruning operator-managed `data/backups` (~100 GB). The two forensic snapshots were preserved and losslessly compressed in place; no source was deleted.

## 6. The morning question: can the actual PAPER configuration independently produce a legitimate BUY approval?
**Not on the production calibration table.** Real Oct 13 and Oct 9 bars through the real agents produced 0 approvals (max confidence 0.594 / 0.792); the same bars with a labeled calibration fixture produced 12 and 30 approvals. The software path is proven (Test B). The blocker is evidence quality: no agent shows out-of-sample skill. Tomorrow can be a correct zero-trade day.
