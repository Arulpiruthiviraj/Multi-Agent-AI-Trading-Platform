# ARGUS production-faithful synthetic certification (exact SHA `32613911842dfce05b722360bf67b7fb673dbb7b`)

Evidence class SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY (plus HISTORICAL_REAL_BARS_SYNTHETIC_BROKER for the real-bar probes). It certifies engineering behavior under tested conditions. It is not alpha, not organic paper evidence, and not a statement about future profitability. PAPER only; LIVE_NO_GO.

## 1. Why the previous synthetic certification was not credible
October 14 showed the simulator could trade while production could not approve anything. The causes, each now closed in the harness:
1. Agents ran with an **empty calibration table** (raw confidence became decision confidence); production's agents are calibrated (Kronos 0.8 bucket 747W/722L = 0.51). Now: `PRODUCTION_OCT14` calibration profile (real table) must ABSTAIN; positive profiles are labeled fixtures.
2. No lifecycle records existed in sessions, unlike (and sometimes unlike) production. Now: explicit, test-scoped lifecycle state per session; PULLBACK_CONTINUATION kept RETIRED as in production.
3. Discovery was disabled inside sessions (symbols were pre-chosen). Now: the real production scanners and MarketDataWorker allocator run at the IBKR cap of 90 occupied lines with Oct 14 rescue-renewal pressure; hidden-truth market of 500 symbols; only the external Alpaca REST boundary is simulated through a guarded provider seam.
4. Sessions ran on wall-clock time, so production dwell/rescue timing was not exercised. Now: `Date.now` is bound to the simulated clock for discovery sessions (restored afterwards); simulated-time integrity is an asserted oracle.
5. Configuration drift (stale `.env`, missing flags, credentials reachable). Now: effective-configuration guard with sanitized manifest (booleans for credential presence, never values).
6. A harness that cannot fail: abstention counted as pass without explanation; missing protective exit and wrong capital undetected. Now: `ABSTAIN_EXPLAINED` expectation, exit oracle, capital-basis oracle, mutation coverage with a mandatory green control.
7. Evidence loss (cleanup deleted certification databases; disk down to 4.3 GB). Now: retention beside results, protected prefixes, 15 GB preflight (no override used for the release run), lossless in-place compression of the forensic snapshots with SHA-256 verification.

## 2. Test A: production-equivalent abstention. **PASS (exact SHA)**
500-symbol hidden market, 90 occupied lines, 37 routine renewals/min, production calibration table, **no lifecycle records** (the Oct 14 state), 390 bars.
* 0 orders, 0 fills; accounting oracle 0 mismatches; no injected approvals.
* Abstention explained (normalized histogram): `Quant live emit requires a strategy idea that clears live EV and min R:R` 6,253; `strategy RANGE_REVERSION: NO_LIFECYCLE_RECORD` 780; `strategy PULLBACK_CONTINUATION: NO_LIFECYCLE_RECORD` plus confidence-below-0.75 rounds.
* Discovery recall 0.47, precision 0.129, 1 trap promoted; simulated-time integrity 99.99%; timeline invariants 0.
* A fixture that cannot fail: mutation M6 (raw confidence used) and M8 (abstention fixture accepts an approval) turn this test red.

## 3. Test B: organic discovery -> BUY -> monitor -> SELL. **PASS (exact SHA), labeled fixture**
Same market and pressure; calibration `POSITIVE_CAPABILITY_BROAD` (160W/40L in buckets 0.6-1.0 for Kronos, Technical, QuantEngine, JavaCoreEnsemble; labeled NON_ORGANIC); lifecycle UNTESTED baseline (no authority) with PULLBACK_CONTINUATION RETIRED; three `CERTIFIED_PATH` hidden opportunities (breakout, continuation, reversal shape from the proven positive scenarios).
* Two oracle-valid hidden opportunities (LAMO, LAHP) discovered by the production allocator (recall 0.63, precision 0.163), bought and sold; 5 discovered symbols bought in total; 12 fills; 81 approved consensus rounds; certification gate PASS.
* Independent oracles: accounting 0 mismatches, risk 0 hard violations, exit 0 violations (2 stop breaches, both handled), capital basis 81/81 evaluations against $20,000, timeline invariants 0, simulated-time integrity 99.99%.
* Nothing was injected: no approval, order or fill above the broker boundary.
* **Honest scope:** the approvals needed the labeled calibration fixture. This proves the pipeline, not the agents (see the capability proof).

## 4. Other certification evidence
* Typecheck: clean. Build: clean. Full test suite: 870/870 files, 7,082 tests passed, 3 expected-fail policy tests, 2 skipped. Run 1 exited 1 solely because of 8 vitest `EnvironmentTeardownError` unhandled rejections raised while a worker closed (file `ChiefTraderAgent.calibration.test.ts`, which passes alone and is unchanged by this branch); run 2 exited 0 with no errors.
* Bounded soak: 24 / 24 sessions passed (families rotate; independent oracles and resource invariants) with zero failures.
* Restart battery: see `ARGUS_FINAL_RELEASE_READINESS.md` (cases that never reached their restart condition are reported INCONCLUSIVE, never PASS).
* Mutations: 12/12 unit-level and 5/5 full-session, each with a green control (`ARGUS_SYNTHETIC_MUTATION_RESULTS.md`).
* Discovery mechanics (production-stack harness, outside-only opportunities, 90 occupied lines, 37 renewals/min): LEGACY (Oct 14 behavior) recall 0.05-0.16, rescue holders 87, evictable 0; REPAIRED recall 0.35-0.58, rescue holders 4, evictable 82. Counterfactual swap-budget runs were invalid (production caps swaps at one per cycle at full capacity) and are not evidence.

## 5. Known limits and unproven items
* Discovery quality in the real market is NOT_PROVEN: the hidden-truth market is a fixture; recall 0.47-0.63 and precision 0.13-0.17 are bounded by the one-swap cap and score edge.
* Lineage: ~20-32 `IDEA_UNTERMINATED` per session (ideas absorbed into another idea's consensus round that ends in DESK_NO_TRADE have no durable fate row). Observability gap in the protected ChiefTrader; not changed.
* QuantSignalAgent logs `Failed to evaluate IWM ... 1Day refuses a real network fetch` in sessions: a core-streaming symbol without seeded daily history; benign in synthetic mode, and the synthetic block is the intended fail-closed behavior.
* Disk: 15 GB gate was met without override (about 37 GB free); the two 24 GB snapshots were preserved and compressed in place (SHA-256 identical, SQLite `quick_check` ok).
