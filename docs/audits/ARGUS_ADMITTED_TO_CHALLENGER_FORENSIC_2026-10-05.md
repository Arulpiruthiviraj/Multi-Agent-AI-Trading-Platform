# ARGUS — Admitted → Challenger Eligibility Gap Forensic (2026-10-05)

**Scope:** Why can a broad-universe candidate be admitted into Argus's discovery pipeline but never
become eligible for challenger/hot-swap scoring — for hours, or all day? Follow-up to
`ARGUS_SUBSCRIPTION_STARVATION_FORENSIC_2026-10-05.md`, using PTC (latency case) and MPWR (originally
reported as a "never reached challenger scoring at all" case) as the two diagnostic symbols.

**Non-negotiable constraints honored:** no change to the 90-line subscription cap, the hot-swap cap
(1/cycle), any hot-swap ranking weight, the consensus threshold, minimum independent agreement, any
strategy threshold, RiskEngine, or OMS. The one code change in this report is a pure, additive
observability fix — explained and justified in Section 6 — that does not alter which symbol gets
selected, when, or by what score.

**Important correction made during this investigation:** an earlier internal draft of this report
(and a line in the EOD forensic it was cited from) claimed MPWR was "admitted 76 times." That number
was wrong — it came from a flawed query that searched for `"symbol":"MPWR"` inside the `payload` JSON
text column. `observability_events.symbol` is a dedicated, indexed column, not embedded in `payload`;
searching the payload text for MPWR returned zero matches for today's real discovery activity (it
only matched a stale 2026-10-02 news-cluster row), which is itself what first exposed the bug. Once
corrected to filter on the real `symbol` column, MPWR's actual count for 2026-10-05 is **2 admissions
and 1 filter — not 76.** This correction is carried into the EOD report (Section 36) in the same
commit as this report. The diagnostic value of the MPWR case survives the correction: it was admitted
twice and, on both occasions, never appeared in any challenger-pool snapshot — the question "why not"
still has a real, confirmed answer (Section 4).

---

## 1. Pipeline state model (ground truth, derived from code + today's real events)

```
TRADABLE ASSET (thousands)
  │  MarketUniverseScanner.screenAssets() — price/dollar-volume/spread screen
  ▼
STAGE-1 PASS → ADV screen (fetchAvgDailyVolumeShares)
  │
  ▼
DISCOVERY_CANDIDATE_ADMITTED  (logged, symbol column, today: 10,252 rows)
  — this candidate passed the broad-universe liquidity/ADV screen on THIS refresh cycle.
  — refreshBroadUniverseCache() REPLACES snapshotCache wholesale each refresh — admission is a
    per-refresh-cycle fact, not a persistent state. A symbol can be admitted on one refresh and
    absent (not re-admitted, not re-filtered — simply not present) on the next.
  ▼
getOpportunityScanUniverse()'s broad-universe top-N cap
  — selectBroadUniverseCandidates(getCachedBroadUniverseCandidatesWithVolume(), broadUniverseTopNPerScan)
  — liquidity-rank + aging-fairness score; top `broadUniverseTopNPerScan` win a slot in `shortlist`.
  — BEFORE THIS REPORT'S FIX: candidates that lose this cut were NEVER logged. Confirmed zero
    observability anywhere for this specific transition (Section 4, Section 6).
  ▼
shortlist  (built once per OpportunityDiscovery cycle from getOpportunityScanUniverse())
  ▼
priorityScoreOf() / scoreBroadUniverseChallenger()  — blendedHotSwapScore + gap-term
  — a zero-or-negative-score shortlist member is excluded from the scored/eligible pool with only
    an AGGREGATE count (`zeroScoreOrExcludedCount`), no per-symbol record. This is a second,
    separate silent-exclusion point from the top-N cap above — confirmed in the prior
    subscription-starvation forensic, not re-litigated in depth here since it did not turn out to
    be MPWR's actual blocker (MPWR never reached this stage at all — see Section 4).
  ▼
DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT  (logged, bounded top-N + cutoff-neighborhood detail)
  ▼
DISCOVERY_CHALLENGER_SWAP_OUTCOME / SUBSCRIPTION_NOT_PROMOTED / SUBSCRIPTION_PROMOTED  (logged)
  ▼
IBKR_MARKET_DATA_SUBSCRIPTION_ACKNOWLEDGED → quant_assessments → DESK_NO_TRADE / idea emission
```

