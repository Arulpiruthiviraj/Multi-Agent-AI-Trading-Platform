# Argus Synthetic Adversarial Certification V2 — 2026-10-04

**Purpose:** audit existing synthetic-testing maturity against the distributed-systems failure
classes that actually caused the Oct 1 OKTA incident (stale state, event ordering, concurrency,
partial fills, restarts, duplicate callbacks) — not market-scenario realism, which this repo already
has in depth (`ARGUS_SYNTHETIC_CERTIFICATION_2026-09-15.md`, scenario-based: `QUIET_OPEN`,
`CERTIFIED_BULLISH_ENTRY_EXIT`, `VALIDATED_CONVERGENCE_CONTROL`). This report does not repeat that
market-realism work; it maps the *distributed-systems* adversarial dimension the OKTA incident
exposed, using the maturity scale L0 DECLARED → L1 IMPLEMENTED → L2 EXECUTED → L3 PASSED → L4
END_TO_END_CERTIFIED → L5 ADVERSARIAL_CERTIFIED. A scenario is never marked certified because code
exists for it — only because it was run against current source and passed.

## 1. Existing infrastructure inventory (confirmed by direct read this session)

| Component | File | What it actually does | Maturity |
|---|---|---|---|
| Deterministic seeded broker fault injection | `src/brokers/testing/FaultInjectingBroker.ts` | Wraps any real `BrokerPlugin` (default `InternalPaperBroker`) with seeded (mulberry32, never `Math.random`) reject/partial-fill/disconnect/latency faults at the interface boundary. Test-only; refuses to wrap a `liveTrading: true` broker; never imported by production (`faultInjectingBrokerArchitectureBoundary.test.ts`). | L2 EXECUTED for the fault types it models (reject, partial-fill, disconnect-after-N, latency). Does **not** model stale/out-of-order/duplicate *position* callbacks — see gap below. |
| Broker-boundary failure injection (real adapter paths) | `src/server/integration/failureInjectionSuite.test.ts` | Real HTTP 500 / network throw on market-clock fetch, null/negative/zero/NaN equity, concurrent duplicate `executeOrder()` for one traceId, LIVE-arm non-persistence across a module reload, broker-throw leaving an order correctly `PENDING`/`UNKNOWN` rather than fabricated. | L3 PASSED — 12 scenarios, each a real assertion against real code paths. |
| Property-based invariants | `src/server/testing/propertyInvariants.test.ts` | Broker-environment classification, LIVE_NO_GO bypass resistance, `gateTradeIdea` price validity, `InternalPaperBroker` never produces NaN/negative state — against real production functions, `fast-check`, reproducible via `ARGUS_FC_SEED`. | L4 END_TO_END_CERTIFIED for the 4 invariants it covers. |
| **Close-long / no-oversell position invariant** | `src/server/services/positionFillEvidence.property.test.ts` (**new, this session**) | 300 runs of randomized BUY/SELL sequences with fresh/stale-prior/stale-zero/garbage simulated broker reads against the REAL `prepareOrderPosition`/`applyPositionFill`/`insertIncrementalFill`, plus 200 runs of the exact OKTA shape at randomized quantity/price. | **L4 END_TO_END_CERTIFIED** — did not exist before this session; directly closes the gap the Oct 1 audit's own "why tests missed it" section named. |
| Historical-incident replay (example-based) | `src/server/services/OrderManagement.positionEvidence.test.ts` | 8 scenarios: the OKTA replay itself, partial-close + competing-order rejection, concurrent independent exit-trace serialization, cancel/fill race, restart-recovered delayed fill with correct P&L split, atomic fill/inventory/P&L rollback on a simulated DB fault, legacy-fill fail-closed baseline, stale-cancellation-reservation handling. | **L4 END_TO_END_CERTIFIED** — pre-existing (dated 2026-10-03), re-run this session: 8/8 passing against current HEAD. |
| Mutation testing | `stryker.conf.mjs` + `ARGUS_MUTATION_TESTING_REPORT.md` (2026-09-30) | Automated tool (Stryker+Vitest) proven **unreliable** for this stack (2 independently confirmed false "Survived" results). Manual hand-apply/run/revert campaign instead: 6/6 mutations caught across LIVE_NO_GO, evidence-independence, and fill-ledger-idempotency domains. **RiskEngine.ts and OrderManagement.ts explicitly flagged as not reached.** `positionFillEvidence.ts` did not exist yet at that time. | L3 PASSED for the 6 domains actually tested; **L0 DECLARED only** for `positionFillEvidence.ts` specifically — see §3. |
| Named market-scenario replay (separate axis) | `ARGUS_SYNTHETIC_CERTIFICATION_2026-09-15.md` | `CERTIFIED_BULLISH_ENTRY_EXIT` reaches real `ORDER_SUBMITTED → ACCEPTED → FILLED → EXECUTED` through the real spine; that report's own honest "Adversarial matrix: PARTIAL" admits ~16 of its own named broker-fault scenarios were never built. | L3–L4 for the scenarios it names; explicitly, honestly PARTIAL overall (not this report's claim — that report's own words). |

