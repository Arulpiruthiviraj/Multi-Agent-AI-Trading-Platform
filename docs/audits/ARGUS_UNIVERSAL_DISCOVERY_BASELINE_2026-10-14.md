# Argus — Universal Discovery: synthetic baseline (2026-10-14)

Evidence class: **SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY**. Measures Argus's real discovery code against a hidden-ground-truth market. It does not
prove profitability, and it does not change `LIVE_NO_GO`. Branch `cert/universal-discovery` (not part of the release commit).

## What was built

| Piece | File | Role |
|---|---|---|
| Hidden-truth market | `src/server/replay/synthetic/discovery/SyntheticDiscoveryMarket.ts` | 500 letter-only symbols; deterministic from the seed; publishes only snapshots, a top-movers list and a liquidity list. Ground truth is reachable only through `groundTruth()` / `barsForOracle()`. |
| Independent oracle | `.../discovery/OpportunityOracle.ts` | Decides what qualifies from the generated bars with its own fixed rules (move vs prior close ≥ 2.5 %, cumulative $ volume ≥ $3 M, recent-10-minute RVOL ≥ 2.5; mean-reversion by drawdown + up-close). Scores recall, precision, Recall@K, MRR, latency, and classifies every miss. |
| Harness | `src/server/certification/universalDiscovery.cert.test.ts` | Mocks only the external boundary (`alpacaFetch` snapshots, cached movers / broad-universe lists, MarketDataWorker slot state) and runs the REAL `runOpportunityScan` → SnapshotScanner scoring → ComposableRanking → hot-swap/top-up planning every simulated minute for a 390-minute session. Feeds age like production (broad scan every 15 min, movers every 5 min, 12 streaming slots, FIFO eviction model). |
| Integrity guards | same test | Determinism per seed; opportunities move with the seed; static scan proves no production module imports the ground-truth market or the oracle. |

Seeds 101 (60 % of opportunities outside the starting watchlist), 102 (**every** opportunity outside the 120-name starting list), 103 (control: all inside). 20 valid opportunities and 8 traps per day
(false breakout, low-liquidity spike, tiny-volume huge move, stale quote).

## Baseline (no thresholds asserted — this is the measurement)

| Day | Eligible opps | Discovered in time | Recall | Recall inside list | Recall **outside** list | Traps promoted | p95 discovery latency |
|---|---|---|---|---|---|---|---|
| 101 mixed | 18 | 8 | 44 % | 100 % | **0 %** | 3 | 8 min |
| 102 outside-only | 19 | 7 | **37 %** | n/a | 37 % | 3 | 20 min |
| 103 inside-only | 18 | 17 | 94 % | 94 % | n/a | 1 | 20 min |

Miss classes (102): 11 × `OFFERED_BY_MOVERS_NOT_PROMOTED`, 1 × `PROMOTED_AFTER_EXPIRY`, 7 discovered. Recall@5/10/20 for outside-list opportunities is 0 because they are never in the
snapshot ranking (that ranking covers only the configured lists).

## Verified mechanism (read from code, confirmed by the harness)

1. `SnapshotScanner` scores **only** `seedSymbols + watchUniverseSymbols + campaignOpeningSurgeSymbols + momentumScanUniverseSymbols`. A stock outside those lists never receives momentum / RVOL / range scoring.
2. Outside-list names reach `OpportunityDiscovery` through the movers cache, the broad-universe top-N and news catalysts, and compete for a streaming slot as *challengers* scored by `scoreBroadUniverseChallenger` = mover bonus (0.5) + `gapPct × 100 × weight`, base momentum = 0.
3. Incumbent curated names carry real momentum scores. Measured in the harness: outside-list challenger score mean **≈ 1.2–1.5** vs weakest incumbent mean **≈ 1.8–1.9**. At full capacity only **one** swap per cycle is allowed and the challenger must beat the weakest incumbent by the score edge.
4. Result: the information asymmetry between curated and broad-universe symbols (point 9 of the review) is the first blocking stage for most outside-list misses (`OFFERED_BY_MOVERS_NOT_PROMOTED`), and promoted ones are frequently late (`PROMOTED_BUT_LATE`).

## Honest limitations of this baseline

* The harness models streaming-slot state with a FIFO eviction model; the real `MarketDataWorker` eviction/dwell rules are not exercised.
* Quant evaluation timing is not in this phase; the promoted-symbol → Quant → idea → consensus → Risk → OMS leg is certified separately by the full synthetic session suite. Wiring both into one 500-symbol funnel is the next phase.
* The movers feed here is the top-20 by published % change among symbols with real dollar volume; production's movers endpoint and its re-screening may differ.
* `MarketUniverseScanner`'s own screens (price / dollar-volume / spread / ADV) were **not** run against the synthetic universe (no provider seam yet). The IEX-vs-consolidated dollar-volume question and the broad-cache staleness concern are therefore **not tested**, not cleared.
* No thresholds are proposed. The point is to establish the distribution first.

## Release implication

Argus can discover opportunities **inside its configured lists** well (94–100 % recall in these runs). It cannot yet be called a universal-discovery platform: opportunities outside the lists were found 0–37 % of the time, late, and 3 of 8 traps were
promoted. Discovery is therefore `NOT_PROVEN` / `FAIL` for out-of-list discovery and must not be assumed tomorrow; trading will be driven by the curated universe plus whatever the movers/broad paths surface.
