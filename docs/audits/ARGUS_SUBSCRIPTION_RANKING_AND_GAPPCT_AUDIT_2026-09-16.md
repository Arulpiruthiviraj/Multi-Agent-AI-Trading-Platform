# ARGUS — Subscription Ranking Semantics + gapPct Provenance Audit (2026-09-16, narrow follow-up)

Diagnostic-only pass per explicit scope: audit, measure, fix only an objective defect if found,
**do not change subscription limits, do not alter strategy thresholds, do not force trades, do not
touch tonight's live session.** One narrow, objective observability fix was made (§3); no restart was
performed; the running production process (PID 25936) is untouched.

## 1. Is `broadUniverseTopNPerScan = 20` a capacity limit or a permanent top-20 cutoff?

**Read directly from source, not inferred.** `getCachedBroadUniverseSymbols()`
(`MarketUniverseScanner.ts`) returns `snapshotCache.symbols`, which is set from `passing` —
`advPassers.sort((a, b) => b.dollarVolume - a.dollarVolume).slice(0, broadUniverseMaxCandidates)` —
**re-sorted by raw dollar volume, descending, on every cache refresh.**
`getOpportunityScanUniverse()` (`OpportunityDiscovery.ts`) then takes
`.slice(0, broadUniverseTopNPerScan)` — the literal top 20 of that freshly-re-sorted list — **every
single time it's called, with no persisted state, no memory of which candidates were previously
passed over, and no rotation mechanism.**

**Finding: in its current implementation, this is not a per-cycle capacity throttle with eventual
coverage — it behaves as an effectively permanent top-20-by-dollar-volume filter**, because the
sort criterion (raw dollar volume) does not meaningfully reorder from cycle to cycle for the symbols
that occupy the top of that ranking. The variable's own name (`...PerScan`) suggests the *original
intent* was likely a per-cycle consideration window meant to eventually rotate — but no code
implements that rotation. Whether this mismatch between name and behavior was ever a deliberate
design decision or an unfinished implementation could not be determined from any config comment or
commit message found tonight — genuinely unclear, not glossed over.

## 2–3. Measured starvation, this session's data

Direct query of today's real discovery-lineage data (1,418 distinct symbols with an observed dollar
volume today):

**Top 20 by dollar volume today**: SPCX ($768M), NVDA ($487M), META ($368M), QQQ ($363M), MSFT
($363M), MU ($332M), AMZN ($321M), AAPL ($300M), AMD ($290M), AVGO ($285M), TSLA ($274M), INTC
($251M), TLT ($239M), IBIT ($226M), BAC ($218M), GOOGL ($190M), SMH ($186M), ORCL ($169M), TSM
($165M), SNDK ($158M) — a list dominated by structurally always-highest-dollar-volume mega-caps and
index ETFs, the kind of list that would look nearly identical on almost any ordinary trading day.

**Where today's five pre-registered real movers (from the companion reverse-engineering audit)
actually rank**, out of 1,418:

| Symbol | Rank | Dollar volume |
|---|---|---|
| ON | **99** | $51.1M |
| TENB | **262** | $24.6M |
| BOOT | **357** | $18.5M |
| ALHC | **615** | $10.8M |
| BBNX | **622** | $10.7M |

**None come remotely close to the top-20 cut.** ON, the closest, is still ~5x outside the window.
This is concrete, quantitative confirmation: it is not a rare edge case that a genuine, liquid,
material mover (here, 10–17% single-day moves on $10–50M-dollar-volume names) fails to crack the
top-20-by-raw-dollar-volume window — under the current design, that is the *structurally expected*
outcome on essentially any ordinary day, because mega-caps' dollar volume (3–70x larger even without
any special event) will almost always fill every slot first.

**A direct multi-cycle rotation measurement (does a different set of 20 names occupy the window on
different cycles today) could not be completed** — see §3a, a real gap this investigation itself
uncovered and fixed for future use, but too late to reconstruct today's historical rotation pattern
from data that was never captured.