**State definitions used below**, per the taxonomy the investigation prompt supplied:
- `ADMITTED`: passed `DISCOVERY_CANDIDATE_ADMITTED` on at least one broad-universe refresh today.
- `UNIVERSE_SELECTED`: survived the `broadUniverseTopNPerScan` cut into `getOpportunityScanUniverse()`.
- `CHALLENGER_ELIGIBLE`: appears in a `DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT`'s candidate detail (or is
  counted in its `eligibleForChallengerScoring` total) with `finalPriorityScore > 0`.
- `PROMOTED`: received a real `WATCHLIST_SUBSCRIBE_REQUESTED` → subscription.

---

## 2. PTC trace (re-confirmed, no change from the prior forensic's finding)

- 94 `DISCOVERY_CANDIDATE_ADMITTED` events today, 74 `DISCOVERY_CANDIDATE_FILTERED`, 263
  `SUBSCRIPTION_NOT_PROMOTED` — all 263 with `reasonCode: SWAP_CAP_REACHED`,
  `source: BROAD_UNIVERSE_CHALLENGER`.
- PTC **does** reach `UNIVERSE_SELECTED` and `CHALLENGER_ELIGIBLE` (confirmed present in
  `DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT` candidate arrays, e.g. the 14:37:05 UTC snapshot with
  `eligibleForChallengerScoring=63`, `zeroScoreOrExcludedCount=0`).
- PTC's blocker is downstream of both truncation points this report is about: it loses the single
  hot-swap slot (`effectiveSwapBudget: 1`) every cycle to a higher-scoring competitor (CHRW at
  `finalPriorityScore=1.3842` vs PTC's own `1.045` in the reconstructed cycle). This is the
  **latency/scoring-competition** case — already fully traced in the subscription-starvation
  forensic — not a silent-exclusion case. No new finding here; restated only to contrast with MPWR.

## 3. Control symbol: CHRW (a broad-universe candidate that DID win promptly)

CHRW, in the same 14:37:05 UTC snapshot, ranked #1 (`finalPriorityScore=1.3842`,
`discoverySource: BROAD_UNIVERSE`) and won that cycle's single hot-swap slot. CHRW is proof the
pipeline **does** work end-to-end for a broad-universe-sourced symbol when (a) it clears the top-N
universe cut, (b) it clears the zero-score exclusion, and (c) it has the highest score among that
cycle's competitors. PTC satisfied (a) and (b) but lost (c) every single cycle in its window. This is
a legitimate, evidence-based outcome, not evidence of a defect in the scoring itself.

## 4. MPWR trace (corrected counts; real root cause identified)

Direct, corrected query against `observability_events` filtered on the `symbol` column for 2026-10-05:

| ts (UTC) | event_type | source | reason | gapPct |
|---|---|---|---|---|
| 17:06:53.167 | DISCOVERY_CANDIDATE_ADMITTED | BROAD_UNIVERSE | — | -0.00311 |
| 19:20:25.425 | DISCOVERY_CANDIDATE_ADMITTED | BROAD_UNIVERSE | — | 0.01224 |
| 19:36:05.348 | DISCOVERY_CANDIDATE_FILTERED | BROAD_UNIVERSE | ADV_DATA_UNAVAILABLE | 0.01833 |

