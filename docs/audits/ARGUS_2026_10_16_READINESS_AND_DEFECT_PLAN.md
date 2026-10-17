# Argus readiness and defect plan — Friday, October 16, 2026

**Decision basis:** post-market October 15 snapshot. This is an operational assessment, not a trading instruction or deployment authorization.

## Readiness verdic

**NO_GO for automated PAPER entries from the evidence currently available. LIVE remains `LIVE_NO_GO`.** The current runtime status reports PAPER, `SAFE_MODE`, `TRADING_PAUSED`, API/database running, and no active emergency stop. It does not establish market-hours quote freshness; the check occurred after the regular close and the UI was headless. Do not resume entries solely because the engine responds to status calls.

The deciding blockers are the unexplained multi-gigabyte storage event, failed disk guard action, conflicting 15 GB versus 500 GB threshold evidence, lack of a verified restorable backup for a roughly 30.86 GiB database, and unresolved latency/retention behavior at that scale. October 15 also had zero Chief approvals and no orders, which is not itself a paper-safety defect, but says nothing about tomorrow's edge.

## Confirmed status register

| ID | Severity | Finding | Status | Required action |
|---|---|---|---|---|
| P0-1 | P0 safety | Protective exits were subject to the shared 120/min cap. Fixed by dual-key protective-exit exemption and per-agent limiter accounting. | `FIXED_AND_TESTED`; commit `db14216`; runtime resume event names SHA and certification. Full organic protective-exit execution not evidenced for Oct. 15. | Keep exemption tests and same-tick delivery assertion; no threshold change. Verify exact SHA and current production certification before next enable. |
| P0-2 | P0 safety | Disk guard pause command failed; manual pause needed. Temporary script still invokes `cmd.exe /c` and inherited threshold may have been 500 GB. | `VERIFIED_PRODUCTION_DEFECT`; `NOT_FIXED/CERTIFIED` in repository. | Keep entries paused until a reviewed, argument-safe guard with validated threshold and authoritative state confirmation passes isolated failure-injection. Do not deploy unreviewed temp script. |
| P0-3 | P0 reliability | Sudden free-space fall ~18.42→10.43 GB was observed over samples; cause not identified. | `NOT_VERIFIED` root cause. | Identify responsible allocations from OS/application telemetry; keep bounded continuous disk monitor. Do not run full DB copy, compaction or large tests on the constrained volume. |
| P0-4 | P0 recovery | DB ~30.86 GiB and maintenance state `SKIPPED_DISK`; no full restorable backup verified. | `NOT_CERTIFIED`. | Measure required backup/restore capacity on a separate adequate volume and perform a restore rehearsal before relying on this DB for recovery. No destructive migrations. |
| P1-1 | P1 | RTH consensus event ledger has 22,749 completed rounds; `transaction_traces` bounded query shows 32,119 rows with different terminal distribution. | `NOT_VERIFIED` cross-ledger mismatch. | Reconcile by decision/trace IDs using bounded indexed windows; document missing/duplicate rows and source-of-truth contract. |
| P1-2 | P1 | Shared first-come cap dropped 17,801/35,230 ideas (50.5%) across agents. Effect on unique profitable opportunities is unknown. | Protective-exit slice fixed; research fairness deferred. | Offline causal replay of actual request order/source mix; quantify service suppression before proposing scheduler changes. Preserve 120 cap and consensus rules. |
| P1-3 | P1 | 42 event-loop lag warnings, 3 stall events; prior bounded report measured slow SQL. | `PERFORMANCE_BOTTLENECK`, root call stack `NOT_VERIFIED`. | Capture async stacks/correlation at stall time; benchmark retention/persistence on representative isolated DB before any production scheduling change. |
| P1-4 | P1 | Jev completed 229 decisions but zero `jev_shadow_scores` rows for audited day. | Shadow persistence `NOT_VERIFIED`; no vote authority. | Validate feature flag/effective config, write outcomes and uniqueness in isolated test; keep SHADOW_ONLY. |
| P2-1 | P2 | Market data and missed-mover point-in-time evidence is incomplete; IP minute coverage ends at 11:25 EDT and several candidates lack local bars. | `NOT_VERIFIED`. | Improve timestamped provenance and complete quote/bar lifecycle observability. |
| P3-1 | P3 research | Strategy/agent OOS edge is not established; confidence calibration and independence may explain refusals. | `RESEARCH_LIMITATION`. | Conduct matched, walk-forward calibration and opportunity-recall research. Do not lower gates or promote from a single day. |

## Before any supervised PAPER entry session

An operator should separately confirm, using current evidence at the session boundary:

1. Current running image SHA equals the intended certified commit; runtime remains PAPER and LIVE_NO_GO.
2. Reconciliation is a clean `MATCH`, position/order state is understood, and no unresolved orders exist.
3. The disk guard is the reviewed implementation, has a validated threshold, has demonstrated an actual pause in an isolated test, and checks the final trading state. Storage headroom includes the observed multi-GB swing plus DB/WAL growth.
4. Fresh authenticated broker transport and at least one current valid quote from the active feed are present; subscription occupancy alone is insufficient.
5. PortfolioMonitor/protective-exit path and watchdog are healthy; no stale PID or restart storm is present.
6. Event-loop lag, memory, disk and DB write latency remain within previously validated limits. If such limits are not defined, treat that as unresolved rather than inventing a pass threshold.
7. All automation is supervised. A saved $20,000 Argus allocation is not broker equity, not an order, and not evidence of available buying power.

These are release prerequisites, not evidence already passed in this post-close audit. Keep trading paused until the operator explicitly authorizes a supervised PAPER session after reviewing fresh checks. No `.env` changes, threshold changes, or runtime restart were made here.

## Fix sequence

**P0 today / before any entry session:** reproduce and fix the disk guard safely in a repository-owned component or remove reliance on the ad hoc guard; test command argument safety, forced spawn failure, threshold validation, final-state readback, no auto-resume, single alert and watchdog interaction. Determine the disk allocator from OS/application records. Establish a restorable backup path on a different volume with verified capacity.

**P1 next:** reconcile consensus and transaction-trace ledgers by decision IDs; add a bounded production-rate limiter replay measuring unique vote episodes and service delay; validate Jev shadow persistence; add event-loop stall attribution and a representative isolated large-DB retention benchmark.

**P2 after reliability:** collect point-in-time market data and discovery lineage for TTD, IP, CSGP, AJG, INTU, LLY and UNH; replay MRNA/MCD exact decision windows; evaluate strategy coverage, calibration and OOS expectancy independently of deployment.

## Release and evidence boundaries

- `db14216` is the checked-out SHA and the current process's source directory was verified. The runtime event explicitly records the protective-exit fix as deployed/certified and entries resumed at 13:38 after reconciliation. No independent artifact manifest ties every runtime process to a binary image, so retain this as source/runtime evidence rather than cryptographic build attestation.
- The audit's reported full suite was 870 files / 7,081 tests with 16/16 mutations caught, per the operator event. This review did not rerun that suite or a full-size DB benchmark.
- No new code changes, merge, push, restart or deployment were made for this report.
- `PAPER_READY` is not established by the day's tests or by the runtime being in PAPER mode. Supervised PAPER is conditional on fresh operational proof; LIVE remains NO_GO and empirical edge is not established.
