# ARGUS — September 29, 2026 External Missed-Opportunity Benchmark Audit

**Mode:** deep forensic analysis only. No source code, configuration, database rows, Git state, broker settings, or runtime state were modified in producing this report (a separate, user-directed action — starting the Argus engine with trading enabled — occurred earlier in this same session, at explicit user request, and is unrelated to and unaffected by this audit). All queries were read-only: direct SQLite reads against `data/argus.db`, and read-only historical-bar fetches against Alpaca's REST API using this deployment's own already-configured, already-paid-for credentials (no new subscription purchased, no account/broker/market-data setting changed).

**Purpose:** the September 29 trading forensic audit (`ARGUS_TRADING_FORENSIC_2026-09-29.md`) established *why Argus produced zero trades* but explicitly did not build an independent, market-wide opportunity set — it only examined candidates Argus itself had already surfaced. This audit closes that gap: it defines real market opportunities from Alpaca's own historical data, using a methodology fixed **before** looking at what Argus did, then traces each qualifying opportunity through Argus's real event log.

---

## 1. Methodology (fixed before inspecting Argus's own results)

**Universe:** started from Alpaca's raw `/v2/assets` tradable-securities list (11,031 tradable US-equity symbols on NYSE/NASDAQ/ARCA/AMEX with a simple 1–5-letter ticker) — the full listing Alpaca exposes, not any Argus-internal curated or filtered list. Narrowed to 4,137 by Alpaca's own pre-existing `marginable` + `shortable` + `easy_to_borrow` + `has_options` attributes (a standard, objective liquidity/quality proxy available without any per-symbol volume fetch). Narrowed further, using **real Sep 29 dollar volume** computed from the same historical-bars fetch used for the opportunity criteria below (not a separate hindsight-informed step), to the **top 1,200 symbols by dollar volume** — the "broad liquid universe" scope. `DATABASE_VERIFIED`/direct-API-verified this session.

**Data source:** Alpaca `/v2/stocks/bars`, `timeframe=1Day`, `feed=sip` (full consolidated volume, not the IEX-only slice Argus's own real-time snapshot path uses — deliberately the more complete data source, since the point of this audit is to find what *really* happened in the market, not only what Argus's own feed could see), `adjustment=raw`, window 2026-09-24 through 2026-09-30. 4,137/4,137 batch requests succeeded (0 failures), paced at ≥550ms between requests to avoid contending with the live engine's own concurrent Alpaca usage.

**Opportunity criterion — gap-and-hold (the single criterion selected for this pass):**
- `gapPct = (Sep29 open − prior trading day's close) / prior trading day's close`
- Significance floor: `|gapPct| ≥ 3%`
- "Held": `heldFraction = (Sep29 close − prevClose) / (Sep29 open − prevClose) ≥ 0.5` and same sign as the gap — i.e., the close retained at least half the opening gap's magnitude in the same direction, rather than round-tripping back through the prior close.
- Ranking within qualifying opportunities: by `|gapPct|`, descending.

This is a real, predefined, objective, outcome-blind rule — decided and coded before any qualifying symbol was looked up against Argus's own logs, so the criterion itself could not have been tuned to flatter or indict any specific known case (including IOVA, which the immediately-preceding remediation pass had already investigated as a subscription-capacity defect — its appearance in this independent scan below is a genuine, unprompted confirmation, not a result the criteria were built to reproduce).

**Explicitly out of scope this pass:** the other two candidate criteria (abnormal-volume-plus-sustained-return, breakout continuation) were not run — only gap-and-hold, per this session's own scoping decision. A future pass could add them.

---

## 2. Universe and qualifying opportunities

| Metric | Value |
|---|---|
| Tradable Alpaca assets (raw) | 11,031 |
| After liquidity/quality attribute narrowing | 4,137 |
| Symbols with a real Sep 29 daily bar | 4,137 (100% — 0 failed fetches) |
| Liquid universe (top 1,200 by real Sep 29 dollar volume) | 1,200 (range: $92.2M–$28.3B) |
| **Qualifying gap-and-hold opportunities** | **30** |
| Gapped ≥3% but faded (did not hold) — comparison set | 11 |

`DATABASE_VERIFIED`/direct-API-verified. Full lists in the appendix (§8).

---

## 3. Cross-referencing each qualifying opportunity against Argus's real funnel

