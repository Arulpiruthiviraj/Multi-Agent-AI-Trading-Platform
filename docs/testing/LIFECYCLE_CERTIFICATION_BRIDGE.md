# Lifecycle Certification Bridge — operator & design document

**Date:** 2026-10-09 · **Module:** `src/server/lifecycle/certificationBridge.ts` · **Tests:** `src/server/lifecycle/certificationBridge.test.ts` (10/10 green, isolated temp DB)

## The missing link, stated precisely

The Oct-9 forensic found **755 NO_LIFECYCLE_RECORD** authorization events and **0 privileged
PAPER Quant strategies**. The Layer-3 probe
(`src/server/certification/productionStateCertification.test.ts`) confirmed the root cause
statically: **LIFECYCLE_PROMOTION_ROUTE=ABSENT** — no production code path ever recorded a
`VALIDATED`/`CHAMPION` lifecycle decision into `learning_versions`, even though the research
side (`promotionEngine.deriveLifecycleStatus()`) could derive a research-vocabulary VALIDATED
from evidence.

The full chain, traced read-only:

```
research evidence (quant_strategy_backtests, research runs, organic paper fills)
  -> evidence accumulation (StrategyEvidence booleans, coreRobustness gates)
  -> promotionEngine.deriveLifecycleStatus()     [research-side vocabulary; read-only reports only]
  -> ???                                        [ABSENT: no operator/review decision point existed]
  -> recordStrategyLifecycleTransition()        [existed; only RETIRED/ROLLED_BACK had production callers]
  -> strategyEligibility (getStrategyLifecycleStatus)  [existed]
  -> QuantStrategyAuthorization                 [existed; VALIDATED/CHAMPION record => AUTHORIZED_QUANT_POLICY]
  -> QuantExecutionPolicy                       [existed]
```

This bridge IS the `???` link. It is a **workflow design**, not a promotion: nothing in it
promotes a strategy on its own, seeds authority, or lowers a threshold.

## The workflow

```
evaluateCertification(strategyId, evidence, samples, provenance)
        |  pure: reads config thresholds, returns an assessment; CANNOT write
        v
applyOperatorReview(assessment, { reviewer, decidedAt, statement, targetStatus })
        |  runtime-validated; mints the branded ReviewedCertification;
        |  throws on missing/invalid review or target/evidence mismatch
        v
executeCertificationTransition(reviewed)
        |  re-validates the brand + review, checks current status,
        |  then calls the EXISTING recordStrategyLifecycleTransition()
        v
learning_versions row with the full audit payload (see below)
```

### 1. Evidence assessment (`evaluateCertification`) — pure, no writes

Inputs: the canonical `StrategyEvidence` (research-side booleans), explicit
`CertificationSamples` (closed-trade counts, walk-forward window count), and
`CertificationProvenance` (evidence IDs, scope, build version). The operator assembles
these from research artifacts; the bridge trusts no derived label and re-checks every gate.

