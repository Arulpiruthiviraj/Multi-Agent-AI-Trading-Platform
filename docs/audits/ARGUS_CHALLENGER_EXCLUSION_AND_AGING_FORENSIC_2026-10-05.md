# ARGUS — Challenger Exclusion & Aging Forensic (2026-10-05)

**Scope:** Follow-up to `ARGUS_ADMITTED_TO_CHALLENGER_FORENSIC_2026-10-05.md`. That report closed the
top-N truncation silent-exclusion point. This pass picks up the remaining open items: the aging
"pause vs. reset" question, operator visibility into allocator aging state, and a systemic funnel
count across today's real admitted candidates.

**Note on parallel work:** two of this report's originally-planned items — the per-symbol
`BROAD_UNIVERSE_CHALLENGER_EXCLUDED` observability event and the `architecture.protection.test.ts`
fix — were independently built and pushed to `origin/main` by another session working on the same
investigation concurrently (`c574f08`, `2715951`) before this pass reconciled with them. Rather than
push a competing duplicate implementation, this report keeps their version as authoritative and
documents what this pass found and fixed **on top of** it, plus the genuinely new work (aging
visibility, the funnel count, the pause-semantics proof).

**Non-negotiable constraints honored:** no change to `broadUniverseTopNPerScan`,
`broadUniverseFairnessWindowCycles`, the hot-swap cap, the subscription maximum, any ranking weight,
strategy thresholds, the consensus threshold, RiskEngine, or OMS.

---

## 1. A real, confirmed defect found in the parallel session's own fix — and fixed

`c574f08`'s `BROAD_UNIVERSE_CHALLENGER_EXCLUDED` event referenced `cycleId` inside its log payload
before that `const` was declared later in the same function scope (the declaration was reused,
unchanged, from the pre-existing snapshot/swap-outcome events further down). Because the reference
sits inside a closure passed to `observeSafe(() => { ... })`, TypeScript's compiler does not flag it
as a same-scope use-before-declare (it only statically analyzes direct, same-block usage, not
usage deferred into a callback), so `tsc --noEmit` passed clean on the original code. At runtime,
every single cycle that reached this block threw a `ReferenceError: Cannot access 'cycleId' before
initialization` synchronously inside the `observeSafe` callback — which `observeSafe()` is
specifically designed to swallow (incrementing `logger_errors`, never propagating). The practical
result: **`BROAD_UNIVERSE_CHALLENGER_EXCLUDED` had never successfully fired, even once**, since it
was added — confirmed directly: before this fix, a dedicated end-to-end test exercising this exact
code path through `runOpportunityScan()` found zero matching log calls, even though the companion
unit test suite (`challengerExclusionReason.test.ts`) passed, because that suite only ever calls
`classifyExclusionReason()` directly, in isolation, never through the real pipeline.

**Fix:** hoisted the `cycleId` declaration to before the exclusion block (pure, side-effect-free —
`cycle_${now.getTime()}`), reused unchanged by the later snapshot/swap-outcome events exactly as
before. Confirmed fixed with an end-to-end regression test.

## 2. A second real bug in the same new event: the sort it claimed never ran

The event's own comment said its bounded 25-entry sample was *"top 25 by absolute gap (most
'interesting' exclusions first)"* — but the code was `zeroScoreExcluded.slice(0, 25)` with no sort at
all beforehand. Confirmed with a dedicated test: a fixture with one broad-universe-sourced,
zero-scored symbol alongside the real static seed/watch universe (which also ties at
`baseScore=0`/`gapPct=null` under a no-fresh-data mock) showed the static noise winning the
unsorted bound every time, silently crowding out the one case this event exists to surface.

**Fix:** sorts non-static-sourced exclusions (broad-universe/mover/news) first, then by absolute gap
magnitude descending — matching the comment's original intent. Display/sampling order only; never
changes which candidates are excluded or their real scores.

## 3. Confirmed, via a corrected end-to-end test: Infinity is dead code in `classifyExclusionReason`

