# Controlled PAPER diagnostic deployment — October 9, 2026

Observation cutoff: approximately 15:46 ET. This is an engineering deployment record, not strategy certification or evidence of alpha.

PRE_DEPLOY_SOURCE_SHA = ea62053460406f1dce85276cc9943a97f8de7617
PRE_DEPLOY_BUILD_SOURCE_SHA = f3ec4d2379f93623b54b1898299d04257b6aaae1
TESTED_PATCH_SHA = a66e8e12bf5a94b6aa5bb8436bf2debada0ccaca
DEPLOYED_BUILD_SOURCE_SHA = 19ae895894b84ed1cc48689f847ed13dd5186965

The source revision is established by the checked-out commit, successful production build and subsequent production process launch. An independent runtime SHA attestation was not obtained. The only merge conflict was in the living architecture document; both notes were preserved. Runtime-generated maintenance/watchdog files were not committed or reset.

## Validation

Diagnostic regression: 16 files, 145 tests passed in the isolated worktree. Additional maintenance safety regression: 6 files, 163 tests passed (RiskEngine, PositionSizing, PortfolioMonitor, OMS position/fill evidence, reconciliation short semantics and backup worker). POSITION_FILL_CONFLICT, short/negative-position and correlation-exposure behavior covered by these suites. This does not claim a separate historical OKTA replay. Final integrated typecheck and production build passed. Full suite not run for this maintenance window.

## Deployment and current safety evidence

Old engine PID 32528 shut down gracefully; process exit and absence of duplicate engines were checked. New production engine PID 1020, created 15:42:52 ET, started without automatic resume/watchdog. Core boot completed 15:44:54 ET. Initial state was TRADING_PAUSED. Authenticated normal reconciliation was clean, broker sync READY, positions empty, capital diagnostic open orders zero. Reconciliation's broker-order read reported no error. The capital endpoint can fall back to local pending orders if its broker order read fails; its count alone is not independent remote-order certification.

PAPER_TRADING_ONLY=true and ARGUS_TRADING_MODE=PAPER were verified without printing secrets; runtime reports PAPER and LIVE NO-GO. Emergency stop inactive. AAPL/SPY fresh quotes confirmed; SNOW remained requested at that particular post-start sample. This proves partial feed availability, not every candidate's coverage.

Normal CLI resume succeeded with TRADING_ENABLED, then watchdog restored (PID 3844). One engine remained. Autobot enabled, emergency stop inactive. No safety/alpha thresholds, lifecycle records, strategy pools, account configuration or .env values changed. No migration added.

Backup restart safety: latest published backup approximately 09:50 ET, daily interval means recent-backup startup skip; worker-based backup implementation verified. Maintenance marker SUCCEEDED, no partial backup files found, approximately 96.5GB disk free. Post-start maintenance marker shutdownInProgress=false. No large backup was forced.

## Immediate observations

Read-only indexed telemetry, from process creation through approximately 15:46 ET:

- QUANT_CYCLE_STARTED: 1
- QUANT_SYMBOL_EVALUATION_STARTED: 3
- QUANT_SYMBOL_EVALUATION_FINISHED: 2
- QUANT_BAR_INPUT_AVAILABILITY: 26
- QUANT_SELECTION_POOL: 23
- TRADE_IDEA_GENERATED: 67
- CHIEF_APPROVED_IDEA: 0
- RISK_ASSESSMENT: 0
- ORDER_SUBMITTED / ORDER_FILLED: 0 / 0

Counts are event-type-specific persisted observations, not a claim that every causal stage has completed or that every production fill necessarily uses these event names. Bar/selection assessments also occur outside the scheduled cycle; counts are not one-to-one scheduled attempts.

Quant readiness before restart: 21 strategies, zero authorized Quant-policy strategies, 20 missing lifecycle records, PULLBACK_CONTINUATION retired. No authorization change deployed. Quant policy authorization remains blocked; normal consensus path remains available subject to all existing gates. Exact post-restart per-idea first blocking reasons require subsequent trace review; the global authorization inventory alone does not explain every consensus rejection.

Post-start resource sample: RSS approximately 1.25GB, event-loop p95 approximately 91ms, p99 approximately 1398ms, max approximately 2033ms; queue pending zero. Short window only: reliability/soak not certified. New diagnostics active; optional input capture remains OFF.

## Deferred work and readiness limit

PAPER capability restored through the normal safety pathway. Unattended readiness and profitable trading are not certified. LIVE_NO_GO unchanged.

POST_CLOSE_PRIORITY_P1: scheduler latency/fairness and provider backoff reconstruction; reviewed lifecycle certification/promotion bridge without fabricated authority; strategy coverage research for adaptive exclusions; complete point-in-time input provenance; memory/provider/event-loop soak. No scheduler redesign or new strategy formula shipped in this maintenance.

Companion health: Java Quant Core connected (HTTP 200), Chronos/Kronos and Ollama READY. OpenAlice verification failed (fetch failed); its reported role is advisory/fire-and-forget and does not gate RiskEngine. VectorBT research not configured. These were not repaired in this deployment.

FILES_CHANGED = 13 in the tested patch, plus architecture merge resolution and this deployment record.
ARCHITECTURE_TESTS = PASS (included in 145 diagnostic tests).
OKTA_REGRESSION = POSITION_FILL_CONFLICT regression PASS; dedicated historical OKTA replay not run.
BACKUP_RESTART_SAFE = YES under the verified worker/recent-backup conditions.
RESTART_PERFORMED = YES.
SINGLE_ENGINE = PASS.
PAPER_MODE / LIVE_NO_GO = PASS / PASS.
RECONCILIATION = CLEAN at post-start check.
MARKET_DATA = PARTIALLY FRESH; not all subscriptions certified.
TRADING_STATE = TRADING_ENABLED.
AUTHORIZED_PAPER_QUANT_STRATEGIES = 0 at pre-restart current-runtime query; unchanged authorization code/data.
QUANT_POLICY_REACHABLE = NO authorized strategy shown.
QUANT_SCHEDULER = DEGRADED historical latency; unchanged, new telemetry active.
P0_REMAINING = none newly proven by this deployment, not a zero-defect claim.
READY_FOR_REMAINDER_OF_PAPER_SESSION = conditional supervised capability restored; not blanket readiness certification.