### 3a. A second, real, objective defect found and fixed: the diagnostic signal itself was being silently dropped

`instrumentEventBus.ts`'s generic EventBus→observability bridge extracts a **fixed, hardcoded field
whitelist** (`symbol, side, status, gate, approved, agent, confidence, orderId, stage, agentType,
lastError, providersAttempted`) for every event type. This exact defect class — a fixed whitelist
silently dropping fields for event types whose real payload doesn't match it — was already found and
narrowly fixed twice before in this same file (`AI_PROVIDERS_EXHAUSTED`, 2026-09-06/07;
`NEWS_ANALYZED`'s plural `symbols`, 2026-09-10), per the file's own comments.

**Confirmed live tonight, a third instance**: `WATCHLIST_SUBSCRIBE_REQUESTED`'s real payload
(`OpportunityDiscovery.ts`) carries `reason` (`SNAPSHOT_HOT_SWAP` / `SEED_UNIVERSE_EXPANSION` /
`BROAD_UNIVERSE_TOPUP`), `source`, and `momentumScore` — none of which were in the whitelist. **All
5,126 real `WATCHLIST_SUBSCRIBE_REQUESTED` rows persisted today collapsed to `{symbol}` only.** This
made it impossible to determine, from stored data alone, how many of today's subscribe requests came
from the new `BROAD_UNIVERSE_TOPUP` path versus momentum's own picks — exactly the measurement this
investigation needed and exactly the kind of "known telemetry gap" the earlier pre-market readiness
report had already flagged as real but unaddressed (`CAPACITY_WAIT`/`PACED` not distinguishable).

**Fixed** (narrow, same established pattern, three-line addition): `reason`, `source`, and
`momentumScore` added to the whitelist. **Regression test added**
(`instrumentEventBus.test.ts`), passing. This is a pure observability fix — it changes what gets
*recorded*, never trading behavior, subscription limits, or thresholds. **Not deployed to the
currently-running process tonight** (no restart performed, per the explicit "leave tomorrow's live
funnel untouched" instruction) — ready for the next natural restart.

## 4. gapPct provenance audit

Traced to its exact computation (`MarketUniverseScanner.ts`):

```ts
const openPrice = snap?.dailyBar?.o;
const gapPct = (typeof openPrice === 'number' && Number.isFinite(openPrice) && openPrice > 0)
  ? (price - openPrice) / openPrice
  : null;
```

Answering the specific questions asked:

- **Which price is used?** `price` = `latestTrade.p` (falling back to `dailyBar.c`) versus
  `openPrice` = `dailyBar.o` — **today's own session open, not yesterday's close.** This makes the
  field's name a genuine misnomer: it computes *intraday return since today's open*, not a
  traditional overnight gap. Not itself a bug, but worth correcting the label to avoid exactly the
  kind of misreading that shaped tonight's own selection-rule work.
- **Can it be stale?** Both `price` and `openPrice` come from the same single Alpaca snapshot call —
  no separate staleness window between them, but `dailyBar.o` for a very illiquid name can itself be
  a stale or thin print with no explicit recency check.
- **Corporate actions/splits?** Not something this pass could conclusively rule in or out from
  available data — a real, disclosed unknown, not silently assumed clean.
- **Zero/near-zero reference prices possible?** **Yes, and this is the most likely root cause.**
  The only guard is `openPrice > 0` — any tiny-but-positive value (a fraction of a cent, plausible
  for a stale or erroneous print on a thin name) passes this check and produces an arbitrarily large
  `gapPct` with nothing to catch it.
- **Same data source as execution?** Yes — same Alpaca IEX snapshot endpoint already used for the
  rest of the stage-1 screen; not a cross-source mismatch.
- **Can discovery admit a symbol based on a corrupted gap?** `gapPct` does not itself gate admission
  (admission is price/dollarVolume/spread/ADV), but a corrupted value **does** feed directly into
  `isGapMover()` (Discovery Lineage Ledger tagging) and, more seriously, into
  `recordDiscoveryOutcomeProbe()` — which **persists a real shadow-prediction row keyed on this
  number** whenever the candidate is admitted and `gapPct !== null`. A corrupted 985%-class value
  would write a real, wrong row into that outcome-tracking table.
- **Does the stored event preserve source timestamp/provenance?** No — no timestamp or source
  marker is attached to `gapPct` beyond the event's own `ts`; there is no way to distinguish "this
  gap reflects genuinely fresh data" from "this gap was computed off a stale snapshot" after the
  fact.
- **Cross-validation available but unused**: `SnapshotScanner.ts` (a sibling file in this same
  codebase) already fetches and uses `prevDailyBar.c` for its own `prevClose` calculation.
  `MarketUniverseScanner.ts`'s `gapPct` computation does not cross-check `dailyBar.o` against
  `prevDailyBar.c` at all, despite the data already being one field away in the same snapshot
  response shape.

**Real evidence of the defect**: today's raw (pre-liquidity-filter) top gapPct values — RETO 985%,
MEDS 394%, PDYNW 356%, QCLS 342%, DLXY 315% — are physically implausible for ordinary single-session
equity moves and are consistent with an unvalidated near-zero or stale `openPrice`, not genuine
price action.

### Deliberately not fixed tonight, and why

Per the explicit instruction ("Don't 'fix' the gap threshold just to make today's list prettier. Find
the calculation defect, if one exists"), this pass stopped at diagnosis. A correct fix requires a
judgment call this pass did not make: what sanity bound is defensible (an absolute price floor on
`openPrice`? a cross-check against `prevDailyBar.c` with what tolerance? an outright `|gapPct|`
cap, and at what value — genuine single-session biotech/small-cap gaps of 50–100%+ do occur on real
binary catalysts, so an aggressive cutoff risks discarding real signal, not just noise). Inventing
that number unilaterally tonight would be exactly the "tune it to make the report look complete"
outcome this investigation was explicitly told to avoid. **No test was added for this finding** — a
test that merely proves the current, unvalidated behavior "passes" is not a meaningful regression
test; a real fix, once the sanity-bound decision is made deliberately, should come with its own test
at that time.

## 5–9. Explicit constraints — confirmed honored

- Subscription limits (`broadUniverseTopNPerScan`, `maxNewSubscriptionsPerCycle`, `snapshotTopCandidates`):
  **unchanged.**
- Strategy thresholds: **unchanged.**
- No trade was forced, injected, or manually created.
- Today's live production session (PID 25936) was **not restarted or otherwise touched** — the one
  code change made (§3a) sits in source, tested, and undeployed tonight.

## Summary of findings

1. **Real architecture finding, not yet acted on**: the top-20-per-cycle candidate window behaves as
   an effectively permanent dollar-volume filter, not a rotating capacity throttle — concretely
   confirmed to exclude real, material, liquid movers as the *normal* case, not an edge case. This is
   a genuine policy/architecture question for a deliberate decision, not a same-night fix — exactly
   matching the caution already given about not jumping straight to raising the limit.
2. **Real defect found and fixed**: the observability bridge was silently dropping the exact
   diagnostic field (`reason`) this investigation needed, for the third time in this codebase's
   history of the same fixed-whitelist gap class. Fixed narrowly, tested, not yet deployed.
3. **Real defect found, deliberately not fixed**: `gapPct` has no validation against a stale or
   near-zero reference price, produces physically implausible values, and feeds a real persisted
   outcome-tracking row when it does. Diagnosed with concrete evidence; the actual fix needs a
   deliberate threshold/cross-validation decision this pass did not make unilaterally.

None of tonight's findings change the standing conclusion: `LIVE ALPHA VALIDATION: NOT ESTABLISHED`,
`REAL MONEY NO-GO`. What changed is the precision of *why* — the boundary between "engineering works
correctly" and "the market hasn't shown Argus an opportunity yet" is now drawn one layer more
accurately than it was this morning.