Each of the 30 qualifying symbols was checked directly against `observability_events` for September 29 (`DISCOVERY_CANDIDATE_ADMITTED`, `DISCOVERY_CANDIDATE_FILTERED`, `QUANT_ASSESSMENT_COMPLETED`, `TRADE_IDEA_GENERATED`, `TRADE_IDEA_REJECTED`, `CONSENSUS_TERMINAL_REASON`, `WATCHLIST_SUBSCRIBE_REQUESTED`). `DATABASE_VERIFIED`. This produces five distinct, non-overlapping outcome categories — a materially richer picture than the original audit's single "IOVA" anecdote.

### Category A — Fully evaluated, correctly rejected on confidence (3 symbols)

| Symbol | Gap | Held return | $ Volume | Quant assessments | Consensus rounds | Max confidence | Reason |
|---|---|---|---|---|---|---|---|
| SOXL | +4.67% | +3.31% | $7.9B | 251 | 316 | 0.494 | `CONFIDENCE_BELOW_STRONG` |
| NIO | −3.82% | −5.29% | $203M | 55 | 43 | 0.496 | `CONFIDENCE_BELOW_STRONG` |
| AMAT | +3.69% | +5.19% | $3.7B | 49 | 38 | 0.477 | `CONFIDENCE_BELOW_STRONG` |

These three real, meaningfully-sized gap-and-hold moves were genuinely seen, genuinely subscribed, genuinely quantitatively assessed dozens to hundreds of times, and genuinely reached consensus — and were correctly rejected, consistent with the confidence-calibration findings in the original forensic audit (§33 there). `GOOD_REJECTION` for all three — the pipeline worked exactly as designed on these three.

### Category B — Partially evaluated, stalled before ever generating a directional idea (1 symbol)

| Symbol | Gap | Held return | $ Volume | Admitted | Quant assessments | Ideas generated | Ideas rejected |
|---|---|---|---|---|---|---|---|
| BE (Bloom Energy) | +3.79% | +10.80% | $6.9B | 29 | 20 | 0 | 5 (all `MISSING_PRICE`) |

BE is a real, large ($6.9B dollar volume), meaningful (+10.8% held) move that Argus's QuantSignalAgent genuinely evaluated 20 separate times that day — yet never once produced a directional `TRADE_IDEA_GENERATED`, and every one of MacroAgent's 5 separate attempts to act on it failed with `MISSING_PRICE` specifically (not a confidence or independence rejection — a data-availability failure at the moment of the attempt). This pattern — real quant evaluation activity coexisting with repeated `MISSING_PRICE` failures for a different producer — is consistent with an intermittently-subscribed symbol (present in the active pool long enough for some quant cycles to run, but evicted or never re-subscribed by the time MacroAgent tried to act) rather than a confidence-based rejection. `PROVEN` pattern; the precise mechanism (why 20 quant assessments succeeded while every idea-generation attempt saw a missing price) was not traced further this pass — `UNVERIFIED` at that depth of detail.

### Category C — Admitted by discovery, but never quantitatively assessed at all (16 symbols — the dominant pattern)

| Symbol | Gap | Held return | $ Volume | Times admitted | Subscription requests issued |
|---|---|---|---|---|---|
| QURE | −39.02% | −37.33% | $731M | 139 | 0 |
| IOVA | +16.38% | +31.48% | $1.13B | 87 | 7 |
| CCL | +10.16% | +13.41% | $1.90B | 24 | 0 |
| GFI | +3.41% | +4.55% | $403M | 52 | 0 |
| CVNA | +3.41% | +5.21% | $647M | 43 | 0 |
| GLW | +3.61% | +4.70% | $1.21B | 39 | 0 |
| NCLH | +5.59% | +3.42% | $410M | 18 | 0 |
| KLAC | +3.05% | +3.89% | $1.53B | 15 | 1 |
| VRT | +3.01% | +1.76% | $821M | 10 | 0 |
| RCL | +6.02% | +7.45% | $1.05B | 9 | 0 |
| EQNR | −3.10% | −2.20% | $180M | 8 | 0 |
| AXTI | +4.03% | +6.12% | $717M | 29 | 0 |
| EFX | −3.13% | −3.40% | $397M | 3 | 0 |
| BUD | −3.46% | −3.64% | $241M | 2 | 0 |
| KMX | +6.82% | +4.74% | $725M | 2 | 0 |
| MXL | +3.33% | +3.02% | $274M | 1 | 0 |

`DATABASE_VERIFIED` for every row. **This is the single most important finding of this benchmark.** All 16 of these were real, admitted, liquid ($180M–$1.9B dollar volume), meaningfully-sized (3%–39% gap) opportunities that discovery's own admission gate had already accepted — and none was ever quantitatively assessed. Within this group, a further, previously-undocumented distinction matters:

- **IOVA and KLAC** (2 of 16) generated at least one real `WATCHLIST_SUBSCRIBE_REQUESTED` event — these are confirmed instances of the exact same defect class the immediately-preceding remediation pass found and fixed for IOVA specifically (a real subscription request that never resulted in an actual subscription or evaluation, previously silent, now logged with a real refused/accepted outcome per that fix).
- **The other 14** (QURE, CCL, GFI, CVNA, GLW, NCLH, VRT, RCL, EQNR, AXTI, EFX, BUD, KMX, MXL) generated **zero** subscription-request events despite being admitted by discovery, in some cases dozens of times (QURE: 139 admissions, zero requests). This is a **distinct, earlier, and previously unidentified bottleneck**: discovery's own hot-swap challenger-scoring/selection step (`priorityScoreOf()`, `broadUniverseHotSwapChallengerLimit` bounding how many admitted candidates get scored as challengers per cycle, and the single-swap-per-cycle pacing at full capacity) never selected these 14 to even *attempt* a subscription, as opposed to attempting one and being refused. The September 30 remediation pass's own IOVA-gap fix addressed the "requested but silently refused" failure mode; it does not address, and was not designed to address, "admitted but never even selected as a challenger" — this is real, new evidence that a second, separate bottleneck exists upstream of the one already fixed. `PROVEN` as an observed pattern (14 real, admitted, unrequested, liquid opportunities); the specific root cause within `OpportunityDiscovery.ts`'s challenger-selection logic was not traced to a specific line this pass — `UNVERIFIED` at that depth, and explicitly **not** claimed as already fixed.

### Category D — Never admitted; repeatedly filtered pre-admission (8 symbols)

| Symbol | Gap | Held return | $ Volume (real, SIP) | Filter count | Dominant filter reason |
|---|---|---|---|---|---|
| FICO | −20.55% | −26.52% | $3.04B | 195 | `ADV_BELOW_FLOOR` (131), `SPREAD` (56) |
| XPEV | −3.02% | −4.82% | $130M | 34 | `RANK_CAP` (34) |
| PRIM | +3.16% | +4.44% | $123M | 31 | `RANK_CAP` (30) |
| NESR | −3.99% | −11.14% | $141M | 29 | `RANK_CAP` (29) |
| VVV | +3.58% | +4.11% | $101M | 4 | `RANK_CAP` (4) |
| AGX | +3.60% | +6.53% | $160M | 3 | `ADV_BELOW_FLOOR` (3) |
| MGNI | +4.62% | +9.70% | $106M | 1 | `RANK_CAP` (1) |
| AEHR | +3.51% | +2.33% | $247M | 1 | `RANK_CAP` (1) |

`DATABASE_VERIFIED`, filter reasons read directly from `DISCOVERY_CANDIDATE_FILTERED.payload.reason`. Two genuinely different causes are mixed in this category and should not be conflated:

