# Unknown-defect hunt — October 10 checkpoint

Source checkpoint: f9940d72406e8c9eeeffb8fa0e7ebf8ff86cf384. Isolated repair branch only. This report records newly reproduced defects and explicitly unfinished audit areas; it is not a claim that every file or scenario has been certified.

## Newly reproduced defects

- Exact historical result-cache windows collided within hour buckets. A later bar entered an earlier query. Separate exact result keys and coalesced retry keys repair the verified cache leak.
- Fast Lane quarantine released capacity without cancellation. Regression observed four underlying evaluations under a cap of three. Retain capacity until real settlement.
- Gateway age expiry removed unresolved request ownership. A failing-before regression now requires retention through actual settlement.
- Priority scheduler watchdog released compute capacity while evaluation continued. Regression observed two underlying evaluations under a cap of one. Both provider and compute leases now survive caller timeouts until settlement.
- Expired scheduler candidates retained semaphore waiters. A failing-before regression found one waiter after terminal expiry; repeated-expiry coverage verifies removal without freeing active permits.

## Additional verified implementation/reporting gaps

- Next-session snapshot fallback separately copied DB/WAL/SHM under concurrent writes. A pinned read-only SQLite backup replaces the fallback; the WAL writer regression verifies consistency.
- Partial release probes could overstate readiness without executing required checks. They now report NO_GO with NOT_RUN evidence.
- Synthetic soak histograms stored nanoseconds in fields named milliseconds. Units are corrected.
- Synthetic soak resource stability was marked PASS solely from zero iteration exceptions. Iteration completion is now separate from resource acceptance, which stays NOT_CERTIFIED without validated bounds.
- Windows soak final verification invoked an npx shell shim as a native executable. It now invokes the installed Vitest entry with Node directly; the short smoke exercised that path successfully.

## Unfinished adjacent checks

External-evaluation registration age expiry has no verified cancellation evidence, and its API has no production consumers found in the current tree. Scheduler-instance restart and flag-transition behavior with unresolved work needs further certification. The priority scheduler and the compatibility queue, plus the two reviewed lifecycle workflows, need canonical ownership review. Universal point-in-time replay, provider available-at fidelity, real intraday coverage and every full-day scenario are not certified by the targeted regressions.

The complete full-suite run and three-hour wall-clock synthetic run are in progress on the source checkpoint. No running production engine, environment configuration, strategy authority or broker account was changed. LIVE_NO_GO remains authoritative.

## Existing expected-failure coverage

src/server/testing/slow/tier4/quantFastLane180s.test.ts uses it.fails for the legacy scheduler's 180-second admission target. That known unmet target must not be counted as certified merely because Vitest reports an overall green run. Its preconditions and the new priority scheduler's corresponding production-path SLA still need independent certification.

Update: full suite at f9940d7 finished with two reproduced fixture failures (6,562 passing tests). The fixtures and regression scope are explained in the master defect register. Neither report is a complete certificate; the new checkpoint full run remains required. The three-hour synthetic process continues on unchanged production code, with seeded authority kept isolated.

October 10 follow-up: 1bc3992 full suite passed (793 files / 6,565 passing tests plus one expected failure and one skip). Prior-code synthetic soak completed 182.774 minutes / 63 iterations; resource stability NOT_CERTIFIED. External expiry/unregister ownership, terminal-stop fallback/restart overlap, and provenance future-timestamp suppression were subsequently reproduced and repaired with failing-before regressions. Ownership/provenance targeted tests: four files / 43 tests passed. Release status aggregation: eight tests passed. Current-source full validation remains required, as do universal ownership/cancellation certification, complete release-driver attestation and combined scenario/backup/watchdog/resource certification.
