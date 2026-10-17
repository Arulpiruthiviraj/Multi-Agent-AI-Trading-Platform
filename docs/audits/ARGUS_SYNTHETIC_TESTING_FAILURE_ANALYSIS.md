# Argus synthetic testing failure analysis — October 15, 2026

## Purpose

Thousands of passing tests did not prevent an October 15 protective-exit rate-limit defect from reaching production. This report distinguishes tests that missed a real failure path from features that were never within a test's scope. A synthetic pass proves only the modeled behavior; it does not prove profitability or organic readiness.

## Confirmed escaped defect: protective exits under idea saturation

**Production failure:** the first-come global research cap was also applied to protective-exit ideas. During the morning, owner telemetry reported 118/120 slots occupied and no broker-side stops, so new entries were paused until a fix was certified.

**Why prior synthetic certification missed it:** the October 14 certification-gap note and the new D1 test's comments identify two concrete gaps: prior synthetic sessions disabled MacroAgent and did not run Kronos at production rate, so total traffic never saturated the 120/min cap; and the exit oracle allowed a 15-minute grace, so a delayed/retried exit could still pass even when same-tick delivery failed. The defect was in a production shared boundary that the low-volume fixture did not exercise.

**Correction/test:** commit `db14216` exempts a genuine protective exit using a dual-key predicate, tracks drops by agent, and adds `src/server/certification/productionFailureReplay/D1_protectiveExitUnderIdeaSaturation.test.ts`. D1 drives the real EventBus and limiter with 162/min research traffic, asserts saturation as an anti-vacuity precondition, checks same-tick delivery, rejects agent-only/origin-only spoofs, and preserves the 0.75 and two-independent-group configuration. Commit summary: 6 files changed. The operator's 13:38 event reports full suite 870 files/7,081 tests and 16/16 mutations caught; this audit did not rerun that full suite against the 30 GiB production DB. D1 itself is inspectable source-level evidence; the historical full-suite result is event-recorded rather than independently rerun here.

## Disk guard failure

**Observed behavior:** after the disk drop, the operational safety pause event states the guard's pause call failed and the owner paused manually. The temporary script at `%TEMP%/J/disk_floor_guard_v3.cjs` uses `execFileSync(cmd.exe, ['/d','/s','/c', concatenatedCommand])`, so it still launches a command shell. It also reads `GUARD_FLOOR_GB` from its inherited environment; a later state reason says the threshold was 500 GB, while the script's default is 15 GB. This path is not an official repository component, and there is no reviewed argument-safe regression test or verified final-state check in the repository. The exact failure mechanism cannot be proven solely from the “npm spawn” message.

**Test gap:** a test should invoke the pause executable and its arguments as an array without `cmd.exe`, inject `PATH`/spawn failures and shell metacharacters, assert the final state from the authoritative CLI/status endpoint, assert one alert per transition, and verify a pause never automatically resumes. A low-space simulation must use a fake filesystem metric and isolated runtime, not manipulate the host disk.

## Broader test-fidelity matrix

