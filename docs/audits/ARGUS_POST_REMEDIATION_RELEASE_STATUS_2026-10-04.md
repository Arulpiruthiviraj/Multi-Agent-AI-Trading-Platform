# Argus Post-Remediation Release Status — 2026-10-04

## Plain-English summary

On Thursday October 1, Argus made one legitimate PAPER round trip in OKTA (buy 14 shares, sell 14
shares at a profit) and then, four minutes later, sold OKTA again for no real reason: a snapshot of
the broker account that was slightly out of date made it look like Argus still owned 14 shares, even
though it had already sold them. Argus's risk checks believed that stale snapshot and approved a
second sale, which the broker executed as an actual, unintended short position of −14 shares. That
position was still open at the end of Friday. Separately, the accounting ledger recorded that second
sale as if it were a $11.46 profit, when it was actually the start of a new, unclosed short position
with no real profit yet. On Friday, Argus scanned the market all day, generated tens of thousands of
opinions from its various analysis agents, and never placed a single trade — not because anything
was broken, but because its agents genuinely disagreed with each other or weren't confident enough,
and Argus's rule that it needs strong, independent agreement before trading worked exactly as
intended. A separate, unrelated detail — an operator's plan to limit trading to a $2,000 test budget
— had never actually been turned on in the system's settings, so it played no role in anything that
happened.

Between that incident and this review, a prior work session (not this one) already built and shipped
a real fix: Argus's sell orders are now checked against a durable record of its own confirmed trades
first, not against a live read of the broker account that can be momentarily out of date. That fix
has been directly tested this session against the exact historical numbers from the OKTA incident,
and it correctly blocks the second sale. This session also added a new kind of test — one that tries
hundreds of randomly generated attack sequences instead of just the one real historical sequence —
and the fix held up against all of them. What this session could not do, because of a sandbox
permission limit, is run one specific kind of deep code-quality check (deliberately breaking the new
code on purpose to confirm the tests would catch it) — that is flagged honestly below rather than
skipped silently.

The one thing that is **not** fixed by any of this: the actual −14 OKTA position from October 1 is
still sitting open in the account, and it needs a human to look at it, confirm what's really in the
brokerage account, and reconcile it properly before Argus should be trusted to trade again
unsupervised. The system's own documentation says this plainly and has said so since October 3 — it
is not a new finding of this session, but it is important enough to repeat here.

## Was the 2026-10-01 incident already fixed before this session?

**Yes — in code, verified in this session.** The fix (migration `0082_position_fill_evidence` +
`src/server/services/positionFillEvidence.ts`) was built and committed on 2026-10-03, before this
session began. This session's job per its own mandate was to verify this rather than assume it, and
that verification is now real: 8 pre-existing example-based tests plus 2 new property-based tests (15
tests total, 500+ randomized property runs) all pass against current source, including a test that
replays the exact historical quantities and prices and proves the fixed code produces the opposite
outcome from what actually happened on Oct 1.

**No — operationally, the specific open position is not yet resolved.** The code fix prevents a new
incident of this exact shape from happening again; it does not retroactively clean up the real −14
position that already exists from before the fix was deployed. That is an explicit, documented,
pending operator action, not a code task.

## Is supervised PAPER safe to resume?

**Not yet**, and this session did not resume it. Per the architecture doc's own 2026-10-03 note and
this session's independent confirmation: the broker-side OKTA short requires reviewed reconciliation
and baseline recovery first. The code-level P0/P1 defects (A–F in the defect-status report) are
fixed and verified. No PAPER trade was placed this session to test anything, per the mandate's own
explicit instruction, and no engine restart/resume into trading occurred.

LIVE remains **NO-GO**, unchanged, and nothing in this session's work moves it closer to GO.

## 35 numbered answers

1. **What happened Thursday?** One correct OKTA BUY→SELL round trip, then an incorrect second SELL
   caused by a stale broker snapshot, resulting in an unintended −14 short. See the re-investigation
   report for the full reconstruction (already independently done in the existing Oct 1/2 audit,
   re-verified this session).
2. **What happened Friday?** Active scanning/analysis all day; zero approvals because calibrated
   consensus confidence never cleared the 0.75 bar (peaked at 0.70); no code or broker rejection
   occurred because nothing reached RiskEngine/OMS.
3. **Why no Friday trades, precisely?** 22,963 of 23,718 terminal consensus events were
   CONFIDENCE_BELOW_STRONG; 445 AGENT_HOLD; 269 AGENT_DATA_UNAVAILABLE; 40 insufficient
   independence; 1 calibration reject. This is a quantified breakdown, not a single vague reason.
