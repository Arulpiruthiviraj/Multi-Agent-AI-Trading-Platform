# ARGUS Phase 18 — statistical validation report

| Test | CORE on real data | Golden SMA fixture |
|---|---|---|
| Permutation | UNTESTED | Harness exists; not promotion |
| Monte Carlo | UNTESTED | Existing `MonteCarlo.ts` is scenario analysis, not proof |
| Sensitivity | UNTESTED | SMA neighborhood only |
| Cost stress | UNTESTED | SMA multiples only |
| Multiple testing | Warning if trials > `multipleTestingWarnAboveTrials` | N/A |
| Kelly | KELLY_UNAVAILABLE below sample floor; **not** RiskEngine sizing | N/A |

**NO EDGE** claimed.
