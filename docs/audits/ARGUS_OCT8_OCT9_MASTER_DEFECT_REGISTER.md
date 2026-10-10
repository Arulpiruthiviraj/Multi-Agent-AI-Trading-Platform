# October 8–9 master defect register — integration checkpoint

Updated October 10, 2026. PAPER only; LIVE_NO_GO. This register is a checkpoint, not a complete release certificate. The machine-readable companion is ARGUS_OCT8_OCT9_HARDENING_MATRIX.json. Its 75 entries represent audit areas, not 75 proven defects. Unverified fields must remain unverified until supported by source, tests and runtime evidence.

## Confirmed isolated repairs

- Exact historical query cutoffs collided in hour-bucket result-cache keys, allowing later bars into an earlier query. Fixed using exact result keys, with separate retry scheduling keys. Regression failed before the fix; no universal point-in-time guarantee is claimed.
- CLI certification fallback copied DB/WAL/SHM separately during writes. Replaced by a pinned read-only SQLite backup; concurrent-WAL regression passes. Large-database/resource behavior remains unverified.
- Windows snapshot cleanup used a slash split rather than path.basename. Corrected; cleanup is limited to the generated snapshot directory.
- Partial policy/data probes could claim release readiness without executing required runtime checks. They now explicitly report NO_GO and NOT_RUN evidence. A complete release certification driver remains unfinished.
- Fast Lane quarantine returned capacity without cancelling underlying work. Regression reproduced four running evaluations under a cap of three. Quarantine retains the slot until actual settlement. Genuine hung-work recovery remains unfinished.
- Gateway age expiry deleted in-flight ownership while work remained unresolved. A failing-before/passing-after regression now requires ownership until settlement. The age timer reports overdue work without permitting a replacement request.
- A stale historical tail survived an empty provider refresh. The merged path now fails DATA_STALE when no valid alternative provider evidence exists; stale retry cooldown also remains fail closed.

These repairs are in the isolated integration branch. They are not deployed or runtime-certified. No lifecycle promotion, consensus relaxation, manufactured trade or broker bypass accompanies them.

## Current evidence and limitations

The combined targeted run passed 67 tests across six files before the additional gateway ownership regression; the gateway then passed 31 tests with that regression. Typechecking passed before the last gateway edit and must be repeated on the checkpoint. Full-suite and build verification must use the final merged source, not the earlier 6,402-test result.

The fresh read-only production-state policy probe captured 2026-10-10T13:13:09.766Z found six strategies under the isolated process configuration: zero authorized, one ineligible, five missing authority. This is not the October 9 runtime inventory of 21 strategies, and does not reproduce the live .env configuration. No authorization was seeded or changed.

The scheduling stress test represents three accelerated scheduling hours. It does not establish a three-hour wall-clock resource/provider soak, Java strategy correctness, organic paper execution or profitability.

## Remaining release work

- Review the newly integrated priority scheduler, lifecycle certification bridge, provenance and retention changes, including duplicate legacy interfaces and flag transitions.
- Complete point-in-time and full-session scenario coverage, production-state configuration equivalence, cancellation/recovery and chaos verification.
- Run final-source full suite, typecheck and production build; independently record failures and expected-failure scope.
- Run multi-hour wall-clock resource/provider soak, large backup stress, watchdog recovery and next-session end-to-end certification.
- Integrate to main only after verification; deploy only after required certification. Keep unsupported readiness NO_GO.

Historical audits remain immutable. This document does not replace docs/architecture/ARGUS_ARCHITECTURE.md or the operational contract in AGENTS.md.

## Subsequent scheduler repair

The priority scheduler repeated the in-flight ownership defect: a new regression measured two underlying quant evaluations under a pool cap of one. Quant and data-fetch semaphore capacity now stays held until actual settlement, even after caller timeout/terminal expiry. Dedup keys also stay owned while work is unresolved. Tests cover different-symbol overflow refusal, same-symbol dedup after expiry, provider timeout ownership, actual late settlement and exactly-once terminal outcomes. External-registration expiry and restart/recovery across scheduler instances still require separate review; these tests are not cancellation certification.

The initial checkpoint full-suite run was stopped when this defect was found. Its partial result is not reused as final verification. The initial checkpoint typecheck and build passed; both must be repeated after this repair.

## Hidden waiter and soak reporting findings

A failing regression found expired scheduler candidates retained ungranted semaphore waiters. The repaired terminal boundary removes those waiters without returning a permit held by actual running work. Scheduler-related targeted verification: three files, 30 tests passed.

The short synthetic smoke completed one session in 3.7117 minutes with zero iteration errors and zero session fills; the independent execution-path proof passed five tests. The old report mislabeled nanosecond event-loop samples as milliseconds and marked resource stability PASS merely from zero iteration exceptions. Units are corrected; iteration completion and resource acceptance are now separate, with stability NOT_CERTIFIED until validated bounds exist. The smoke does not prove organic readiness, all providers down or a three-hour soak.

## Full-suite outcome and fixture repair

Checkpoint f9940d7 full suite completed with 792 passing files and one failing file: 6,562 passing tests, two failures, one expected failure and one skipped test. Both failures reproduced in the isolated PredictionOutcomeEvaluator suite; they were not classified as flakes. Its restart/backfill fixtures shifted prediction timestamps a few milliseconds earlier while only seeding the unshifted horizon endpoint. The corrected exact-window cache properly excludes that future endpoint. The fixtures now include a legitimate prior-minute endpoint, and a new functional regression explicitly refuses earlier-cutoff grading after a wider query warmed the cache. The production outcome evaluator and its endpoint/freshness gates are unchanged. Related outcome/cache tests: two files, 30 tests passed. Full validation must be repeated on the new test checkpoint.

A current read-only probe with copied production strategy flags captured 2026-10-10T13:31:45.672Z confirms the 21-strategy inventory: zero authorized, one ineligible, 20 missing lifecycle authority. No strategy was promoted. The earlier six-strategy diagnostic represented the isolated flag configuration and remains separately scoped.
