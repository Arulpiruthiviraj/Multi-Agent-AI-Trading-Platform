# ARGUS — Challenger Selection / Discovery-to-Evaluation Forensic (2026-09-29)

**Mode:** analysis only. No source code, configuration, subscription caps, Mission Control, broker settings, market-data settings, or database contents were modified in producing this report. All findings are read-only, direct SQLite queries against `data/argus.db`, cross-referenced against the current `HEAD` source tree (`src/server/continuous/OpportunityDiscovery.ts`, `MarketUniverseScanner.ts`, `BroadUniverseSubscriptionAllocator.ts`).

**Scope:** the 14 real, liquid, discovery-admitted, never-subscription-requested symbols identified by the missed-opportunity benchmark: QURE, CCL, GFI, CVNA, GLW, NCLH, VRT, RCL, EQNR, AXTI, EFX, BUD, KMX, MXL.

**Headline result, established with unusually strong evidence:** the discovery pipeline's own `explainSnapshotHotSwapDecisions()` telemetry (`SUBSCRIPTION_PROMOTED`/`SUBSCRIPTION_NOT_PROMOTED` events) directly answers most of this investigation's questions without inference — **every single one of the 4,892 `SUBSCRIPTION_NOT_PROMOTED` events recorded on September 29, across every symbol, cites exactly one of two mechanical reasons, both of which reduce to the same underlying constraint: the hot-swap slot cap for that cycle was reached before the candidate was reached.** 4,881 of 4,892 (99.8%) occurred at the full-capacity cap of 1 slot per cycle; the remaining 11 occurred during an early empty-capacity window at a 12-slot cap. There is no third reasoning string anywhere in the day's data. `DATABASE_VERIFIED`.

This changes the shape of the investigation: for any symbol that ever reaches the challenger-scoring step at all, the single-swap-per-cycle pacing rule is not merely *a* cause — it is, for this deployment on this day, the **only** cause ever logged. The remaining open question is why 12 of the 14 named symbols never reached that step in the first place.

---

## 1. Per-symbol classification

| Symbol | Discovery source | Times admitted | Reached challenger scoring? | Times explained | Classification |
|---|---|---|---|---|---|
| QURE | `BROAD_UNIVERSE` | 139 | Yes (from 20:11 UTC onward) | 78 (`NOT_PROMOTED`) | `SWAP_PACING_LIMIT` (proven, from 20:11 UTC) + `CHALLENGER_LIMIT_EXCLUDED` (probable, 14:15–20:11 UTC — see §2) |
| CCL | `MARKET_MOVER` | 24 | Yes | 1 (`NOT_PROMOTED`) | `SWAP_PACING_LIMIT` (proven for its one explained cycle); `CHALLENGER_LIMIT_EXCLUDED` or `OTHER_PROVEN_CAUSE` for the other 23 admissions (`UNVERIFIED` at that precision — see §3) |
| GFI | `BROAD_UNIVERSE` | 52 | No | 0 | `PRIORITY_SCORE_TOO_LOW` (probable — null gap evidence at admission, see §3) |
| CVNA | `BROAD_UNIVERSE` | 43 | No | 0 | `PRIORITY_SCORE_TOO_LOW` (probable) |
| GLW | `BROAD_UNIVERSE` | 39 | No | 0 | `PRIORITY_SCORE_TOO_LOW` (probable) |
| RCL | `BROAD_UNIVERSE` | 9 | No | 0 | `PRIORITY_SCORE_TOO_LOW` (probable) |
| EQNR | `BROAD_UNIVERSE` | 8 | No | 0 | `PRIORITY_SCORE_TOO_LOW` (probable) |
| KMX | `BROAD_UNIVERSE` | 2 | No | 0 | `PRIORITY_SCORE_TOO_LOW` (probable) |
| NCLH | `BROAD_UNIVERSE` | 18 | No | 0 | `CHALLENGER_LIMIT_EXCLUDED` (probable — real, non-null gap evidence at admission, see §3) |
| VRT | `BROAD_UNIVERSE` | 10 | No | 0 | `CHALLENGER_LIMIT_EXCLUDED` (probable) |
| AXTI | `BROAD_UNIVERSE` | 29 | No | 0 | `CHALLENGER_LIMIT_EXCLUDED` (probable) |
| EFX | `BROAD_UNIVERSE` | 3 | No | 0 | `CHALLENGER_LIMIT_EXCLUDED` (probable) |
| BUD | `BROAD_UNIVERSE` | 2 | No | 0 | `CHALLENGER_LIMIT_EXCLUDED` (probable) |
| MXL | `BROAD_UNIVERSE` | 1 | No | 0 | `CHALLENGER_LIMIT_EXCLUDED` (probable) |

