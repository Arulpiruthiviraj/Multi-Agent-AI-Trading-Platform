# Branch integration record - 2026-10-15

Goal: bring every correct change from the remaining unmerged branches onto `main` without regressing newer decisions. Each branch was compared with `main`; nothing was force-merged.

| Branch | Disposition |
|---|---|
| `hotfix/protective-exit-cap` (`db14216b`, deployed) | Content already on `main` as `8b0a47e3` + `398fff50`. Merged with strategy `ours` so the deployed SHA is an ancestor of `main`. No tree change. |
| `cert/universal-discovery` | Every file already on `main` in an evolved form (`SyntheticDiscoveryMarket` etc.). Ancestry merge only; tag `archive/cert-universal-discovery`. |
| `repair/oct13-protective-exit-retry` | Superseded: `main` has the ENTRIES_ONLY pause kind (the branch let a sealed exit pass ANY `TRADING_PAUSED`, which would weaken the FULL pause - rejected), the intent-priority historical scheduler, `riskCapitalEquity` sizing, authenticated probes and the Windows-safe jar lookup. Kept: the branch's research-equity sizing regression test (passes on `main`). |
| `feature/oct13-intraday-and-recovery` | Taken: Windows supervisor, installer, power-readiness check, operations doc and static safety test (5 tests pass). Not taken: persisted historical-request telemetry (adds a table, a colliding `0100` migration and more synchronous persistence on a loop that is already stall-prone; `main` already has the scheduler timing hook) and the exit-retry cooldown (`main` implements it differently). Revisit telemetry as a deliberate, separately measured change. |
| `codex/argus-session-repair-20261009` | NOT merged. It holds the Quant scheduler lease-retention design (semaphore and dedup retained until the evaluation really settles). `main` (2026-10-11) deliberately chose the opposite, quarantine-and-release plus `isCancelled` handoff. Merging would reverse a later design decision in the live Quant admission path; needs an owner decision. Kept: its three audit documents. Branch preserved as tag `archive/codex-session-repair-20261009`. |
| uncommitted edit in worktree `argus-repair-quantfirst` (`ChiefTraderAgent.ts`) | NOT merged. It restores direct approval by the quant policy that bypasses the consensus gate (documented there as an operator exception, 2026-10-12). Uncommitted, unreviewed, and contrary to the standing consensus invariants; needs explicit owner confirmation and its own tests. |
| untracked handoff/runbook in `argus-release` | Added as dated audit documents. |
