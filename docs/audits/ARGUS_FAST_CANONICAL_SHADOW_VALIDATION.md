# Argus — Fast Canonical Shadow Validation (2026-10-06)

**Mode:** shadow/research, implementation + integration testing. LIVE_NO_GO. No broker submission.
No `eventBus.emitTradeIdea()` call exists anywhere in this phase's code — see the companion design
doc (`ARGUS_FAST_CANONICAL_INTEGRATION.md` §10) for why that boundary was drawn deliberately.

**The central honesty constraint for this report:** the Fast Opportunity Lane did not exist on
2026-10-05. There is no real historical Fast-evaluation data for that date, for any symbol, because
the code that would have produced it was not running. Every row below that would ask "fast evidence
timestamp?" or "fast evidence available?" is `INSUFFICIENT_EVIDENCE` / N/A for that reason alone —
not because detection or evaluation failed, but because neither existed yet. This report does not
pretend otherwise. What it **does** report, honestly: whether *normal* evidence existed (real,
already-established facts from the prior reports in this series) and whether the *capability* now
built would have been reachable, by source-code reasoning, if it had existed that day.

## October 5 case study table

| Symbol | Normal evidence available? | Normal-path outcome | Fast evidence available (2026-10-05)? | Would a real Fast Lane candidate have been creatable? |
|---|---|---|---|---|
| MXL | No — never admitted; `RANK_CAP`-rejected, 0 cached bars | Never reached evaluation | **INSUFFICIENT_EVIDENCE** (Fast Lane did not exist) | No — zero real `NEWS_CATALYST` events for MXL that day either (re-confirmed, `ARGUS_FAST_EVALUATOR_OCT05_CASE_STUDY.md` §1); Fast Lane's only wired detection source (news) had nothing to fire on |
| SYNA | No — `RANK_CAP`/`ADV_DATA_UNAVAILABLE`-rejected, 0 cached bars | Never reached evaluation | **INSUFFICIENT_EVIDENCE** | No — same reason as MXL |
| WOLF | No — never admitted at all, no events of any kind | Never reached evaluation | **INSUFFICIENT_EVIDENCE** | No — confirmed zero contemporaneous evidence in any detection source Fast Lane currently has (news); this remains a discovery/source-coverage gap, not something Fast Lane's architecture could have closed |
| MPWR | Partial — 2 admissions, 0 challenger appearances | Never reached evaluation | **INSUFFICIENT_EVIDENCE** | No — same reason; zero real news catalysts that day |
| PTC | Yes — real 08:16 ET catalyst, 94 admissions, lost fairly at 14:37 | Reached challenger pool, lost to CHRW's real higher score | **INSUFFICIENT_EVIDENCE** for a literal historical replay | **Capability question answerable, deterministic-fixture-tested (not live Oct 5 PTC data):** `fastLaneEvaluator.test.ts`'s PTC control case proves the evaluator can correctly return `NO_VALID_SETUP` for a catalyst-driven candidate when no strategy triggers — a fast system can say NO quickly, structurally |
| XP | Yes — 59 quant assessments, 182 ideas, `agreements_count=1` | No approval (independence) | **INSUFFICIENT_EVIDENCE** | Not applicable to this question — XP's bottleneck was independence, not discovery speed |
| TSLA | Yes — 76 quant assessments, 169 ideas, `agreements_count=1` | No approval (independence) | **INSUFFICIENT_EVIDENCE** | Not applicable — same reason |
| META | Yes — 53 quant assessments, 127 ideas, `agreements_count=1` | No approval (independence) | **INSUFFICIENT_EVIDENCE** | Not applicable — same reason |
| NVDA | Yes — 61 quant assessments, 149 ideas | Reached promotion, no approval recorded as a benchmark focus | **INSUFFICIENT_EVIDENCE** | Not applicable |

No row was fabricated. Every "Normal evidence" cell is cited from the real, already-established
facts in the prior two reports in this series (`ARGUS_OCT05_REPLAY_AND_FASTLANE_VALIDATION_2026-10-06.md`,
`ARGUS_FAST_EVALUATOR_OCT05_CASE_STUDY.md`), re-verified, not re-guessed.