`classifyExclusionReason()`'s own `INFINITE_SCORE` branch is directly unit-tested and reachable in
isolation, but the real pipeline's eligibility filter (`finalScore > 0`) is `true` for `Infinity`, so
an Infinite-scored candidate never enters `zeroScoreExcluded` and this classifier is never actually
invoked with one in production — it is promoted like a normal winner instead. Proven end-to-end (not
just asserted against the isolated classifier) with a new test: an `Infinity`-scored candidate is
confirmed subscribed (`WATCHLIST_SUBSCRIBE_REQUESTED` fires for it) and never appears in the excluded
sample. **Not fixed in this pass** — correcting it would change real scoring/selection behavior
(whether an Infinite/corrupt score should fail closed), which an observability-only pass should not
decide silently. Flagged as a named candidate for a future, separately-authorized pass.

*(Both of this report's own first two test attempts for the above initially failed for an unrelated,
self-inflicted reason: the placeholder symbols used - `BUNOEVD`, `INFSCX` - exceeded
`looksLikeListedTicker()`'s real 5-letter/no-digit ticker format and were silently rejected before
reaching the code under test. Corrected to valid 5-letter placeholders (`BUNEV`, `INFSC`) once traced
via direct instrumentation - noted here as a reminder that this exact validator has caused this same
class of test mistake before in this file, per its own pre-existing comment at the `BUAAA`..`BUFFF`
test case.)*

## 4. Allocator aging state — now operator-visible, read-only

`BroadUniverseSubscriptionAllocator.listAllocationRecords()` already existed but was called only from
the allocator's own test file. New: `GET /api/v2/observability/broad-universe-aging`
(`?format=text`, `?sortBy=mostSkipped|mostEligible|longestSinceSelected`) and
`argus-cli broad-universe-aging [--sortBy=...]`, following the exact pattern `/rescue-occupants`
already established. `currentlyPresent` is a pure Set lookup against the current broad-universe
admission cache — never a second invocation of `selectBroadUniverseCandidates()`, which would corrupt
its own cycle bookkeeping. No mutation, never consulted by any trading decision.

**Honest scope limitation:** `currentlyTopN`/`currentlyChallengerEligible` are not included — computing
either safely would require a new, side-effect-free dry-run variant of the allocator, not built here.

## 5. Paused vs. reset aging — proven directly, not just read from code

`BroadUniverseSubscriptionAllocator.ts`'s update loop only visits symbols present in **that cycle's**
input array; a symbol absent from the current admitted set is neither incremented nor reset — it is
simply not touched. Confirmed with a new, deterministic 21-cycle test: a candidate admitted on cycle
1 (not selected, `cyclesSkipped: 1`), absent for cycles 2–20, then readmitted on cycle 21, shows
`cyclesSkipped: 2`/`cyclesEligible: 2` on return — not 1 (reset) and not 20 (continuous background
accrual). This is **PAUSED aging**, measured empirically.

**Fairness contract, re-examined against this evidence:** the allocator's own header comment promises
accumulation *"each cycle it is NOT selected"* — read against the real update-loop code, this scopes
the guarantee to continuously-admitted candidates, not "ever admitted" candidates. **Current behavior
matches its own documented contract.** MPWR's outcome (2 real admissions, far short of the aging
threshold) is not a contract violation — the contract's own precondition (continuous admission) was
never met, because the admission itself is intermittent (driven by the upstream ADV data source, not
by this allocator). Whether intermittent admission *should* count toward the guarantee the same way
continuous admission does is a real, open policy question this pass does not resolve (see Final
Questions) — not something code can silently decide.

## 6. October 5 systemic funnel (new)

Direct query against `observability_events` for the full 2026-10-05 session:

| Population | Count |
|---|---|
| Distinct symbols admitted at least once | 592 |
| Distinct symbols with ≥10 admissions today | 362 |
| Distinct symbols ever `SUBSCRIPTION_PROMOTED` | 179 |
| Distinct symbols ever `SUBSCRIPTION_NOT_PROMOTED` | 201 |
| Of the ≥10-admission population: never promoted | 236 |
| Of the ≥10-admission population: never reached **either** `SUBSCRIPTION_PROMOTED` or `SUBSCRIPTION_NOT_PROMOTED` (never reached the promotion/challenger decision stage at all) | **191** |

