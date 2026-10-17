# Production failure replay catalog

This catalog distinguishes tests that exist from incident scenarios actually run in this audit. “Caught” means a test asserts the failure mechanism or invariant; it does not imply deployed prevention.

| Incident / failure class | Existing source/test | Anti-vacuity evidence | This pass |
|---|---|---|---|
| Disk guard shell metacharacter/redirection failure | `scripts/ops/diskFloorGuard.ts`, `.test.ts` | Hostile reason delivered byte-for-byte; pause accepted only after `TRADING_PAUSED` readback; failure is retried | RUN: suite passed |
| Disk guard malformed/unavailable config | `diskFloorGuard.ts` fail-closed branch | Test verifies invalid configuration and pause verification behavior in module scope | Focused module tests passed; process-level config fault not run |
| Synthetic DB artifact cleanup deleting retained evidence | `scripts/sim/artifactLifecycle.ts`, `.test.ts` | Protected prefixes, recent files, concurrent active artifacts, unrelated files asserted to survive | Existing artifact tests passed |
| Protective exit under idea saturation | `src/server/certification/productionFailureReplay/D1_protectiveExitUnderIdeaSaturation.test.ts` | Test asserts configured limiter is saturated, exit traverses sealed exception, spoof is rejected | NOT_RUN this pass |
| Duplicate broker submission / lost acknowledgment | `src/server/certification/brokerOrderFaults.e2e.test.ts` and OMS tests | Expected to exercise isolated broker faults; detailed per-scenario run manifest not collected here | NOT_RUN |
| Restart with pending work / interrupted session | replay restart battery and recovery tests | Must prove child restart and recovered state, not just mock a callback | NOT_RUN |
| Provider outage / Jev provenance | AI and Jev shadow tests | Must prove provider call is attempted and missing provenance cannot vote | NOT_RUN |
| Oct. 16 low-confidence / one-group rejection | persisted audit; synthetic one-sample witness exists in Oct16 worktree | Need source-equivalent input and assert zero approval without weakening gates | NOT_RUN on this `main` worktree |
| Oct. 16 slow synchronous DB reads | telemetry plus worker-backed candidate changes in separate worktree | Must prove read is off decision thread and deadline behavior under contention | NOT_RUN |
| Market-open burst and source-fairness | `marketOpen.ts`, full-session fault plan | Need event counts, source traffic, ordering, queue/latency and observed terminal outcomes | NOT_RUN |

No test in this catalog submits orders to the production IBKR Gateway. A full catalog run must use an isolated DB and `HistoricalReplayBroker` and retain the run manifest and exact SHA.