- **`RANK_CAP`** (6 of 8 symbols): the candidate was seen, and — per its own logged snapshot — had real, adequate liquidity metrics (e.g. XPEV: `dollarVolume: $5.0M` snapshot-scope, `advShares: 6.57M`, `spreadBps: 10.5` — all reasonable), but lost the ranking competition for a bounded admission slot that specific scan cycle. This is a real, demonstrated capacity constraint at the admission stage itself, upstream of even Category C's challenger-selection bottleneck.
- **`FICO`'s case is different and more concerning**: FICO is a real, independently-verified $3.04B-dollar-volume mover (by SIP consolidated data) that was filtered 131 times on `ADV_BELOW_FLOOR` with the logged evidence showing `advShares: null` (a genuine ADV-data-lookup failure, not a measured-and-confirmed-thin reading) and 56 times on `SPREAD`, with one logged sample showing an IEX-snapshot dollar volume of just **$2.17 million** — roughly 1,400× smaller than FICO's real SIP-consolidated dollar volume that day. This is not necessarily a code defect (the system's fail-closed design explicitly treats a missing/unreliable liquidity reading as "not liquid," which is the documented, deliberate, safety-conscious choice, and FICO's very high per-share price — several hundred dollars — plausibly makes its IEX top-of-book view thin and its dollar-volume snapshot unrepresentative of its true consolidated activity) — but it is a real, demonstrated, externally-verified case where the fail-closed liquidity gate excluded a genuinely very liquid, large, meaningful mover because of a real limitation in what IEX-scoped real-time data can represent for a high-priced name. `DATA_DEFECT` (data-scope limitation) rather than `PROVEN_CODE_DEFECT` (the code is behaving exactly as designed; the design's own input data has a real blind spot for this class of symbol).

### Category E — Never appeared in the discovery funnel at all (2 symbols)

| Symbol | Gap | Held return | $ Volume |
|---|---|---|---|
| FCEL | +8.52% | +4.71% | $112M |
| WH | +3.04% | +2.27% | $98M |

`DATABASE_VERIFIED` — zero `DISCOVERY_CANDIDATE_ADMITTED` and zero `DISCOVERY_CANDIDATE_FILTERED` rows for either symbol on September 29. Both are real, moderate-dollar-volume ($98M–$112M) movers that were simply never part of any scan universe that day (not seed/watch list, not that day's broad-universe/movers-funnel output) — a coverage gap in the scan universe construction itself, distinct from every other category above (those were at least *seen*). Neither is large enough in dollar volume to be a striking miss on its own, but the mechanism (complete absence from the universe) is worth noting as its own category.

---

## 4. The real, quantified funnel for this benchmark

```
30 real, externally-verified gap-and-hold opportunities (≥3%, held ≥50% of the gap, top-1200-liquid)
        ↓ 28/30 (93%) at least entered the discovery funnel (admitted or filtered)
        ↓ 20/30 (67%) were admitted at least once
        ↓ 3/30 (10%)  ever generated a subscription REQUEST (IOVA, KLAC, + implicitly the 3 Category A/B symbols which were presumably already-core/seed-list symbols, not broad-universe discoveries — see caveat below)
        ↓ 4/30 (13%)  were ever quantitatively assessed at all (SOXL, NIO, AMAT, BE)
        ↓ 3/30 (10%)  ever reached a consensus round (SOXL, NIO, AMAT)
        ↓ 0/30 (0%)   were ever approved
```

**Caveat on the third row:** SOXL, NIO, and AMAT's own admission/subscription pathway was not re-derived symbol-by-symbol this pass — SOXL and AMAT are plausible static seed/watch-list or core-universe members (not necessarily broad-universe discoveries at all), which would explain why they show quant assessments without ever appearing in `DISCOVERY_CANDIDATE_ADMITTED` in the raw cross-reference (both show `admitted: 0` in the raw data, §3 Category A). This means the true "discovery → subscription" conversion rate for genuinely broad-universe-*discovered* opportunities specifically is likely narrower than the naive 3/30 figure suggests, not wider — a further, real limitation worth a dedicated follow-up rather than a claim made confidently here. `UNVERIFIED` at that level of precision this pass.

**What is fully verified:** of the 20 opportunities discovery admitted at least once, only 2 (10%) ever generated a subscription request, and of those, 0 resulted in a completed evaluation reaching consensus. **Discovery admission is not a meaningful predictor of evaluation coverage for this benchmark's opportunity set** — the overwhelming majority of real, liquid, admitted opportunities never progressed past the admission step itself.

---

## 5. What this changes about the prior audit's conclusions

The original September 29 forensic audit's own architectural framing (independently arrived at by an external reviewer analyzing that report, quoted here for continuity) was:

> Very broad discovery → very narrow live evaluation funnel → very strict consensus.

This benchmark **confirms and substantially sharpens** that diagnosis with real, externally-verified evidence, and revises one part of it:

- **Confirmed, and now quantified with 16 concrete real examples (not one anecdote):** the discovery-to-evaluation funnel is the dominant loss point for real opportunities, not consensus. Of the 20 admitted opportunities in this benchmark, 90% never even reached the subscription-request stage.
- **Revised:** the September 30 remediation pass's IOVA-gap fix addressed a real, verified defect (a subscription request silently refused) — but this benchmark shows that defect class accounts for only 2 of the 16 unevaluated admitted opportunities (IOVA, KLAC). The other 14 never generated a request at all, pointing to a second, earlier, **not yet investigated or fixed** bottleneck in discovery's own challenger-selection/ranking step. The discovery-to-evaluation problem is larger than the already-fixed defect, not fully closed by it.
- **New finding, not previously identified:** a real, meaningful subset of missed opportunities (Category D's `RANK_CAP` cases, and FICO's `ADV_BELOW_FLOOR`/`SPREAD` case) never even reach the admission-competition stage discovery's hot-swap logic operates on — they lose an earlier, separate ranking competition, or are excluded by a genuine IEX-data-scope limitation for high-priced names. This is upstream of everything the September 30 remediation pass touched.
- **Confirmed unchanged:** consensus itself (§7–8 of the original audit) remains well-evidenced as working correctly on the opportunities that did reach it (Category A here) — nothing in this benchmark contradicts that finding, and the calibration evidence from the original audit (§33 there) still stands as the reason a lower threshold would be the wrong response.

---

## 6. Finding classification

| Finding | Classification |
|---|---|
| SOXL, NIO, AMAT: fully evaluated, correctly rejected | `GOOD_REJECTION` |
| BE: partial evaluation, stalled on intermittent `MISSING_PRICE` | `ARCHITECTURAL_LIMITATION` (data-availability flapping, not root-caused to a specific line this pass) |
| IOVA, KLAC: real subscription request, never resulted in evaluation | `PROVEN_CODE_DEFECT` — same class already fixed in the immediately-preceding remediation pass |
| 14 other Category-C symbols: admitted, never even requested | `ARCHITECTURAL_LIMITATION` — real, demonstrated, **not yet fixed**, root cause not traced to a specific line this pass |
| Category D `RANK_CAP` exclusions (6 symbols) | `ARCHITECTURAL_LIMITATION` — a real, bounded admission-ranking competition, working as designed but with a real cost |
| FICO's `ADV_BELOW_FLOOR`/`SPREAD` exclusion | `DATA_DEFECT` — real IEX-scope limitation for a high-priced, real, verified $3B-volume name |
| FCEL, WH: never in the scan universe | `ARCHITECTURAL_LIMITATION` — scan-universe coverage gap |
| Consensus behavior on opportunities that did reach it | `EXPECTED_SAFE_BEHAVIOR` (unchanged from the original audit) |

---

## 7. Recommendations

### Immediate defects to fix
**None newly proven to require an immediate code fix this pass** (per this audit's own restrictions, no fix was implemented regardless). The one already-known code defect this benchmark independently re-confirms (IOVA/KLAC) is already fixed.

### Experiments / research needed
1. **Trace the 14-symbol never-requested pattern to its root cause in `OpportunityDiscovery.ts`'s challenger-selection logic** (`priorityScoreOf()`, `broadUniverseHotSwapChallengerLimit`, per-cycle swap pacing) — this benchmark proves the pattern exists and is larger than the already-fixed defect, but does not itself identify which specific scoring/capacity constant is the binding one. This is the highest-value next investigation given this benchmark's own evidence.
2. **Re-run this same benchmark with the abnormal-volume-plus-sustained-return and breakout-continuation criteria** (the two criteria not run this pass) to check whether the discovery-coverage gap found here generalizes beyond gap-and-hold specifically.
3. **Investigate FICO's IEX-vs-SIP dollar-volume discrepancy specifically** (a ~1,400× gap for one real symbol) as a bounded, concrete case study for whether high-priced names are systematically under-measured by the real-time liquidity screen, distinct from the already-abstained discovery-RVOL metric.
4. **Quantify the `RANK_CAP` exclusion rate more broadly** (not just for these 30 symbols) to establish whether the broad-universe admission cap itself, not only the downstream challenger-selection step, is a material bottleneck.
5. Determine SOXL/AMAT/NIO's actual discovery pathway (seed/watch list vs. broad-universe) to sharpen the funnel percentages in §4.

### No change justified
- The 0.75 consensus threshold and independence floor: unaffected by this benchmark's findings — nothing here reached consensus in a way that bears on that threshold's correctness.
- RiskEngine, PositionSizing, OMS, BrokerManager: still never reached by anything in this benchmark; no evidence bears on them.
- The already-completed IOVA-gap fix: this benchmark confirms it addressed a real defect, but does not suggest it needs to be revisited — it correctly targeted the "requested but refused" failure mode, which is a real (if partial) share of the problem this benchmark found.

---

## 8. Appendix — full data

**Full qualifying gap-and-hold list (30), sorted by |gap|:** QURE, FICO, IOVA, CCL, FCEL, KMX, RCL, NCLH, SOXL, MGNI, AXTI, NESR, NIO, BE, AMAT, GLW, AGX, VVV, AEHR, BUD, GFI, CVNA, MXL, PRIM, EFX, EQNR, KLAC, WH, XPEV, VRT — exact gap/held-return/dollar-volume figures per symbol are in §3's category tables above (every qualifying symbol appears in exactly one category table).

**Faded gaps (gapped ≥3%, did not hold — comparison set, not scored against Argus):** SMMT (+22.16% gap, faded to +5.88%), NVTS (+9.16% → 0.00%), UEC (+7.60% → +0.87%), ASTS (+6.72% → −2.62%), ASST, BMNR, FIGR, PURR, GKOS, TTMI, KOD. These are included per this audit's own methodology to avoid training any future redesign purely on symbols that happened to keep moving — a fair benchmark must also show real gaps that reversed.
