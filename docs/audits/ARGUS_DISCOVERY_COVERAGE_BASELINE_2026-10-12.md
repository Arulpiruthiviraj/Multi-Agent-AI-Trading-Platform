# Argus discovery-coverage baseline (first measurement)

Date written: 2026-10-12. PAPER only. LIVE_NO_GO. Read-only evidence; nothing was changed in the engine.

## Method and its limits (read first)
- **Benchmark:** Alpha Vantage `TOP_GAINERS_LOSERS`, default (non-premium) feed, `last_updated 2026-10-09 16:15 ET` = the **Friday Oct 9 close**. The delayed/real-time feed needs a premium plan and was refused. This is therefore an **ex-post, end-of-day-knowledge** list for a **past session**, not a point-in-time or same-day test.
- **Eligibility screen applied to the benchmark:** Argus's own published screen (`config/continuousIntelligence.json`): price $5–$2,000 and dollar volume ≥ $5 M (price × session volume). Warrants, rights, units and sub-$5 names were excluded as ineligible, not counted as misses. 13 eligible names resulted (top gainers/losers + most active); this is a small, crude sample.
- **Argus side:** `observability_events` for 2026-10-09 13:30–20:05Z (discovery, subscription and Quant events per symbol). Oct 9 ran on an older engine build than the one running today.
- A symbol being absent from Argus's event trail is a **coverage gap**, not a rejected trade. Nothing here says Argus should have traded any of these names or that any move was capturable.

## Result (13 eligible names, Oct 9)
| Symbol | Day move | Argus outcome (Oct 9) | First divergence |
|---|---|---|---|
| WFF | +499% (137 M sh) | Seen 56×, **filtered every time**: PRICE 21, SPREAD 29, DOLLAR_VOLUME 5, NO_SNAPSHOT_DATA 1 | Price floor ($5) while it rose from low prices, then spread screen |
| VEEA | +47% (83 M sh) | Seen 63×, **filtered every time**: DOLLAR_VOLUME 62 | Dollar-volume screen never passed all day despite ~$470 M final dollar volume |
| XRPN | −29% | Seen 55×, **filtered every time**: DOLLAR_VOLUME 54 | Same pattern |
| T | −9.9% | Admitted 25×; subscription NOT promoted 45× | Streaming-slot scarcity; no Quant evaluation |
| NU | +4.8% | Admitted 8×; NOT promoted 15× | Same; no Quant evaluation |
| SPCX | +1.3% | Admitted 42×; NOT promoted 32× | Same; no Quant evaluation |
| TSLL | +3.9% | Admitted 10×; NOT promoted 5× | Same; no Quant evaluation |
| VZ | −8.7% | Admitted, subscribed, Quant selection pool 5×, ideas generated | Reached Quant |
| INTC | −2.2% | Admitted, subscribed, Quant selection pool 9×, ideas generated | Reached Quant |
| AAL | −0.3% | Admitted, subscribed, ideas generated | Reached Quant (no selection-pool events) |
| NVDA | −0.5% | Admitted, subscribed (175 requests), selection pool 5× | Reached Quant |
| SOXS | +1.9% | **No events at all** | Never observed (not in any scan trail) |
| BITO | +0.6% | **No events at all** | Never observed |

**Tally:** reached Quant 4/13 (31%); admitted but never given a data slot or assessed 4/13; filtered by a screen all day 3/13; never observed at all 2/13. Of the four that reached Quant, three (VZ, INTC, NVDA) had selection-pool events; AAL had subscription and ideas but no selection-pool events in the window.

## What this does and does not establish
- [C] Four distinct loss points exist, with different remedies: screens (WFF/VEEA/XRPN), streaming-slot scarcity (T/NU/SPCX/TSLL), never-observed instruments (SOXS/BITO), and everything that did reach Quant.
- [S] Streaming scarcity is real and documented: `maxActiveSubscriptions = 12` (20 was tried and Alpaca rejected it), one hot-swap per cycle, 20 candidates per scan out of 200 retained. `SUBSCRIPTION_NOT_PROMOTED` is the dominant terminal reason for admitted names.
- [H] **VEEA and XRPN being filtered on DOLLAR_VOLUME 62 and 54 times all day, with huge final dollar volume, suggests the dollar-volume screen may use a stale or previous-session volume figure rather than the intraday accumulating volume.** This is a hypothesis from the event pattern, not proven; it needs a direct look at what `screenAssets()` compares at each cycle.
- [H] WFF's PRICE filtering (21×) early in the session is policy working as designed (price floor) but shows the floor excludes the very largest early movers until they cross $5; whether that is wanted is a policy decision, not a bug.
- [U] SOXS and BITO: whether they are outside the supported universe (asset/exchange filters) or were missed by the scan is not established.
- [U] Whether any of these names offered a valid strategy setup is not evaluated here. Coverage is a precondition for trading, not evidence of an edge.
- Same-day, point-in-time measurement (several checkpoints through the session, with an entitled real-time feed) is **not yet done** and is the required next step.

## Concurrent finding on today's engine (Oct 12, 16:08–16:37Z window)
Discovery is ON in this deployment (`ARGUS_BROAD_UNIVERSE_ENABLED`, `ARGUS_MARKET_MOVERS_ENABLED`, `ARGUS_OPPORTUNITY_LOOP_ENABLED` all true): 200 admissions (159 distinct symbols), 757 filtered (NO_SNAPSHOT_DATA 159, DOLLAR_VOLUME 143, PRICE 329, SPREAD 23, ADV_BELOW_FLOOR 3, ADV_DATA_UNAVAILABLE 100), 245 subscribe requests, 745 temporary data rescues granted / 0 denied, 471 `SUBSCRIPTION_NOT_PROMOTED`.

## Proposed next steps (not started)
1. Look at the dollar-volume and ADV inputs the broad screen uses each cycle (hypothesis above).
2. Add a persistent candidate registry with a terminal reason per admitted symbol, and a daily scorecard against an independent mover list taken at checkpoints (needs an entitled real-time source).
3. Separate broad snapshot observation from scarce streaming slots (preliminary snapshot-based Quant screening), keeping ChiefTrader, RiskEngine, OMS and lifecycle rules unchanged.
4. Seeded synthetic movers outside the curated lists, with mutation tests, and a `DISCOVERY_COVERAGE_NOT_READY` gate in the release certification driver.