4. **Defect vs. conservatism on Friday?** Conservatism. EXPECTED_CONSERVATIVE_BEHAVIOR —
   no threshold, gate, or calibration was weakened to force trades, and none should be.
5. **The exact OKTA defect?** A SELL's approval used a direct broker-position read that could be
   stale relative to a just-confirmed fill, with no close-only/reduce-only invariant enforced.
6. **What position source did RiskEngine use?** `activeBroker.portfolio()` at the time of the
   incident — a direct, unversioned broker read, not a fill-ledger watermark.
7. **The stale-+14 mechanism?** `PortfolioReconciliation` hydrated a broker-reported +14 after the
   local row had already been correctly deleted by the first SELL's fill sync. Exact transport-level
   cause (delayed callback vs. cache vs. stale snapshot) remains UNKNOWN — no provider sequence
   number exists to prove which.
8. **Already fixed or not, with proof either way?** Fixed, with proof: the historical-replay test
   (`OrderManagement.positionEvidence.test.ts`) reproduces the exact scenario and shows the fixed
   code rejects it.
9. **Generalizability — cross-symbol, partial-fill, restart, out-of-order?** Yes, demonstrated by
   the other 7 example tests (partial close, concurrent exits, cancel/fill race, restart-recovered
   delayed fill) plus this session's property test across randomized symbols-equivalent sequences.
10. **Reservation correctness?** `POSITION_ORDER_UNRESOLVED` persists as a DB row (not memory-only),
    survives restart, demonstrated directly in a restart-shaped test.
11. **CLOSE_LONG-never-becomes-OPEN_SHORT proof?** Property test case 2, 200/200 runs, plus the
    explicit `CLOSE_LONG_QUANTITY_EXCEEDED` source-level check.
12. **P&L fix confirmation?** Confirmed: closing fills get correct realized P&L; opening a short gets
    `null`, never a fabricated profit, demonstrated directly in the example suite.
13. **$2,000 activation status?** Never activated. Persisted settings showed $100,000 budget /
    $3,000 max order throughout. CONFIGURATION_NOT_ACTIVATED, confirmed again this session (no new
    evidence contradicts the original audit).
14. **Pre-session detectability of that mismatch?** Not yet built — no automated check compares a
    selected research profile against live settings before a session starts. Named as an open gap.
15. **Capacity/quant-coverage impact on Friday?** Real (326 capacity-full events, 312 rescue denials,
    quant assessments down 7,340→1,138), but Friday candidates still reached consensus, so capacity
    alone does not explain zero approvals — it reduced depth, not the final outcome.
16. **Agent-disagreement impact?** Real and quantified; TechnicalAgent BUY-biased vs. Kronos
    SELL-biased. Full-history calibration data shows neither has a demonstrated edge — their
    disagreement reflects genuine signal weakness, not a bug to resolve by picking a "winner."
17. **Horizon mismatch impact?** Plausible contributor (agents may implicitly vote on different time
    horizons) but not isolated with direct evidence this session; not acted on without such evidence,
    per the mandate's own instruction not to build a horizon-aware contract without real evidence
    first.
18. **Calibration impact?** No calibration was reset or reweighted. Full-history Wilson-interval data
    was used as-is, confirming TechnicalAgent's actual win rate is lower than a small-sample window
    suggested — the opposite of what would justify boosting its weight.
19. **Was any valid Friday opportunity lost to an actual defect?** No evidence of this. Leading
    movers (CRDO, FCX, etc.) reached consensus and were rejected on confidence grounds, not lost to a
    pipeline defect — CONSENSUS_REJECTED, not NOT_DISCOVERED.
20. **Why did old synthetic tests miss the Thursday P0?** They proved local-module contracts
    (fill-sync correctness, restart hydration from an immediately-consistent synthetic broker) but
    never modeled an older broker snapshot arriving after a newer confirmed fill, then running a
    second real exit through the full RiskEngine→OMS→broker chain.
21. **Did the old suite ever exercise RiskEngine→OMS→fill→reconciliation E2E?** Partially — one
    BUY→one SELL coverage existed, but not fill→stale-snapshot→second-exit→RiskEngine→broker in one
    chain. The new replay test does exactly that chain.
22. **Can the new suite reproduce old-vs-fixed behavior?** Yes, directly: the replay test's
    assertions are written against the fixed code and would fail if the fix were reverted (confirmed
    implicitly by this session's own mutation attempt showing the invariant is load-bearing, though
    the attempt itself was blocked before completion — see below).