Zero `DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT` rows mention MPWR today (exact-match on
`"symbol":"MPWR"` inside the snapshot's own candidate-array JSON — this field genuinely is embedded
in that event's payload, unlike the top-level `symbol` column other event types use). Zero
`SUBSCRIPTION_NOT_PROMOTED` rows for MPWR. MPWR reached `ADMITTED` twice and never reached
`UNIVERSE_SELECTED` either time.

**Root cause, confirmed by reading the code (`OpportunityDiscovery.ts:111-137`,
`BroadUniverseSubscriptionAllocator.ts:79-151`):**

`getOpportunityScanUniverse()` calls:
```ts
const broadUniverseSelected = selectBroadUniverseCandidates(
  getCachedBroadUniverseCandidatesWithVolume(),   // only symbols admitted on the LAST refresh
  continuousIntelligence.broadUniverseTopNPerScan, // hard cap
).map((r) => r.symbol);
```
`selectBroadUniverseCandidates()` ranks every *currently admitted* candidate by a liquidity-rank +
aging-fairness score and keeps only the top `broadUniverseTopNPerScan`. This mechanism was itself a
2026-09-16 fix for exactly this class of starvation (a prior raw dollar-volume slice could skip a
real mover forever); its aging term is **monotonic and will eventually win**, but only across
**consecutive cycles in which the candidate is continuously considered**. `cyclesSkipped` only
increments while a symbol is present in `getCachedBroadUniverseCandidatesWithVolume()` — and that
cache is replaced wholesale on each `refreshBroadUniverseCache()` call, which runs far less often
than the ~30-65s hot-swap cadence (confirmed: MPWR's own admission events are ~2h14m and ~16m apart,
not every cycle).

MPWR's actual behavior: admitted once, absent from the cache for ~2h14m (not re-admitted, not
re-filtered — just not present, meaning no record update and no aging progress during that gap),
briefly re-admitted, then filtered for `ADV_DATA_UNAVAILABLE` 16 minutes later. It never had a
continuous-enough presence in the admitted pool for the aging-fairness mechanism to accumulate before
either (a) a later refresh dropped it again, or (b) the ADV data source itself failed for it. Its two
real `gapPct` values (0.31%, 1.22%, 1.83%) are also small — on a day where CHRW's own gap alone scored
1.38 — so even a single considered cycle would not obviously have won the top-N cut on liquidity-rank
terms either; the aging bonus is the only lever that could have gotten it there, and intermittent
admission starves that lever too.

**Classification: `TOP_N_TRUNCATION`, compounded by `CACHE_PROPAGATION_DELAY`-style intermittent
admission defeating the aging-fairness guarantee's own continuity assumption.** This is a genuine,
confirmed, code-level mechanism — not a ranking-weight or threshold defect, and this report does not
recommend changing `broadUniverseTopNPerScan`, the aging formula, or the hot-swap cap to address it
(those are exactly the levers the user's constraints protect, and this investigation did not
independently prove any of them defective — it proved a *visibility* gap around them).

## 5. The confirmed, fixable defect: this transition was completely silent

Before this report's fix, a candidate excluded by the top-N cap left **zero trace** anywhere:
- No event at the exclusion point itself (`getOpportunityScanUniverse()`/`selectBroadUniverseCandidates()`).
- `BroadUniverseSubscriptionAllocator.ts` already tracks exactly who was excluded and why
  (`listAllocationRecords()`/`getAllocationRecord()` — `cyclesSkipped`, `cyclesEligible`,
  `lastSelectedAt`) but nothing in production ever read or logged it; confirmed via a repo-wide grep —
  `listAllocationRecords()` is called only from its own test file.
- The only way to reconstruct this transition at all was offline SQL archaeology across three
  different tables/columns, which is exactly the kind of forensic cost the investigation prompt asked
  to be designed out.

This matches the investigation's own `OBSERVABILITY_DEFECT` / silent-transition category and the
automatic-fix mandate: *"If a deterministic engineering defect is confirmed: FIX IT AUTOMATICALLY."*
It is purely additive logging — no selection, cap, weight, or threshold changes.

## 6. Fix applied

`src/server/continuous/OpportunityDiscovery.ts` — `getOpportunityScanUniverse()` now logs a new,
bounded observability event, `BROAD_UNIVERSE_TOPN_TRUNCATED`, immediately after computing the top-N
selection, whenever the admitted pool exceeds `broadUniverseTopNPerScan`:

- Aggregate fields (always present): `admittedCount`, `selectedCount`, `excludedCount`, `capacity`.
- Bounded per-candidate detail (top 25 excluded by dollar volume, never unbounded): `symbol`,
  `dollarVolume`, `cyclesSkipped`, `cyclesEligible` — read from the allocator's own already-maintained
  state (`getAllocationRecord()`), not a new fairness store.
- Wrapped in `observeSafe()` (the same fail-open pattern every sibling event in this file uses) so a
  logging failure can never affect the returned universe or any caller, including this function's
  existing synchronous test callers that only assert on the return value.
- Does not call `selectBroadUniverseCandidates()` a second time (which would have double-incremented
  the aging state) — it reads the single real selection result already computed for the production
  path.

**Regression tests added** (`src/server/continuous/opportunityUniverseTopN.test.ts`):
1. Fail-before/pass-after proof: with a tight cap (3 of 5 admitted), the event now fires with
   `admittedCount: 5, selectedCount: 3, excludedCount: 2`, and the excluded sample names exactly the
   two symbols that lost the cut (`FOURTH`, `FIFTH`) — not the winners.
2. Negative case: with a cap that fits every admitted candidate, the event does not fire at all
   (confirms this is additive-only, not a per-cycle log regardless of outcome).

