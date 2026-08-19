# Argus consensus forensics

Exact current math. Numbers from `config/tradingSafety.json` and `config/agentWeights.json` unless a DB weight override exists.

**CODE-VERIFIED** — `EvidenceAggregator.ts`, `ChiefTraderAgent.ts`. **TEST-VERIFIED** — `EvidenceAggregator.test.ts`, `ChiefTraderAgent.test.ts` (inspect those files for fixtures; expected values must come from the same JSON production loads).

---

## Thresholds (config, not TypeScript literals)

| Knob | Production value (2026-08-18 file) | Meaning |
|---|---|---|
| `consensusApprovalThreshold` | 0.75 | Weighted confidence must **strictly exceed** (`<=` fails) |
| `minIndependentAgreeingAgents` | 2 | Unique agents on winning side, **excluding** `ConsensusDebate` |
| `disagreementPenalty` | 0.5 | Multiplier on disagreeing confidence×weight subtracted from numerator |
| `debateTriggerConfidence` | 0.6 | Triggers `routeConsensus` when an idea is that confident |
| `debateResultConfidence` | 0.8 | Debate vote confidence if ≥2 providers succeed |
| `debateSingleModelConfidencePenalty` | 0.7 | 0.8×0.7 if only one provider |
| `consensusDebateCooldownMs` | 60000 | Per-symbol debate cooldown |
| `consensusEvalMinIntervalMs` | 5000 | Skip re-eval on same-agent replace |
| `chiefTraderIdeaTtlMs` | 60000 | In-memory idea TTL |

Default weights:

| Agent | Weight |
|---|---|
| TechnicalAgent | 0.25 |
| FundamentalAgent | 0.20 |
| MacroAgent | 0.15 |
| NewsAgent | 0.25 |
| QuantEngine | 0.15 |
| KronosEngine | 0.20 |
| ConsensusDebate | 0.35 (`consensusDebateWeight`) |
| Unlisted | 1.0 |

`riskExitAgent`: PortfolioManager. `consensusHardVetoAgents`: NewsAgent, ConsensusDebate.

News ideas default **off**, so NewsAgent often **does not vote** even though its default weight is 0.25.

---

## Algorithm

1. Collect `recentIdeas` for symbol; drop expired.
2. If any `PortfolioManager` risk-exit idea: **approve SELL** with that idea’s confidence. Skip debate, skip min-2, skip threshold.
3. Else `calibrateConfidence(agent, raw)` from `agent_confidence_calibration` or raw.
4. Attach `weight = agentWeights[agent] || special`.
5. `coalesceEvidenceByAgent` — **last row per agent wins**.
6. `EvidenceAggregator.aggregate`:
   - For testSide in {BUY, SELL}:
     - agreeing = side === testSide
     - directionalDisagreeing = other of BUY/SELL
     - holdPenalties = HOLD with confidence > 0 **and** agent in hard-veto set
     - `net = sum(agree.conf*wt) - sum(disagree.conf*wt*0.5)` / `sum(all those weights)`
     - clamp 0–1
   - Winner = side with higher net (ties stay HOLD at 0)
7. HOLD confidence 0 (DATA_UNAVAILABLE) is **excluded** from the denominator (not a veto).
8. Non-veto HOLD (e.g. Fundamental caution) does **not** enter `holdPenalties`.
9. Approval iff not HOLD **and** confidence > 0.75 **and** independent agreeing ≥ 2 **and** not debate HOLD **and** not bear HOLD **and** not quant AI contradiction.
10. Persist `recordConsensusTransaction` **then** `emitChiefApproval` if approved. Else `DESK_NO_TRADE`. `CHIEF_CONSENSUS_COMPLETED` always.

BUY vs SELL compete directly. There is no separate SELL threshold.

---

## Worked example (fictional — not a database row)

Agents after coalesce + calibration:

| Agent | Side | conf | weight |
|---|---|---|---|
| TechnicalAgent | BUY | 0.80 | 0.25 |
| KronosEngine | BUY | 0.70 | 0.20 |
| MacroAgent | SELL | 0.60 | 0.15 |

BUY net = (0.80×0.25 + 0.70×0.20 − 0.60×0.15×0.5) / (0.25+0.20+0.15)  
= (0.20 + 0.14 − 0.045) / 0.60 = 0.295 / 0.60 = **0.4917**

SELL net = (0.60×0.15 − (0.80×0.25+0.70×0.20)×0.5) / 0.60  
= (0.09 − 0.17) / 0.60 = **0** (clamped)

Winner BUY 0.492 ≤ 0.75 → **NO TRADE** (below threshold). Independents agreeing on BUY = 2 (would have passed quorum if confidence cleared).

Add ConsensusDebate HOLD 0.80 wt 0.35 as veto: BUY disagreeing includes that HOLD; numerator drops further.

---

## SQL reconstruct

```sql
SELECT * FROM consensus_decisions WHERE transaction_id = 'ARG-…';
SELECT agent, side, confidence, weight, agreed FROM consensus_evidence WHERE transaction_id = 'ARG-…';
```

Recompute `netConfidenceFromVotes` using agreed rows as agreeing for `consensus_decisions.side` and the rest as disagreeing (including veto HOLDs). Calibrated values are already stored — do not re-apply calibration.

`agreements_count` is count of evidence with `side === decision side` (includes ConsensusDebate if it matches). Independent count for the gate **excludes** ConsensusDebate — do not use `agreements_count` alone.

Historical rows with `approved=1` and `agreements_count=1` predate current quorum enforcement — documented in repo forensic notes. **DOCUMENTED** contradiction vs today’s code.
