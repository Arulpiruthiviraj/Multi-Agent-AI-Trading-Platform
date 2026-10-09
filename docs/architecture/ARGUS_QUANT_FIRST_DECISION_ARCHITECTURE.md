# Argus Quant-First Decision Architecture

**Date:** 2026-10-07
**Status:** Implemented on feature branch `feat/quant-first-decision-architecture` (pending review/merge).
**Branch base:** main @ `5fede80`.

## 0. A note on where this document lives (doc-tension resolution)

Phase 35 of the mission asked for this design document. The repo's standing convention
(AGENTS.md) mandates a *single living architecture reference* —
`docs/architecture/ARGUS_ARCHITECTURE.md` — and forbids creating a new architecture doc for
every subsystem. Both instructions are honored: this document exists as the
**decision record and full design reference** for the Quant-First Decision Architecture
(the mission explicitly demanded a named deliverable), and the canonical summary section
lives in `ARGUS_ARCHITECTURE.md` itself (dated entry 2026-10-07, "Quant-First Decision
Architecture"), written in the same change. If the two ever disagree, the dated entry in
`ARGUS_ARCHITECTURE.md` is authoritative.

## 1. Problem and intent

Argus runs a multi-agent consensus (ChiefTrader, 0.75 approval bar, min 2 independent
agents) for every trading idea. That consensus is the right tool for *judgment-heavy*
ideas (news, macro, fundamentals). But a **validated, backtested, walk-forward-verified
quantitative strategy** whose trigger has fired on live data is not a judgment call — it
is a statistical edge with a pre-registered thesis, stop, and target. Routing it through
an LLM debate adds latency, cost, nondeterminism, and — most importantly — a dependency
on AI providers that can go down, take rate-limit cooldowns, or disagree for
non-statistical reasons.

The Quant-First Decision Architecture makes the ChiefTrader a **policy router** instead
of a consensus-only evaluator:

- Ideas tagged `origin: 'QUANT_STRATEGY'` from a **VALIDATED/CHAMPION** strategy are
  authorized centrally and evaluated by a deterministic `QuantExecutionPolicy` — **no LLM
  call, no AI dependency, no consensus debate**.
- Ideas that fail authorization (unvalidated strategy, retired strategy, non-producer
  agent, non-paper environment, forged/unknown origin) fall through to the **unchanged**
  consensus path or are terminally rejected with precise reason codes.
- **AI is never consulted for the quant path.** All AI providers down ⇒ validated quant
  still trades; an AI-originated idea under the same conditions fails closed.
- Everything downstream of the approval is unchanged: the approval is the same canonical
  `CHIEF_APPROVED_IDEA` event, consumed by the same RiskAgent → RiskEngine (26 gates) →
  PositionSizing → OMS → BrokerManager chain. There is no second order path.

## 2. The router (`ChiefTraderAgent.reviewIdea`)

One idea gets exactly one decision, by construction:

```
TradeIdea
  │
  ├─ risk exit? (agent === 'PortfolioManager' && side === 'SELL')
  │     → protective-exit path (unchanged, pre-existing; never needs strategy authorization)
  │
  ├─ normalizeTradeIdeaOrigin(idea.origin) === 'QUANT_STRATEGY'?
  │     → resolveQuantStrategyAuthorization(idea)
  │         ├─ AUTHORIZED_QUANT_POLICY → evaluateQuantExecutionPolicy(idea, auth)
  │         │     ├─ approved → canonical recordConsensusTransaction +
  │         │     │             eventBus.emitChiefApproval({..., decisionPolicy:'QUANT_EXECUTION',
  │         │     │             consensusConfidence:null})   ← same event the consensus path emits
  │         │     └─ rejected → DESK_NO_TRADE, terminalReasonCode 'QUANT_POLICY_REJECTED',
  │         │                   quantReasonCode = the precise policy reason.
  │         │                   NEVER silently re-routed to consensus.
  │         ├─ NOT_ELIGIBLE (retired/degraded/unknown strategy) → DESK_NO_TRADE,
  │         │     terminalReasonCode 'QUANT_NOT_AUTHORIZED'. Terminal.
  │         └─ REQUIRES_CONSENSUS (untested/shadow/candidate/…, non-producer agent,
  │               non-paper env, forged origin) → falls through to the UNCHANGED consensus
  │               intake (upsert + maybeEvaluateConsensus).
  │
  └─ any other origin → unchanged consensus intake.
```

Key properties:
- A quant-routed idea **never enters the consensus evidence pool** (`recentIdeas` stays
  empty for it) — no double-decision, no AI leakage into the quant path.
- A policy throw **fails closed** (`QUANT_POLICY_ERROR` → DESK_NO_TRADE), it never crashes
  the router into the consensus path.
- Approvals converge on the canonical `recordConsensusTransaction` + `emitChiefApproval`
  with `decisionPolicy='QUANT_EXECUTION'` and `consensusConfidence=null`, so the
  Transaction Observatory, forensics, and the replay suite see one approval shape with an
  explicit policy tag.
- The operator CONFIRM side-lock (existing) still withholds any approval whose side
  mismatches the confirmed side. The lock lives in memory only
  (`ChiefTraderAgent.manualSideExpectations`): a process restart drops all registered
  side-locks, and no lock is enforced again until the operator re-registers it. Persisting
  it is an explicit operator decision (low priority) - deliberately not built (C-F4,
  2026-10-08).

## 3. Provenance contract (`src/server/quant/tradeIdeaProvenance.ts`)

`origin` is **descriptive, never authoritative**. The enum:

`QUANT_STRATEGY | TECHNICAL | FORECAST | NEWS_EVENT | MACRO | FUNDAMENTAL | AI_RESEARCH |
PORTFOLIO_EXIT | FAST_OPPORTUNITY_LANE | EXPERIMENTAL | OTHER`

- `normalizeTradeIdeaOrigin()` maps unknown/missing/legacy values to `OTHER`, which
  always → consensus-required. A forged `origin: 'QUANT_VALIDATED'` is not a valid enum
  member and normalizes to `OTHER` — **spoofing the tag grants zero authority**.
- Authority comes only from the central resolver (Section 4), never from the tag.
- All 21 real `emitTradeIdea` producer files carry an explicit `origin` (Phase 3
  migration). The advisory Java-side services (`JavaCoreEnsembleVoteService`,
  `JavaFactorCompositeVoteService`, `QuantCoreJavaService`, `InstitutionalStrategyVoteService`)
  are tagged `QUANT_STRATEGY` *descriptively* but are NOT registered producer agents, so
  they stay on the consensus path — exactly the intended semantics: descriptive origin,
  authorization from the registry.

## 4. QuantStrategyAuthorization (`src/server/quant/QuantStrategyAuthorization.ts`)

Central, sole authority for "is this idea allowed the quant path". Returns
`AUTHORIZED_QUANT_POLICY | REQUIRES_CONSENSUS | NOT_ELIGIBLE` with a machine-readable
`reason` (e.g. `STRATEGY_VALIDATED`, `STRATEGY_UNTESTED`, `STRATEGY_RETIRED`,
`UNKNOWN_STRATEGY`, `NON_PRODUCER_AGENT`, `NON_PAPER_ENVIRONMENT`, `NON_QUANT_ORIGIN`).

Conjunctive requirements for `AUTHORIZED_QUANT_POLICY`:
1. `origin === 'QUANT_STRATEGY'` (after normalization).
2. **Paper-only environment lock**: `isPaperTradingOnlyEnforced()` must be true.
   Non-paper ⇒ `NON_PAPER_ENVIRONMENT` → consensus-required. (Defense in depth on top of
   the repo-wide `LIVE_NO_GO`.)
3. `idea.strategyId` resolves to a real strategy via `StrategyEngine.findStrategy`
   (strategy ids live in the registry/config — never TS literals).
4. `idea.agent` is a registered quant producer (`config/quantDecisionPolicy.json`
   `registeredProducerAgents`; today: only `QuantEngine`).
5. DB lifecycle status via `StrategyEmissionEligibility`: `VALIDATED` or `CHAMPION` ⇒
   authorized; `DEGRADED` or `RETIRED` ⇒ `NOT_ELIGIBLE` (terminal — never tradeable,
   never re-routed); `UNTESTED | SHADOW | CANDIDATE | ACTIVE_EXPLORATION | ROLLED_BACK`
   ⇒ `REQUIRES_CONSENSUS`.

The promotion ladder (`promotionEngine.ts`) remains research-informational; no third
lifecycle enum was introduced (deliberate — Phase 12 forbids new parallel truth).

## 5. QuantExecutionPolicy (`src/server/quant/QuantExecutionPolicy.ts`)

Deterministic, side-effect-free evaluation of an authorized idea. **Never calls an LLM,
never consults AI availability, never imports BrokerManager/OMS/RiskEngine/
ChiefTraderAgent/EventBus/AIRouter** (statically enforced by
`src/server/quant/quantFirstArchitecture.test.ts`). Java 26 Engine Authority honored:
every check reuses existing canonical functions — `ExpectedValue.riskRewardRatio`,
`ConfidenceCalibration` bucketing/sufficiency, the `StrategyEngine` regime predicate,
emitter-attached `internalEnsemble`/`dataQuality`. No new TS quant math was invented; a
check with no existing implementation is documented as a limitation, not invented.

**Required checks** (any failure ⇒ terminal reject with a precise `QUANT_*` reason):
authority must be `AUTHORIZED_QUANT_POLICY`; side present; numeric sanity (confidence in
[0,1], currentPrice > 0); `quantDetail.strategyEvaluation` present (an authorized idea
with no evaluation — e.g. a cold-start bootstrap idea — is rejected, never
auto-approved); evaluation.strategyId === idea.strategyId; evaluation.side ===
idea.side; `triggerMet === true` (reuses the repo's trigger-gate contract);
defined risk:reward (stop/target on the correct sides of entry); `dataQuality` not
blocked/degraded; evaluation not expired.

**Support** (≥ 2 of 4 independent dimensions): regime applicable · ensemble confluence ·
calibration sufficiency · R:R ≥ desk minimum (`config/quantDecisionPolicy.json`).
The bar is deliberately simple and auditable.

AI contradiction is **advisory only** (a note on the decision record, never a veto).
EV gating stays at emission (QuantSignalAgent's real live-win-rate check) — the policy
does not compute a second EV.

## 6. What did NOT change

- Consensus bar: `consensusApprovalThreshold` 0.75, `minIndependentAgreeingAgents` 2
  (`config/tradingSafety.json`) — untouched, still enforced by tests.
- RiskEngine: still 26 gates, still the sole risk authority; OMS still the sole
  `.placeOrder(` caller; `LIVE_NO_GO` / `PAPER_TRADING_ONLY` invariants hold.
- Legacy `QUANT_INDEPENDENT` consensus tier: kept as an explicit operator override
  (2026-09-09). It operates on a **disjoint idea set** (it can never see a
  validated-strategy idea — the router diverts those first), requires the full 0.75 bar
  plus vetoes. Removing it would change consensus-path behavior, which Phase 12 forbids.
  **Known pre-existing gap (flagged, not introduced, by the Phase 9 investigation):**
  `computeInternalEnsembleQualification()` consumes raw `evaluateAll()` output and never
  consults `StrategyEmissionEligibility`, so the tier can in principle qualify votes from
  UNTESTED/SHADOW/CANDIDATE — even RETIRED/DEGRADED — strategies. Fixing that would change
  consensus-path behavior (Phase 12) and override an explicit operator decision; it is
  recorded here as a known limitation for a future operator-directed change, not fixed in
  this mission.
- Risk exits (`PortfolioManager` + `SELL`) bypass the router — protective exits never
  need strategy authorization or LLMs.
- `CHIEF_APPROVED_IDEA` emitter allowlist unchanged; emission stays in
  `ChiefTraderAgent.ts`.
- DB migration `0096` is purely additive (nullable `decision_policy`, `idea_origin`,
  `strategy_id`, `strategy_lifecycle`, `authorization_reason` on `consensus_decisions`;
  historical rows are NULL).

## 7. Investigation findings (Phases 9/10/11)

Full write-up: `docs/audits/QUANT_FIRST_PHASE9_10_11_INVESTIGATION_2026-10-07.md`.

- **QUANT_INDEPENDENT tier** (above): legacy fallback, disjoint idea set, kept as-is.
- **Fast lane** (`FAST_OPPORTUNITY_LANE`): verified zero live ideas carry this origin
  today; it normalizes to `REQUIRES_CONSENSUS` permanently — the fast lane gets no quant
  authority. (No Phase-39 STOP: the lane is inert, not broken.)
- **Exit semantics**: exits are agent-tagged (`PortfolioManager`), not origin-tagged;
  the router keys risk exits on `(agent, side)`, so a mis-tagged exit can never be
  mis-routed into the quant policy.

## 8. Certification (Phase 17)

Design: all AI providers killed (`AIRouter.clearProviders()`), deterministic valid
scenario for an AUTHORIZED validated quant strategy, full path synthetic data →
QuantSignalAgent → trigger → ChiefTrader → authorization → QuantExecutionPolicy →
CHIEF_APPROVED_IDEA → RiskAgent → RiskEngine → PositionSizing → OMS → paper broker →
BUY fill → organic CLOSE_LONG → flat. AI-originated idea under the same conditions must
fail closed.

Result: **see `src/server/quant/AiOfflineQuantCertification.test.ts`** (SYNTHETIC_SEEDED /
CERTIFICATION_FIXTURE_ONLY throughout). The test file's header records the certified
assertions and any legs not covered.

## 9. Files

| Area | Files |
|---|---|
| Provenance | `src/server/quant/tradeIdeaProvenance.ts` |
| Authorization | `src/server/quant/QuantStrategyAuthorization.ts` |
| Policy | `src/server/quant/QuantExecutionPolicy.ts` |
| Config | `config/quantDecisionPolicy.json` |
| Router | `src/server/services/ChiefTraderAgent.ts` (reviewIdea) |
| RiskAgent passthrough | `src/server/services/RiskAgent.ts` (`decisionPolicy`, observability only) |
| Emit-site migration | 15 producer files (explicit `origin` on every `emitTradeIdea`) |
| Migration | `src/server/db/migrations/0096_*.sql` (additive, nullable) |
| Tests | `QuantStrategyAuthorization.test.ts` (17), `QuantExecutionPolicy.test.ts` (24), `quantFirstArchitecture.test.ts` (18 static-protection), `ChiefTraderAgent.router.test.ts` (7), `AiOfflineQuantCertification.test.ts` |
| Audit | `docs/audits/QUANT_FIRST_PHASE9_10_11_INVESTIGATION_2026-10-07.md` |

## 10. Known limitations

1. `QuantExecutionPolicy` rejects cold-start bootstrap ideas (no `strategyEvaluation`)
   — they continue through consensus. Deliberate: no-EV ideas don't get the AI-free lane.
2. The policy does not re-verify EV at decision time; EV gating is at emission
   (QuantSignalAgent's real live-win-rate check).
3. `hasAnyRoutableProvider()` is a snapshot; a provider could theoretically recover
   mid-decision — irrelevant, since the quant path never calls it.
4. Strategy ids and thresholds live in `config/quantDecisionPolicy.json`; tests derive
   expected values from the same config.
5. Seeded win-rate history in certification fixtures stands in for the real track
   record a VALIDATED strategy carries; labeled `CERTIFICATION_FIXTURE_ONLY`.