## TSLA / META / XP — key controls (§16)

October 5 showed many ideas but weak independent support for all three. **This phase's real,
tested finding directly answers the mandate's own question:** if Fast Lane evidence for one of
these symbols used the SAME underlying strategy computation as the normal QuantEngine path (which
it structurally does — §3 of the design doc), it would **not** have added a second independent
vote. `resolveIndependentEvidenceGroup()` collapses `FastOpportunityLane` into the same
`CORE_QUANT_ENSEMBLE` group as `QuantEngine`/`JavaCoreEnsemble`, proven against the real,
unmodified `ChiefTraderAgent` class. So for TSLA/META/XP specifically — where the real blocker
was single-source momentum evidence repeating, not discovery latency — Fast Lane evidence through
the same strategy family would have been **correctly treated as the same vote, not a new one**.
This is the mandate's own stated success criterion for "the architecture is correct": *"If it
merely produces earlier copies of the same momentum evidence... consensus should remain essentially
unchanged. That is a successful result."* This phase's test suite proves that outcome would hold,
without needing to run a live session to find out.

## Consensus evidence freshness audit (§18-19) — carried forward from the companion report

Not re-investigated to further depth in this pass. The companion report
(`ARGUS_OCT05_REPLAY_AND_FASTLANE_VALIDATION_2026-10-06.md` §Phase 25, cross-referencing
`ARGUS_FAST_EVALUATOR_OCT05_CASE_STUDY.md` §5) already found: `TechnicalAgent`'s confidence
genuinely varies between real rounds, while `ChiefTraderAgent`'s own aggregate repeats an identical
17-digit float across multiple TSLA/META timestamps — evidence consistent with stale-evidence
re-scoring, not fully traced to its root cause. Tracing `UNIQUE_EVIDENCE_UPDATES` vs
`CONSENSUS_ROUNDS` as a permanent, separate observability metric (§18's explicit ask) was not
implemented in this pass — a real, concrete candidate for the next phase, distinct from the Fast
Lane work this phase focused on.

## Event-driven consensus re-computation audit (§19) — not performed

Measuring "rounds with identical evidence fingerprint set" vs "rounds with at least one new
evidence item" at the ChiefTrader level (as opposed to this phase's own evidence-fingerprinting,
which only covers Fast Lane's own evidence) would require instrumenting `ChiefTraderAgent.ts`
itself — out of scope for a phase whose mission was the Fast Lane adapter, not a ChiefTrader
internals audit. Flagged, not executed.

## Latency benefit (§23) — not measurable without a live session

`candidate_detected_at` / `data_ready_at` / `evaluation_started_at` / `evaluation_completed_at` are
all real fields already produced by `fastLaneEvaluator.ts`'s observability events
(`FAST_OPPORTUNITY_DETECTED`, `FAST_EVALUATION_STARTED`, `FAST_EVALUATION_DATA_READY`,
`FAST_EVALUATION_VALID_EVIDENCE`/`FAST_EVALUATION_NO_SETUP`) — the instrumentation exists. No live
market-hours session has run with Fast Lane's event injector actually subscribed to real
`NEWS_CATALYST` events yet (the engine was running overnight/pre-market during this work), so no
real `normal_first_valid_evidence_at` vs `fast_first_valid_evidence_at` delta can be honestly
reported. This is the single biggest remaining gap before a promotion decision, and it is a data
gap, not a code gap — the next real trading session is the right environment to measure it, exactly
as the mandate's own §25 and closing framing describe.

## RiskEngine shadow handoff (§20) — result

**Correctly stopped at the ChiefTrader-approval boundary**, per the mandate's own explicit
fallback. See design doc §8 for the full reasoning: `ChiefTraderAgent`'s constructor subscribes to
the live, shared `eventBus`, so no safe "shadow" instance can be created in the running process;
the only safe test harness (full mocking) produces no real approval to hand to RiskEngine. This is
not a RiskEngine limitation — RiskEngine's own singleton has a private, side-effect-free
constructor and was never the blocker.

## Final questions

1. **Can valid FastEvaluationResult now enter the canonical idea pathway?** It can be *converted*
   into the canonical shape (`fastCanonicalAdapter.ts`); it is not *emitted* into it in this phase.
2. **Does it use the exact existing TradeIdea schema/path?** Yes — the same informal schema every
   other `emitTradeIdea()` caller uses (`traceId`/`symbol`/`side`/`confidence`/`agent`/`strategy`/
   `timeframe`/`evidence`), never a new one.
3. **Can it bypass ChiefTrader?** No — it cannot even *reach* ChiefTrader in this phase; emission is
   not wired.
4. **Can it bypass RiskEngine?** No — same reason, structurally unreachable this phase.
5. **Can it reach OMS/broker during this phase?** No — confirmed by architecture tests reading the
   real source of every file in `src/server/fastlane/`.
6. **Can duplicate Normal/Fast evidence double-count?** No — proven against the real,
   unmodified `ChiefTraderAgent` consensus math (§3).
7. **Can same-factor evidence masquerade as independent?** Not for the one real, verified case
   (QuantEngine/JavaCoreEnsemble/FastOpportunityLane sharing the CORE strategy ensemble
   computation). Cross-strategy factor correlation beyond that is honestly unclassified
   (`DIFFERENT_STRATEGY_UNKNOWN_CORRELATION`), not asserted either way without proof.
8. **Is Fast evidence freshness/TTL preserved?** Yes — `candidate.expiresAt` carried through as
   `evidence.validUntil`; an expired candidate is rejected before conversion.
9. **Are horizons preserved?** The raw timestamp data is preserved (`dataAsOf`, `validUntil`); no
   horizon-aware *consensus comparison logic* exists to consume it, because none existed before
   this phase either (design doc §5) and this phase did not invent one.
10. **How many unique Fast canonical ideas were produced in tests/case study?** In the deterministic
    test suite: exactly the number of distinct `(strategy, symbol, side, dataAsOf-minute)`
    combinations exercised (each idempotency test produces exactly 1 from 10 deliveries). In the
    real October 5 case study: zero — Fast Lane did not exist that day.
11. **How many were deduplicated against normal evidence?** None measured live (no live session
    run); the mechanism that would prevent double-counting is proven (§3/§6), not yet exercised
    against real concurrent Normal+Fast traffic.
12. **How many added genuinely independent evidence?** Zero measured live, same reason.
13-15. **Did TSLA/META/XP consensus improve for a legitimate reason?** Not applicable — no live
    Fast Lane evidence was ever produced for these symbols on any date. The *proven* finding is
    narrower and still valuable: if it had been, it would not have double-counted (§"TSLA/META/XP"
    above).
16. **Did any ChiefTrader approval appear in shadow research?** No — this phase's ChiefTrader tests
    used synthetic fixtures to prove the independence-grouping property, not a live or
    semi-live session.
17. **If yes, would RiskEngine accept it?** N/A — no approval was produced to test.
18. **How much earlier did valid evidence reach the canonical pipeline?** Not measurable without a
    live session (§Latency benefit above).
19. **What percentage of Fast evidence was merely duplicate information?** Not measurable without
    real Fast Lane traffic — no real Fast evidence has been produced outside unit tests yet.
20. **Is Fast Lane improving decision quality or just decision volume?** Unanswerable until a real
    forward session runs with live wiring — exactly the mandate's own stated next step, correctly
    not attempted here.

## Final verdict

**`FAST_CANONICAL_INTEGRATION_PARTIAL`.** The conversion/idempotency/independence-safety machinery
is real, built, and tested against the actual production consensus logic — not a mock of it. It has
not been exercised against real, live Fast Lane traffic, because live emission was deliberately not
wired in a process that was actively paper-trading during this work (design doc §10). The next
concrete step is exactly what the mandate itself proposes: a forward market session, with live
wiring added as its own separately-reviewed change, not a retroactive reconstruction of October 5.