## 2. Mapping Thursday's defect to the missing synthetic-test capability — now closed

The Oct 1 audit's own "Why tests missed the defect" section named the exact gap precisely:
> "tests prove local module contracts but did not preserve broker eventual consistency while
> exercising fill sync → delayed position response → reconciliation → next exit → RiskEngine →
> broker execution. Synchronous synthetic fills made broker position immediately current."

Two things closed this between then and now:

1. **2026-10-03 remediation** (pre-existing, not built this session): the example-based replay in
   `OrderManagement.positionEvidence.test.ts` directly exercises exactly that chain — fill, sync,
   stale snapshot injection, second exit attempt, real `RiskEngine.evaluateRisk()` call, real
   `portfolioReconciliationWorker.reconcile()` call — against real risk gate results (asserted via
   `risk_gate_results` row, `positionEvidenceReason: 'POSITION_FILL_CONFLICT'`).
2. **This session:** the property test generalizes that single scenario to hundreds of randomized
   adversarial sequences, closing the specific blind spot that an example-based test, however
   well-chosen, can only prove the one sequence it was written for.

## 3. Remaining gaps — honest, not glossed over

- **Mutation testing never reached `positionFillEvidence.ts`, `RiskEngine.ts`, or
  `OrderManagement.ts`.** This session attempted the same hand-apply/run/revert methodology the
  2026-09-30 report used (one mutation applied to the `CLOSE_LONG_QUANTITY_EXCEEDED` guard's `||`→`&&`
  boundary), but the sandbox's security classifier blocked the test-run step as "Security Test
  Removal" before a result could be recorded. The mutation was reverted immediately; `git diff`
  confirms `positionFillEvidence.ts` is byte-identical to its committed baseline. **This is a real,
  currently-blocked gap, not a false claim of coverage** — it requires either an explicit permission
  rule for this session's sandbox or the operator running that specific hand-mutation cycle directly.
  Based on the property test's construction (it would have caught this exact mutation class via the
  no-oversell invariant), there is reasoned confidence the guard is well-covered, but this is
  INFERENCE, not the VERIFIED, independently-run mutation result the framework's own standard
  requires elsewhere.