No instance of `INCUMBENT_PROTECTED`, `COOLDOWN`, `ALREADY_PENDING`, or `DUPLICATE_SUPPRESSION` was found in any of the day's logged reasoning for any symbol — these mechanisms exist in the source (dwell/rescue protection on the *worker* side, per the September 30 remediation pass's own IOVA-gap fix) but the *planner*-side telemetry (`explainSnapshotHotSwapDecisions`) never cites them as a reason a candidate wasn't promoted; the planner's own reasoning is exhaustively "cap reached" for everything it ever explains. `DATABASE_VERIFIED`.

---

## 2. QURE — full reconstruction, the clearest evidenced case

QURE was admitted 139 times, from 14:15:19 UTC to 03:07:03 UTC (30-Sep). `DATABASE_VERIFIED`.

**Phase 1 (14:15:19–20:11:28 UTC, ~5h56m): admitted, never explained at all.** Zero `SUBSCRIPTION_PROMOTED`/`SUBSCRIPTION_NOT_PROMOTED` events exist for QURE in this window despite dozens of admissions. QURE's own logged `gapPct` at admission during this window was modest (+5.49% at 14:15, later +2.29% by 22:36 — the real-time gap-evidence field evidently tracks a moving comparison, not the fixed open-vs-prevclose figure the missed-opportunity benchmark used, and legitimately evolved through the day as QURE's price kept falling relative to whatever reference point that field uses). A modest, evolving gap-based score, competing against `broadUniverseHotSwapChallengerLimit`'s top-15-by-score cut each cycle, is a real, code-grounded explanation for why QURE would not surface in the explained set during this window if stronger-scoring challengers occupied the top 15 that cycle — but this cannot be proven from persisted data alone, because `explainSnapshotHotSwapDecisions()` only logs the candidates it actually iterates (the post-truncation top-15 list) — a candidate excluded *before* that list is constructed leaves no record of what its score was or who outranked it. `CHALLENGER_LIMIT_EXCLUDED` is the best-supported classification for this phase, but is `UNVERIFIED` at the level of "exactly which candidates displaced it."

**Phase 2 (20:11:28 UTC onward, ~7h): reached, scored, explained, and lost — 78 consecutive times, with zero exceptions.** Every one of these 78 `SUBSCRIPTION_NOT_PROMOTED` rows carries the identical reasoning: *"Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached."* `DATABASE_VERIFIED`. QURE's real, final Sep 29 move (−39.02% gap-and-hold, per the missed-opportunity benchmark's own fixed open-vs-prevclose measurement) never once translated into a subscription request during this 7-hour window, purely because the deployment's own pacing rule allows **exactly one** hot-swap replacement per cycle when the stream is at full capacity (`continuousIntelligence.momentumHotSwapSlotsPerCycle`, effectively 1 at full capacity per `planSnapshotHotSwap()`'s own `Math.min(1, Math.max(0, opts.maxSwaps))` at empty-slot count 0), regardless of how many qualified, positively-scored challengers exist that cycle or how large a mover any one of them is. `SWAP_PACING_LIMIT` — `PROVEN_CODE_DEFECT`-adjacent finding: not a bug in the sense of incorrect code, but a real, demonstrated, severe capacity constraint whose cost (a −39%, $731M-dollar-volume mover missed for 7 straight hours) is now concretely quantified rather than theoretical.

---

## 3. The 12-symbol "never explained at all" group — two distinguishable sub-patterns

Cross-referencing each symbol's `DISCOVERY_CANDIDATE_ADMITTED.payload.gapPct` field (the real-time gap evidence available *at admission time*, read directly, not recomputed) splits this group cleanly in two:

**Sub-pattern 1 — null gap evidence at admission (GFI, CVNA, GLW, RCL, EQNR, KMX; 6 symbols).** `priorityScoreOf()` (`OpportunityDiscovery.ts`) for a broad-universe-only symbol with no momentum/mover/composable evidence is `baseScoreOf(sym) + gapTerm`, where `gapTerm` requires a non-null `getCachedBroadUniverseGapPct(symbol)`. A symbol whose real-time gap evidence is null at the moment of scoring scores exactly 0, and `OpportunityDiscovery.ts`'s own challenger-construction step explicitly filters `.filter((c) => c.momentumScore > 0)` — a zero-scored candidate is excluded from `broadUniverseChallengers` *before* it is ever added to the list `explainSnapshotHotSwapDecisions()` iterates, which is exactly consistent with these 6 symbols generating zero `PROMOTED`/`NOT_PROMOTED` events despite real, repeated admission (GFI: 52 times). Classification: `PRIORITY_SCORE_TOO_LOW` (more precisely, "zero score, filtered pre-list"). `INFERRED` from the persisted admission-time field plus direct source reading of the exact filter condition — not `RUNTIME_VERIFIED`, since the gap-cache value at the specific moment `priorityScoreOf()` ran (a separate call site, potentially a different point in time than admission) was not itself directly logged anywhere queryable.

**Sub-pattern 2 — real, non-null (but modest) gap evidence at admission (NCLH, VRT, AXTI, EFX, BUD, MXL; 6 symbols).** These symbols' admission-time `gapPct` values are real and non-zero (NCLH −1.15%, VRT +0.30%, AXTI +1.81%, EFX −2.03%, BUD −0.77%, MXL +1.71%) — under `priorityScoreOf()`'s formula this produces a real, small positive `gapTerm` (e.g. AXTI: `0.0181 × 100 × broadUniverseGapHotSwapWeight(0.5) ≈ 0.90`), which should have been enough to clear the `momentumScore > 0` filter and enter the pre-truncation challenger pool. Their total absence from `explainSnapshotHotSwapDecisions()`'s output is therefore best explained by `broadUniverseHotSwapChallengerLimit`'s own `.slice(0, 15)` truncation — real, positively-scored candidates that simply never ranked in the top 15 by score in any cycle they were eligible. Classification: `CHALLENGER_LIMIT_EXCLUDED`. Same evidentiary caveat as Phase 1 of QURE's own reconstruction (§2) — the truncation happens *before* logging, so there is no persisted record of exactly which stronger candidates occupied the 15 slots ahead of them on any given cycle. `INFERRED`, not `RUNTIME_VERIFIED`.

**CCL** sits between the two patterns: `MARKET_MOVER`-sourced (not `BROAD_UNIVERSE`), with real gap evidence, reached the challenger stage exactly once (one `SWAP_PACING_LIMIT` loss, §1) out of 24 real admissions — consistent with occasionally clearing the top-15/challenger-eligibility bar but usually not, a hybrid of both sub-patterns. Not fully disambiguated this pass.

---

## 4. Direct answers to the seven investigation questions