**Quarantine gates** (mirror `promotionEngine`'s own guards): canonical `NEXT_BAR_OPEN`
execution model, `GREEN` evidence quality, physical parquet bytes on disk, `REAL_MARKET_DATA`
provenance, no engine mismatch, no theoretical zero-cost.

**Sample-sufficiency gates** — a "pass" on too few samples counts as a FAIL. Minimums come
from `config/researchSafety.json`, never hardcoded:
- backtest and OOS: `minOosTrades` (30) closed trades each
- walk-forward: `minWalkForwardWindows` (3) windows
- paper: `minPaperTrades` (30), `minPaperSessions` (10), `minPaperCalendarDays` (30),
  `minPaperProfitFactor` (1.2), positive expectancy, drawdown within limit, organic only

**Ladder** (highest rung whose every gate holds):
| Evidence | Eligible target | Authority after recording |
|---|---|---|
| Full set: quarantine + backtest + OOS + walk-forward + robustness(4) + organic paper | `VALIDATED` | `AUTHORIZED_QUANT_POLICY` (paper-only) |
| Research complete, paper accumulating | `ACTIVE_EXPLORATION` | `REQUIRES_CONSENSUS` — bounded monitored exposure via the normal intake, never AI-independent |
| Backtest + OOS | `CANDIDATE` | `REQUIRES_CONSENSUS` |
| Backtest only | `SHADOW` | `REQUIRES_CONSENSUS` |
| Nothing qualifies | `UNTESTED` (explicit baseline) | `REQUIRES_CONSENSUS` |
| Retired/degraded evidence, or unknown strategy | `NONE` — fail-closed, no transition permitted | n/a |

### 2. Operator review (`applyOperatorReview`) — the unskippable gate

Two halves, both tested:
- **Type-level:** `executeCertificationTransition()` accepts only the branded
  `ReviewedCertification`, which only `applyOperatorReview()` can mint.
- **Runtime:** the review must carry a real reviewer identity (min 2 chars), a valid
  `decidedAt` timestamp (not future beyond 5-min clock skew), and a real rationale
  (min 10 chars); `targetStatus` must **equal** the assessment's eligible target — the
  operator may not approve a status the evidence does not support. Execution re-validates
  the brand and every field (defense in depth against casts).

### 3. Execution (`executeCertificationTransition`) — the single write path

A static test asserts this module contains **exactly one** `recordStrategyLifecycleTransition`
call site, and that it lives inside this function. Before writing, execution refuses:
- unreviewed or forged input (`NOT_REVIEWED`)
- unknown strategyId (must resolve in the canonical registry)
- current `RETIRED`/`DEGRADED` status — reversal requires the existing explicit
  reinstatement path (`reinstateStrategyForEmission` → `ROLLED_BACK`), never this bridge
- `CHAMPION` from anything but a currently-`VALIDATED` strategy (CHAMPION is comparative:
  "proven current best", never a first-time qualification)
- any target outside the bridge's closed vocabulary — the research-side
  `LIVE_CANDIDATE`/`LIVE_APPROVED` statuses are **inexpressible** here, so LIVE authority
  cannot be produced by this workflow under any input

Every recorded transition carries the full audit payload in `learning_versions.evidenceJson`:
`strategyId`, `oldStatus`, `newStatus`, `evidenceIds`, `evidenceScope`, `sampleSize`,
`oosResult` (pass + trades), `walkForwardResult` (pass + windows), robustness and paper
gate outcomes, `gateFailures`, `reason`, `reviewer`, `reviewedAt`, `assessedAt`,
`executedAt`, `buildVersion`, and the bridge version.

## What the bridge does NOT do

- Never creates/promotes lifecycle rows in any production or real DB (tests use isolated
  temp DBs; the workflow has no production caller and no schedule — it runs when an
  operator deliberately invokes it).
- Never seeds `VALIDATED`/`CHAMPION` to make a test pass (the one VALIDATED row in the test
  suite is recorded **by the workflow under test** into the isolated DB).
- Never lowers any threshold; never touches LIVE paths; PAPER-only.
- No alpha/strategy changes: control-plane code only (same category as
  `QuantStrategyAuthorization`); no quant/indicator/strategy calculations — Java 26 Engine
  Authority is untouched.

## Vocabulary note (read before mapping labels)

`promotionEngine`'s `VALIDATED` ("paper + backtest + OOS + walk-forward + robustness") is a
**research-side derivation**; per `QuantStrategyAuthorization`'s header, "promotionEngine's
ladder stays research-side". This bridge's `VALIDATED` is the **runtime lifecycle decision**
the authorization layer reads. The bridge re-checks the research gates itself (never trusting
a derived label) and adds what the research side never had: sample-sufficiency enforcement
and the unskippable operator review. The two vocabularies agree on VALIDATED's meaning by
construction, but only the bridge's decision carries execution authority — and only after
a human signs it.

## Operator runbook (when the certification says QUANT_FIRST_OPERATIONALLY_INACTIVE)

1. Run `argus certify-next-session` (read-only snapshot) and read
   `MISSING_LIFECYCLE_ROWS` / per-strategy reasons.
2. For a strategy with real research evidence, assemble the certification package:
   `StrategyEvidence` from the research runs, sample counts, evidence IDs/scope/build.
3. Call `evaluateCertification(...)`; inspect `eligibleTarget` and the gate list. If the
   evidence does not qualify, **stop** — the answer is "not yet", not a weaker gate.
4. Record the operator review (`reviewer` = your identity, `decidedAt`, written `statement`,
   `targetStatus` = the assessed target) via `applyOperatorReview(...)`.
5. Execute via `executeCertificationTransition(...)`; verify the row in
   `learning_versions` history and re-run the certification.
6. A `RETIRED`/`DEGRADED` strategy (e.g. PULLBACK_CONTINUATION) is **not** a bridge
   candidate: reversal is a separate explicit decision (`reinstateStrategyForEmission`),
   and any re-qualification starts from the evidence again.

## Related

- `docs/architecture/ARGUS_ARCHITECTURE.md` § October 9, 2026: Lifecycle certification bridge
- `src/server/certification/productionStateCertification.ts` → `certificationBridge` field
  (the legitimate route surfaced in the pre-market certification output)
- Defect escape registry: `OCT9_PROMOTION_ROUTE_GAP`