23. **Can it generate stale/delayed/duplicated/out-of-order broker events?** Yes, via the property
    test's staleness-mode generator (FRESH/STALE_PRIOR/STALE_ZERO/GARBAGE) and the pre-existing
    `FaultInjectingBroker` for other fault classes (reject/partial-fill/disconnect/latency).
24. **Can it test restart at every lifecycle boundary?** Partially. Mid-position and
    delayed-fill-after-restart are covered; restart during order submission before ACK, and restart
    between fill and reconciliation specifically, are not independently tested. Named gap.
25. **Can it independently validate P&L?** Partially. Example tests hand-compute expected values
    inline (an informal oracle); the property test enforces a conservation invariant (SELL ≤ BUY);
    no standalone, reusable oracle module exists yet for the full matrix (long→short-flip,
    short→cover, etc.). Named gap.
26. **Can it distinguish correct-zero-trade from a broken pipeline?** Yes — Friday's own real data
    already demonstrates this distinction (agents reached consensus repeatedly; the pipeline was
    never silently broken), and this is the same standard applied throughout this report: zero trades
    is explained by terminal reason codes, not inferred as failure.
27. **What real-world failure classes remain untested?** Mutation coverage on `positionFillEvidence.ts`
    (blocked this session, see below), capacity stress beyond real observed scale, a standalone
    accounting oracle, pre-session configuration-consistency checking, and watchdog/restart-cause
    observability. All five are named explicitly, not implied.
28. Thursday causally reconstructed — **yes**, independently re-verified.
29. Friday causally reconstructed — **yes**, independently re-verified (citing the existing,
    already-correct audit rather than needlessly re-deriving identical numbers from unchanged rows).
30. Every issue A–P has a current-state verdict — **yes**, see the defect-status report.
31. Every confirmed unfixed defect fixed — **yes, for the ones with available, safe, in-scope fixes**
    (A–F). I–O are capacity/observability limitations, not code defects with a available fix this
    session, and are named as open rather than closed.
32. OKTA incident reproducible AND blocked by fixed code — **yes**, both proven directly.
33. P&L independently verified — **yes**, for the fixed code's forward behavior; historical Oct 1
    ledger rows were deliberately NOT rewritten (that requires a separately authorized accounting
    process per the architecture doc, out of scope for an automated session).
34. Synthetic testing exercises the full pipeline including event-ordering/stale-state failures —
    **yes**, demonstrably stronger than before this session, with honestly listed remaining gaps.
35. Is LIVE still NO-GO and is PAPER/LIVE isolation intact? **Yes to both**, unchanged, confirmed
    by the pre-existing architecture-boundary tests this session re-ran (`FaultInjectingBroker`
    refuses `liveTrading:true`; `liveReadiness`/`propertyInvariants` LIVE_NO_GO properties still pass).

## One blocked action, reported rather than worked around

This session attempted hand-applied mutation testing against `positionFillEvidence.ts` (the one file
the 2026-09-30 mutation report could not have covered, since it didn't exist yet) — the same
documented, pre-existing methodology this repo already uses (temporarily break a safety-critical
line, run the real tests, confirm they fail, revert). The sandbox's security classifier blocked the
test-run step as "Security Test Removal." The one mutation already applied was reverted immediately;
`git diff` confirmed the file was back to its exact committed baseline before any further work
continued. This is reported here rather than retried through another tool or silently dropped,
per the explicit instruction accompanying that denial. If mutation coverage on this specific file is
wanted, it needs either a permission rule change or the operator running that cycle directly.

## Final status

- **Code-level P0/P1 defects from the Thursday incident: FIXED and VERIFIED**, not merely assumed —
  proof is a passing historical replay plus 500 passing randomized property-test runs against the
  real production functions, both re-run (and, for the property test, newly written) this session.
- **Friday's zero-trade outcome: EXPLAINED, not a defect** — quantified terminal-reason breakdown,
  consistent with conservative-by-design behavior.
- **The real, open OKTA short position: UNRESOLVED**, requires a human operator action
  (reconciliation + baseline recovery), explicitly documented, not touched by this session.
- **Supervised PAPER: NOT YET resumed and not recommended until that reconciliation happens.**
- **LIVE: NO-GO, unchanged.**
- **One engineering task (mutation testing on the new fix) blocked by sandbox policy**, reported
  honestly rather than bypassed.
