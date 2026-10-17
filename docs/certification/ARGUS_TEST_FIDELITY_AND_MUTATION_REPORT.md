# Test fidelity and mutation report

## Fidelity assessment

Argus has multiple useful test layers: unit and contract tests, event-bus/risk/OMS integration tests, isolated synthetic sessions, production-failure replay tests, replay broker tests, and mutation-oriented checks. Selected synthetic sessions use real ChiefTrader, RiskEngine and OMS boundaries. The child-process pattern prevents synthetic database configuration from racing with static imports; synthetic orders use an isolated replay broker.

The main fidelity gaps are the difference between a seeded positive capability fixture and organic calibration, incomplete capture of production event arrival/order, small or unspecified workload scale in many tests, historical event telemetry without episode/source lineage, and absence of a recent full production-shaped load+failure run. Historical market bars alone are not enough: point-in-time quote/news availability and the bar-close boundary must be preserved.

## Mutation status

The repository has a defect-escape registry and mutation-oriented tests, but no mutation campaign was run for this report. Introduced/detected/surviving mutation counts are **NOT_VERIFIED**. No claim is made that the current suite kills all safety-critical mutants. At minimum, future release evidence must demonstrate detection of: removed exit exemption, duplicate evidence counted as independent, freshness bypass, dropped event listener, skipped evaluation callback, missing reconciliation, duplicate order submission, unverified disk-pause success, and risk-limit bypass. Any surviving safety-critical mutation blocks certification.

## Anti-vacuity standard

Every scenario report should record expected trigger, observed trigger, downstream assertion, event count, seed, timing mode, and run SHA. If the injected condition did not occur, report `INVALID_TEST — TARGET CONDITION NOT REACHED`, not PASS. For concurrent tests, persist random seed and event order. For provider tests, prove the unavailable provider received a request. For broker tests, prove duplicate submission attempts happened and the isolated broker stored only one order.

## Measurements

This pass ran 15 focused disk/artifact tests and measured no production performance. Historical Oct. 16 database telemetry records slow SQL and synchronous persistence (see the week forensic), but those observations are not synthetic benchmarks. Mutation score, production-scale load, event-loop P95/P99 under market-open burst, and DB latency under representative cardinality remain **NOT_RUN**.
