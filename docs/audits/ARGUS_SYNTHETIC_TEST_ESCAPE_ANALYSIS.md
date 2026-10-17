# Synthetic test escape analysis

**Purpose:** explain the gap between green synthetic capability tests and defects observed during Oct. 12–16. This report separates verified escape mechanisms from unproven claims about individual missed trades.

## Confirmed gaps

1. **Disk safety policy drift:** `scripts/ops/diskFloorGuard.ts` enforced a configured 26 GiB reserve, while `scripts/sim/artifactLifecycle.ts` used a separate 15 GiB floor and allowed `ARGUS_SYNTH_MIN_FREE_DISK_GB=8`. The market-open parent did not preflight its temp database volume. The tests asserted that a configurable positive value worked, not that the value matched the operational disk policy or that the market-open launcher checked the temp volume. This is now corrected on `main`: the synthetic artifact floor is 26 GiB, the lowering override is removed, parity is tested, and the market-open parent checks the DB volume before spawn.
2. **Capability is not production-shaped replay:** a positive seeded-calibration simulation demonstrates that the protected path can approve and execute under its fixture. It does not demonstrate that organic calibration, discovery, provider availability, source traffic, or point-in-time data would produce a trade. Test A abstention and Test B capability must remain separate verdicts.
3. **Historical records lacked causal fields:** Oct. 16 rate-limit rows lacked side/confidence/strategy/origin/episode identity; near-approval terminal records lacked enough lineage to recover exact strategy IDs, vote arrival times, and source trace. This prevents an exact retrospective “would this dropped vote have changed the verdict?” conclusion.
4. **Production load claims exceed tested scope:** existing deterministic sessions exercise real Argus components, but a bounded small-symbol fixture is not proof of the measured production opening burst, roughly 90 subscription lines, background maintenance overlap, provider waits, or production-scale SQLite contention.
5. **Rate-limit telemetry hid what was suppressed:** Oct. 16 rows omitted direction, confidence, strategy and origin. This pass adds those fields to the existing denial event and asserts them in the already-saturated protective-exit test. It improves future diagnosis only; it does not change the global cap or prove a previously suppressed idea would have changed a trade decision.

## How tests escaped detection

The disk failure class was tested inside the guard module but not as an end-to-end simulator precondition. Separately configurable floors allowed their assumptions to drift. Some synthetic “positive” cases intentionally use a synthetic calibration history; without prominent fixture labels and a negative calibrated case, a green capability result can be misread as natural decision readiness. Existing tests also cannot recover missing fields from production telemetry after the fact.

## Fix-to-test mapping

| Defect/gap | Regression | Result |
|---|---|---|
| Shell metacharacters break disk-pause CLI arguments | `scripts/ops/diskFloorGuard.test.ts`: reproduces legacy failure on Windows, verifies byte-preserving argv call and pause readback | 9 guard tests passed in the focused run |
| Simulator floor drift / lowering override | `scripts/sim/artifactLifecycle.test.ts`: equality with summed `diskSafety.json` reserves, 26 GiB floor, override ignored | Passed after fix |
| Missing market-open preflight | `scripts/sim/marketOpen.ts` calls the same artifact policy and preflight on the DB temp volume before child spawn | Source-reviewed; full simulator deliberately not run due large artifact footprint |
| Rate-limit useful-confirmation suppression | `EventBus.protectiveExitRate.test.ts` verifies bounded candidate lineage while the configured cap is saturated; a separate causal replay is still required | Telemetry fix tested; causal effect remains NOT_RUN |

## Remaining blind spots

No full historical market replay with point-in-time news and quote arrivals was run. No authenticated broker history, provider outage matrix, production-sized DB contention replay, randomized concurrency campaign, or mutation campaign was run for this report. Do not claim all defect classes are caught. The next certification pass should make each scenario return `INVALID_TEST — TARGET CONDITION NOT REACHED` unless its intended fault and recovery were observed.