Sample names (by admission count): DE(88), C(88), NVO(75), MLM(73), OXY(67), BMY(66), CCJ(60),
LHX(57), MCO(50), FTNT(50), AMGN(50), QRVO(49), SLB(48), AXP(48), KR(46), HCA(46), EQT(46), NXPI(45),
EXE(44), DHI(43) — a broad mix of real, liquid, well-known large-caps, not thin/illiquid noise.

**Reframing MPWR's diagnostic value:** this 191-symbol population is the same shape as MPWR —
admitted repeatedly, never reaching a promotion/non-promotion decision — at roughly two orders of
magnitude larger scale. MPWR was never a special case; it was a visible, traceable example of what
turns out to be the modal outcome for frequently-admitted symbols today.

**Honest caveat:** today's admissions predate every fix in this and the prior report
(`BROAD_UNIVERSE_TOPN_TRUNCATED`, the now-actually-firing `BROAD_UNIVERSE_CHALLENGER_EXCLUDED`). This
retroactive count cannot be split into "top-N truncated" vs. "zero-score excluded" vs. "never had a
cycle at the right time" for today specifically — that attribution only becomes possible for
admissions occurring after both fixes are live and actually emitting.

## What was fixed in this pass

1. The `cycleId` temporal-dead-zone bug that silently prevented `BROAD_UNIVERSE_CHALLENGER_EXCLUDED`
   from ever firing (Section 1) — the single most consequential finding here, since it meant the
   parallel session's own fix had never actually taken effect.
2. The event's sampling-order bug — static-universe zero-score noise crowding out the diagnostically
   interesting cases (Section 2).
3. `GET /api/v2/observability/broad-universe-aging` + `argus-cli broad-universe-aging` (Section 4).
4. Two new tests proving the fixes above, plus a corrected end-to-end proof that `INFINITE_SCORE` is
   dead code in the real pipeline (Section 3).
5. A new deterministic test proving aging-pause semantics (Section 5).

## What was explicitly NOT changed

`broadUniverseTopNPerScan`, `broadUniverseFairnessWindowCycles`, the hot-swap cap, the 90-line
subscription maximum, any ranking weight, any `tradingSafety.json` threshold, RiskEngine, OMS. The
aging-pause-on-absence semantics are measured and test-locked, not altered. The Infinity
non-exclusion gap is documented, not patched. `classifyExclusionReason()`'s exact reason-code
taxonomy (from the parallel session) is unchanged.

## Verification

`npx tsc --noEmit` clean. `src/server/continuous/` (32 files) + `architecture.protection.test.ts` +
`src/server/fastlane/` full re-run: 392/392 pass. `npm run build` succeeds.

## Final questions

1. **Should the `cycleId` TDZ-class bug prompt a lint rule or review-checklist item** for any future
   `observeSafe(() => {...})` block referencing a variable declared later in the same outer scope?
   `tsc` does not catch this pattern; only an end-to-end runtime test did.
2. **Is intermittent admission eligible for the fairness guarantee, or not?** A real, open policy
   question (Section 5) — not resolved here, and not something either session should decide silently.
3. **Should `classifyExclusionReason()`'s `INFINITE_SCORE` branch be made reachable** (i.e., should
   `scoreBroadUniverseChallenger()` actually exclude non-finite-but-not-NaN scores)? A real,
   deliberately-unfixed finding, now proven end-to-end rather than only unit-tested in isolation.
4. **Applying the starvation taxonomy to the 191-symbol population** (how many are
   `LOW_PRIORITY_CORRECTLY_EXCLUDED` vs. genuine starvation vs. intermittent eligibility) is the
   highest-leverage next step this report did not reach.
5. **The scheduler replay** remains correctly deferred — both preconditions (zero-score visibility,
   aging-state observability) are now met, and functioning (the TDZ fix was required for the first
   one to actually be true, not just claimed).
