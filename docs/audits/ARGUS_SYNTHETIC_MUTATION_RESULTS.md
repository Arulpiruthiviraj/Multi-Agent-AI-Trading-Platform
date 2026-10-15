# ARGUS synthetic mutation results (exact SHA `32613911842dfce05b722360bf67b7fb673dbb7b`)

Method: each mutation reintroduces one defect in an isolated git worktree (never the working tree, never production), runs the certification, and requires it to turn RED **on the intended assertion**. An **unmutated control must be GREEN first** in the same isolated environment, and the source is restored and verified clean afterwards. A mutation that stays green is a certification gap, reported as such. Raw results: `gate_evidence_32613911/unit_mutation_results.json`, `session_mutation_results.json` (+ control files).

## Level 1: unit-level regression mutations (12 defect classes)
Control: **GREEN**. Restored clean: yes. **12 / 12 CAUGHT.**

| # | Defect reintroduced | Detecting assertion (examples) |
|---|---|---|
| M1 | Routine rescue renewals extend eviction immunity (Oct 14 rescue pinning) | MarketDataWorker: routine renewals never create/extend immunity; production-pinning reproduction |
| M2 | Dwell protection released after 10 ticks (CCI/CIEN) | MarketDataWorker CCI regression |
| M3 | Held-position streams become eviction candidates | held-position protection test |
| M4 | Operator report routes lose the heavy-report guard | router mounts `operatorReportGuard` on exactly the declared paths |
| M5 | Score-edge non-promotions fall back to OTHER | no explainer reason falls through to OTHER |
| M6 | Raw confidence used instead of calibrated confidence | best realistic production pair is rejected below 0.75 |
| M7 | Missing lifecycle record treated as a recorded state | NO_LIFECYCLE_RECORD is terminal |
| M8 | Abstention fixture accepts an approval | fixture must fail when it produces an approval |
| M9 | Session stops verifying required production flags / credential absence | session guard refuses a resolved config lacking a required flag |
| M10 | Artifact cleanup stops protecting evidence | protected evidence is never deleted |
| M11 | DEGRADED strategy keeps authority | DEGRADED is terminally NOT_ELIGIBLE |
| M12 | Exploration-health N+1 queries return | query count constant, not proportional to rescue grants |

## Level 2: full-session mutations (real discovery -> consensus -> risk -> OMS -> broker, then independent oracles)
Session: dev-loop Test B (13 lines, 390 bars). Control: **GREEN**. Restored clean: yes. **5 / 5 CAUGHT** on the exact SHA.

| # | Defect injected into production/harness code | Caught by |
|---|---|---|
| SM1 | Commission omitted from broker costs | accounting oracle |
| SM2 | Broker reports a doubled (duplicate/over) fill quantity | accounting oracle, lineage (`POSITION_NOT_EXPLAINED_BY_FILLS`), end-to-end verdict |
| SM3 | Research capital wrong (replay allocation inflated 5x) | `RESEARCH_CAPITAL_BASIS` (allocated 100000 != session capital 20000) |
| SM4 | Protective hard/trailing stop exits never fire | exit oracle (15 violations), certification gate, no SELL of a discovered symbol |
| SM5 | Wall-clock contamination (Date.now not bound to the simulated clock) | `SIMULATED_TIME_INTEGRITY` (100% of persisted events outside the simulated window) |

## What the first attempt taught (kept, not hidden)
On the first full-session run SM3 and SM5 were reported **MISSED**. Both were certification defects, now fixed and re-run on the exact SHA:
* SM3: no oracle compared the allocation the RiskEngine gate used with the capital the session was given. Added the independent `RESEARCH_CAPITAL_BASIS` check.
* SM5: the verdict script crashed on the contaminated session (null recall) and the runner treated "no output" as green. Fixed: verdict is null-safe, and an oracle that crashes can never count as GREEN (`ORACLE_CRASH`).
* SM4 exposed a coverage gap that existed before tonight: no oracle could notice a **missing** protective exit. Added `oracles/exitOracle.ts` (a long position may not stay open past a grace window after a bar closes through `trailingStopPct`).

## Limits
Mutations prove the certification can detect these specific defect classes under these sessions. They do not prove absence of other defects. Not yet mutated at full-session level: duplicate-submit idempotency at the OMS boundary, kill-switch bypass, stale-quote entry, sector-cap bypass.