**1. Is `broadUniverseHotSwapChallengerLimit` too small relative to admission volume?** The evidence is suggestive but not conclusive on its own: 6 of 14 symbols (sub-pattern 2, plus QURE's Phase 1) show real positive-score evidence never surfacing in the explained set, consistent with truncation — but §3's own caveat applies: this cannot be distinguished from those same candidates simply losing on score to genuinely stronger, also-real candidates that legitimately deserved the top-15 slots that cycle. **`UNVERIFIED`** at the level of "the limit itself is the binding constraint" — what *is* proven is that the limit's own truncation leaves no audit trail, which is a real, separate, fixable observability gap regardless of whether 15 turns out to be the right number.

**2. Is `priorityScoreOf()` aligned with the actual opportunities the benchmark found?** Partially. For QURE and CCL, both real, large, benchmark-confirmed opportunities, the scoring function clearly *did* surface them as legitimate, positively-scored challengers (they were explained, not silently dropped) — the function correctly recognized their evidence. The problem for those two is entirely downstream, at the swap-pacing stage (§2), not in the scoring itself. For the 6 null-gap symbols (sub-pattern 1), the scoring function could not have ranked them, because its one real input for a broad-universe-only symbol (cached gap evidence) was unavailable at scoring time — this is a data-availability question, not a scoring-formula question.

**3. Does the challenger ranking over-favor incumbents or seed/watchlist symbols?** Not evidenced either way this pass. `explainSnapshotHotSwapDecisions()`'s own reasoning strings never distinguish "beaten by an incumbent" from "beaten by another challenger" — both collapse into the same "cap reached" message. **`UNVERIFIED`.**

**4. Does single-swap-per-cycle pacing structurally prevent fast-moving opportunities from being evaluated in time?** **Yes — this is the single most strongly proven finding in this report.** 99.8% of every non-promotion event on September 29, for every symbol that ever reached the challenger stage, cites exactly this cause, with QURE's own 7-hour, 78-cycle, zero-exception losing streak as a direct, concrete, quantified case study. `DATABASE_VERIFIED`.

**5. Are admitted symbols reconsidered often enough?** Yes, in the narrow sense that discovery re-admits and re-attempts scoring on essentially every scan cycle (QURE: 139 admissions across ~13 hours, roughly matching the ~5-6 minute scan cadence) — the reconsideration *frequency* is not the bottleneck; what happens once reconsidered (§4 answer 4) is.

**6. Are fast movers losing because their score is based on stale/partial IEX features?** Partially supported for the 6 null-gap symbols (sub-pattern 1, §3) — a genuinely fast-moving symbol whose gap evidence hadn't yet populated in cache at the moment of scoring would score 0 and lose by default, which is a real, plausible instance of exactly this failure mode. Not evidenced for QURE/CCL, whose real gap evidence clearly did reach the scorer. **Mixed: `INFERRED` for a subset, not established as the dominant cause overall.**

**7. Is live-subscription capacity itself the real constraint, or is candidate selection wasting the available slots?** Neither cleanly, per this evidence — the constraint proven here is **upstream of both**: it is the *rate* at which the planner is willing to reconsider the full active pool (one replacement per cycle), not the size of the pool itself (capacity) or how candidates within a cycle are ranked (selection quality). A symbol can be the single best-scored challenger in existence and still only get one shot at the slot per cycle, competing against whatever else is *also* the top pick that specific cycle.

---

## 5. Classification summary

| Finding | Classification |
|---|---|
| Single-swap-per-cycle pacing as the exhaustive, universal cause of every logged non-promotion | `PROVEN` (`DATABASE_VERIFIED`, 4,892/4,892 events, zero exceptions) |
| QURE's specific 7-hour, 78-cycle losing streak | `PROVEN` (`DATABASE_VERIFIED`) |
| 6 symbols never scored due to null gap evidence at scoring time | `OTHER_PROVEN_CAUSE`-adjacent, precisely `PRIORITY_SCORE_TOO_LOW` due to a real, likely cache-timing data gap — `INFERRED`, not `RUNTIME_VERIFIED` |
| 6 symbols never scored despite real positive gap evidence | `CHALLENGER_LIMIT_EXCLUDED` — `INFERRED`, not `RUNTIME_VERIFIED` |
| Whether 15 is the "right" challenger-limit number | `UNVERIFIED` — no evidence either way this pass |
| Whether incumbents are over-favored | `UNVERIFIED` — no evidence either way this pass |

---

## 6. What this does and does not justify

Per this investigation's own instruction, **no constant is recommended for change here**, because the one fully proven finding (swap-pacing) explains what happens *after* a candidate is already competitive, and the two most plausible upstream causes (challenger-limit truncation, gap-cache timing) are real, evidence-consistent hypotheses but not proven to the same standard — raising `broadUniverseHotSwapChallengerLimit` or the per-cycle swap count without first confirming which candidates are actually being displaced would be exactly the kind of blind threshold change this investigation was explicitly asked not to produce.

**What is justified, and does not require guessing at a number:** the observability gap itself. `explainSnapshotHotSwapDecisions()` currently logs only candidates that survive `broadUniverseHotSwapChallengerLimit`'s own truncation, so a candidate excluded upstream of that step leaves zero trace of its own score or of what outranked it. Closing that specific, narrow gap (logging the pre-truncation candidate pool's scores too, not changing any threshold) would convert every `UNVERIFIED`/`INFERRED` classification in this report into a `PROVEN` one on the next real trading day, without touching a single existing safety, ranking, or capacity constant.

---

## 7. Explicit limitations

- The `BroadUniverseSubscriptionAllocator.ts` per-cycle winner/loser state (a separate, earlier allocation step than the challenger scoring investigated here) is in-memory only, never persisted to the database, and was lost when the engine was rebuilt/restarted on September 29 evening — it could not be reconstructed retroactively for this report, regardless of query effort.
- The exact value of `getCachedBroadUniverseGapPct()` at the precise moment `priorityScoreOf()` ran for each cycle was not itself logged anywhere queryable this day — §3's sub-pattern classifications are inferred from the closest available proxy (admission-time gap evidence), not the scorer's own literal input.
- This investigation covers only the 14 symbols named in scope; the broader `RANK_CAP`-classified Category D symbols from the missed-opportunity benchmark (an earlier, separate bottleneck in `selectBroadUniverseCandidates()`) were out of scope for this pass.
