# Market-open certification results — 2026-10-17 worktree

**Source:** `main` at base `58c3af2e947b51496f4930d128c822c8d75e40ad`, plus the uncommitted changes in this isolated worktree. **This is a focused verification record, not full premarket certification.**

| Category | Status | Evidence |
|---|---|---|
| SOURCE_BUILD | NOT_RUN | No build in this pass |
| CONFIG_PARITY | PASS | Added test verifies 26 GiB artifact floor equals the sum of disk reserve components |
| UNIT | PASS | Focused disk guard, artifact lifecycle, and saturated EventBus lineage: 3 files, 16 tests passed |
| CONTRACT | PASS | Guard tests cover no-shell argv delivery, verified pause response, retry, idempotency, and policy parsing |
| INTEGRATION | NOT_RUN | No engine or broker integration process was started |
| MARKET_OPEN_REPLAY | NOT_RUN | No large simulation DB created |
| REAL_HISTORICAL_REPLAY | NOT_RUN | No point-in-time full-session replay |
| AGENT_CONSENSUS | NOT_RUN | Historical telemetry was analyzed; no new replay run |
| RISK_SAFETY | NOT_RUN | No trading-path test was run in this pass |
| OMS_BROKER | NOT_RUN | No broker calls or test orders |
| PROTECTIVE_EXIT | NOT_RUN | Existing tests were not rerun here |
| RATE_LIMIT | PARTIAL | Limiter saturation and candidate fields were asserted; no causal source-fairness replay |
| PROVIDER_FAILURE | NOT_RUN | No provider matrix |
| DATABASE_LATENCY | BLOCKED | Heavy production-sized test not run; no second DB copy created |
| EVENT_LOOP | NOT_RUN | No load run |
| DISK_SAFETY | PASS (unit only) | Guard regression tests passed; live threshold event not induced |
| RESTART_RECOVERY | NOT_RUN | No restart test |
| MUTATION | NOT_RUN | No mutations introduced in this pass |
| PERFORMANCE | NOT_RUN | No benchmark |
| PRODUCTION_FAILURE_REPLAY | PARTIAL | Disk guard defect and saturated protective-exit/rate-limit regressions exercised; other catalog entries not run |

The focused test command was run in the isolated `main` worktree. An initial run failed three new assertions against the old 15 GiB value; after applying the corrected 26 GiB policy, all 16 targeted tests passed. The full market-open simulator was not run. Disk availability is about 29.6 GiB at the last direct DriveInfo measurement—only about 3.6 GiB above the floor—and the existing temporary evidence inventory is large. Do not interpret the test pass as full certification or permission to run a heavy suite.

No configuration was changed in the live engine, no broker order was submitted, and no engine was restarted. PAPER readiness and LIVE eligibility are not upgraded.