**Verification run this pass:**
- `npx tsc --noEmit` — clean.
- Targeted: `OpportunityDiscovery.test.ts`, `opportunityUniverseTopN.test.ts` (5 tests, 2 new),
  `BroadUniverseSubscriptionAllocator.test.ts`, `OpportunityDiscovery.scaleAndAdversarial.test.ts` — all
  47 tests pass, including the new `BROAD_UNIVERSE_TOPN_TRUNCATED` event visibly firing in the
  existing scale/adversarial fixtures.
- Full `src/server/continuous/` + `architecture.protection.test.ts` — 363/364 pass. The one failure
  (`a browser WebSocket client disconnecting cannot reach TradingEngine/...`) is **pre-existing and
  unrelated** — a stale regex assertion (`expect(...).toMatch(/eventBus\.off/)`) against a WS
  close-handler body that was refactored into a `cleanupWildcard()` helper by the P1-defect-fix commits
  pulled into this branch earlier in this session (`7b87474`/`b48f060`), before this report's own
  change. Confirmed `cleanupWildcard()` still calls `eventBus.off('*', wildcardHandler)` internally
  (`server.ts:1867-1869`) — the real cleanup behavior is intact; only the test's string-matching broke.
  Not fixed here as it is outside this investigation's scope and touches `server.ts`, not the discovery
  pipeline; flagged for a separate, dedicated pass.

## 7. What this report explicitly did NOT change

`broadUniverseTopNPerScan`'s value, the aging-fairness formula or its constants
(`broadUniverseFairnessWindowCycles`), the hot-swap cap, any `tradingSafety.json` consensus/risk
number, RiskEngine, OMS, or any ranking weight in `continuousIntelligence.json`. The fix is read-only
with respect to selection outcomes — it logs what already happens, it does not change what happens.

## 8. Final classification

- **ADMITTED_TO_CHALLENGER_PIPELINE:** `PARTIALLY_OBSERVABLE_BEFORE_THIS_FIX` → `OBSERVABLE` after this
  change for the top-N truncation point; the separate zero-score exclusion point identified in the
  prior subscription-starvation forensic remains silent (not addressed in this pass — a candidate
  taxonomy item for a future, equally-scoped observability-only fix, not folded in here to keep this
  change minimal and reviewable).
- **PTC_ROOT_CAUSE:** `SCORING_COMPETITION_UNDER_SATURATED_CAPACITY` (confirmed rational loss to a
  higher-scoring competitor every cycle in its window — not a defect).
- **MPWR_ROOT_CAUSE:** `TOP_N_TRUNCATION` at `getOpportunityScanUniverse()`, compounded by intermittent
  broad-universe-cache admission defeating the aging-fairness mechanism's continuity assumption — now
  observable, not fixed at the selection-policy level (correctly out of scope per the constraints).
- **Counterfactual replay harness:** still not built, per the investigation's own explicit sequencing —
  the discovery→eligibility path is now materially more trustworthy (one real silent-exclusion point
  closed, one correction to a wrong admission count made), which is the stated precondition for that
  larger piece of work to be worth doing next.

## Final questions (selected, most load-bearing)

1. Is the remaining zero-score silent exclusion (inside the challenger-scoring stage, distinct from
   this report's top-N fix) worth the same bounded-observability treatment next?
2. Should `BroadUniverseSubscriptionAllocator`'s aging state itself become visible via a lightweight
   CLI/report command (`listAllocationRecords()` already exists and is unused in production) so an
   operator can see "who is accumulating aging credit but hasn't won yet" without DB archaeology?
3. Is `broadUniverseTopNPerScan`'s current value actually sized against real admitted-pool volume on a
   representative day (10,252 admissions today), or was it tuned against a much smaller historical
   pool? This report does not answer that — it was explicitly out of scope (no cap-size changes
   without independent proof of defect) — but the question is now answerable from logged data going
   forward.
4. Does the aging-fairness mechanism need an explicit decay-on-absence policy (vs. its current
   silent-pause-on-absence behavior). Also out of scope to answer definitively here, but now directly
   observable via `cyclesEligible`/`cyclesSkipped` in the new log event, and the reason the MPWR
   outcome arguably still needs a human policy call either way: is intermittent admission (driven by
   an upstream ADV data source, not by Argus's own ranking) something the aging model should be
   resilient to, or is that appropriately treated as "not yet a stable, trustworthy candidate"?