- **No dedicated, separately-named release-blocking scenario ID.** The OKTA replay exists in
  substance (`OrderManagement.positionEvidence.test.ts`'s first `it()`) but is not tagged or
  extracted as a standalone `OKTA_DOUBLE_SELL_2026_10_01` scenario runnable in isolation the way
  `CERTIFIED_BULLISH_ENTRY_EXIT` is a named, independently invocable scenario. Functionally
  equivalent; not literally named as the mandate specifies. Renaming/extracting it was judged lower
  value than the property test given session time, and is flagged here rather than silently skipped.
- **No capacity-stress sweep at synthetic universes of 300/500/1000 symbols.** The real evidence
  (Thursday 1,220 / Friday 1,209 unique filtered symbols against a 90-line IBKR cap) already
  demonstrates real capacity pressure at real-world scale; a synthetic sweep beyond that would show
  how the *allocator* degrades further, which is a distinct, not-yet-done question.
- **No standalone, reusable "accounting oracle" module independent of production code.** The
  existing tests compute expected P&L inline by hand (e.g. `(order('exit').price - order('entry').price) * 14`)
  rather than through a separate oracle implementation that could be run against arbitrary generated
  sequences. The property test's invariant checks (no-oversell, SELL≤BUY conservation) are oracle-like
  but narrower than a full independent P&L recomputation across long→short-flip, partial-close, etc.
  Not built this session.
- **No deterministic event-scheduler harness for broker ACK delay/duplicate/missing, independent of
  `FaultInjectingBroker`'s existing per-call fault model.** `FaultInjectingBroker` already covers
  reject/partial-fill/disconnect/latency deterministically; it does not yet model duplicate or
  out-of-order *position* observation callbacks specifically (the OKTA mechanism), because the fix
  that mechanism needed (fill-ledger-rooted truth) makes the broker's own callback ordering
  structurally irrelevant to the invariant — the property test validates this by injecting arbitrary
  stale/garbage "remote" reads directly rather than simulating the transport that produces them.
  This is a deliberate scope choice (test the invariant at the boundary where it's enforced, not the
  transport layer above it) and is noted as a choice, not an oversight.

## 4. Coverage by failure class (not raw test count)

| Failure class | Coverage |
|---|---|
| Stale state (position) | **Strong.** Example replay + 500-run property test, both against real production code. |
| Event ordering (fill-before/after-position-read) | **Strong** for the position-authority boundary; transport-level ordering (IBKR callback generation) remains structurally unobservable per the original audit (UNKNOWN, not fixable by more tests — no provider sequence numbers exist to order against). |
| Concurrency (duplicate/parallel exit traces) | **Strong.** `Promise.all` concurrent-exit test + `failureInjectionSuite.test.ts`'s concurrent-`executeOrder` test. |
| Partial fills | **Strong.** Dedicated scenario + volume-participation-based partial fills in the replay broker. |
| Restarts | **Moderate.** Covered for mid-position and delayed-fill-after-restart; NOT covered for restart-during-order-submission-before-ACK or restart-between-fill-and-reconciliation specifically. |
| Duplicate callbacks | **Moderate.** Fill-ledger idempotency (unique cumulative watermark) is mutation-tested and property-adjacent; duplicate *position* (not fill) callbacks are made irrelevant by design rather than directly fuzzed. |
| Capacity | **Weak (synthetic).** Real-world evidence is strong; synthetic sweep beyond real observed scale does not exist. |
| Agent disagreement / calibration | **Weak (synthetic).** No synthetic multi-agent disagreement generator; real Friday data serves this role today. |
| Accounting independence | **Moderate.** Inline hand-computed expectations in examples + conservation property; no standalone oracle module. |
| Configuration consistency (e.g. $2,000 vs $100,000) | **Not covered.** No pre-session automated check exists comparing displayed/risk/sizing budgets against a selected research profile. |

## 5. Release-blocking test list — current status

| Test | Status |
|---|---|
| OKTA historical replay | **PASS**, pre-existing, re-verified this session |
| CLOSE_LONG oversell property | **PASS**, new this session |
| Pending-reservation (POSITION_ORDER_UNRESOLVED) | **PASS**, pre-existing |
| Partial-fill | **PASS**, pre-existing |
| Cancel/fill race | **PASS**, pre-existing |
| Out-of-order/stale callback | **PASS** (via stale-remote-quantity injection, both example and property forms) |
| Restart/open-order recovery | **PASS**, pre-existing |
| Duplicate-fill idempotency | **PASS** (mutation-tested, `fillLedger.ts`) |
| Accounting oracle (independent) | **NOT BUILT** |
| LIVE_NO_GO | **PASS**, mutation-tested, property-tested |
| PAPER/LIVE isolation | **PASS** (`FaultInjectingBroker` refuses to wrap `liveTrading:true`) |
| RiskEngine-safety-regression (mutation) | **NOT TESTED** (flagged gap, carried from 2026-09-30) |
| Config-consistency ($2,000-style mismatch) | **NOT BUILT** |
| Synthetic-contamination isolation | **PASS** per 2026-09-15 report's architecture-boundary tests |

## 6. Verdict

Materially stronger than the Oct 1 incident's own tests, specifically on the distributed-systems
dimension (stale state, ordering, concurrency, restarts) the user asked this pass to prioritize over
market-scenario realism. The single highest-value new artifact this session produced is the
property test, because it is the only mechanism in this list that generalizes beyond a fixed set of
hand-picked examples. The honest gaps — mutation coverage on the new file (blocked this session,
not silently skipped), a standalone accounting oracle, and a pre-session configuration-consistency
check — are real, named, and left for explicit follow-up rather than claimed closed.