| Failure area | Evidence on Oct. 15 | Why existing unit tests can miss it | Needed regression/certification | Status |
|---|---|---|---|---|
| Protective exit under rate saturation | Owner pause; `db14216`; D1 test | Disabled traffic sources and permissive delayed-exit oracle | Already added D1 against real EventBus limiter; test old code fails on same-tick exit assertion | Fixed/test present; historical full-run certification reported |
| Disk guard pause | Guard failed; temporary source shells out; 500 GB reason ambiguity | Not part of ordinary server unit test boundary; external temp script/config not under repo test control | Argument-safe process invocation, failure-injection, authoritative final-state verification, threshold config validation | Not verified/fixed in repo |
| Sudden 7–8 GB disk allocation | Monitor samples bracket abrupt fall | Typical unit tests use stable filesystem and small artifacts | Isolated fake disk provider, large temporary allocation simulation, alert and pause under real runtime state machine | Cause unknown; test gap |
| Event-loop and SQLite stalls | RTH lag/stall and slow SQL events; 30.86 GiB DB | Small test DB, mocked repository calls, no realistic concurrent write load | Bounded representative benchmark on separate storage/DB snapshot; stage latency and event-loop lag assertions | Not certified under production scale |
| Retention sweeper D9 | Code/commit exists on main | Unit correctness does not establish database lock/latency under production cardinality | Compare p50/p95/max and event-loop lag on a disposable representative DB; verify no synchronous full scan | Production load effect not verified |
| Agent disagreement/calibration | Strong Quant-only MRNA/MCD rejected; Technical/Kronos mixed directions | Fixtures may inject tidy independent votes or bypass calibration provenance | Replay persisted decision evidence, same calibration row/version, duplicate/stale/opposed evidence, assert fail-closed and exact reason | Needs more integration coverage |
| Rate-limit fairness | 50.5% idea events dropped; drops across agents | Low-volume fixtures never reach cap; static single-agent tests cannot show first-come starvation | Production-rate controlled clock with exact source mix; assert accounting, order, protection, and quantify dropped-by-agent; do not alter cap until evidence | Protective-exit aspect fixed; fairness research remains |
| Provider outage/Jev | 73 provider exhaustion; Jev completed 229 events but zero shadow rows | Mock providers bypass actual routing/config/credential states; a request-completed event is not a persisted score | Offline fake providers with timeout/429/no-route, validate fail-closed fallback, persistence uniqueness and flag/route parity | Not fully verified |
| Subscription/discovery | 2,683 requests, 711 promotions, 10,456 nonpromotions; some movers lack complete bars | Small static watchlists avoid saturation, eviction, provider ack and fresh-tick transitions | Real lifecycle integration with candidate rank, cap, provider ack, stale/failed quote and quantitative assessment | Some earlier tests exist; full-day recall not proven |
| Runtime/CLI/watchdog recovery | 3 runtime session starts; restarts distinct | Direct function tests don't cover Windows process identity, environment inheritance, PID reuse, or drain ordering | Child-process lifecycle tests, stale PID/reuse, restart and reconciliation holds, watchdog storms | Incomplete audit |
| Backup/recovery | `SKIPPED_DISK`, no verified restore | Unit tests cannot prove full-size backup fits available disk or restore is operational | Small isolated backup/restore rehearsal with capacity budget; never against live DB without separate space | Not certified |

## Test model improvements

Argus should maintain separate certification claims:

- **Test A — production-calibrated decision behavior:** replay real persisted evidence and calibration snapshots, with no forced approval. Failure is a certification gap, never a reason to loosen consensus.
- **Test B — mechanical paper capability:** controlled inputs may exercise natural BUY → unchanged Chief/Risk/OMS/PAPER broker → fill → protective exit. It proves mechanics only.
- **Test C — production failure replay:** replay named incident conditions through real subsystem boundaries, with anti-vacuity preconditions and mutations showing the oracle catches the old bug.
- **Research validation:** point-in-time walk-forward/OOS predictive quality, after costs. Synthetic outcomes never count as market edge.

Certification metadata should capture tested SHA, config snapshot hash, database size/cardinality, relevant source mix, event rate, external provider mode, elapsed test duration, memory/disk headroom, assertions exercised and mutation result. A green unit suite must never imply these other dimensions passed.

## Remaining tests to add, in priority order

1. P0: disk pause supervisor uses safe process argument passing; tests spawn failure, shell metacharacters, threshold override rejection/validation, authoritative state confirmation and no automatic resume.
2. P0: production-failure replay for sudden storage pressure, engine drain/restart, watchdog PID identity and unresolved broker state, all using isolated fakes.
3. P1: consensus lineage with high-confidence Quant-only, delayed independent vote, duplicate family, stale data, rate-limited corroborator and exact terminal reason. Assert unchanged 0.75/two-group rules.
4. P1: a shared limiter load test with actual production source mix, per-agent service/fairness metrics and independent counterfactual event replay. No policy change until replay proves a defect.
5. P1: Jev config parity test that separately verifies request completion, shadow row persistence, idempotency, and that shadow data cannot become a vote.
6. P1: subscription lifecycle certification across saturation, eviction, provider acknowledgment and fresh tick into Quant assessment, with candidate symbols and timestamps.
7. P1: SQLite retention and observability benchmarks on a representative disposable database with concurrent workloads and explicit upper bounds. Do not copy the live 30 GiB database while free disk is limited.
8. P2: event-ledger vs transaction-trace reconciliation test; day-scoped counts must use the same decision IDs and preserve missing rows as explicit discrepancies.

## Verdic

The protective-exit defect is the one production escape reproduced and corrected with a focused regression in the audited source. The record supports the specific explanation that old synthetic sessions lacked saturating source traffic and accepted delayed exits. For the disk guard, disk pressure, provider failures, retention latency, and the remaining candidate misses, either no focused test has yet been verified or the production root cause is still unknown. Passing thousands of unrelated tests does not certify those paths.
