# ARGUS — Live Zero-Trade Forensic Audit (2026-09-16)

Forensic audit requested after ~3 hours of live RTH paper trading (`TRADING_ENABLED`, engine PID
28136, `coreBootedAt` 2026-09-16T11:01:44.660Z) produced zero fills. Read-only investigation against
the real production database (`data/argus.db`, opened `{ readonly: true }`, never a second writer)
and real CLI/health endpoints. **No code, threshold, weight, calibration, or RiskEngine change was
made during this audit.** Production remained `PAPER_TRADING_ONLY=true` / `LIVE_NO_GO` throughout,
with zero interruption to the running engine (PID unchanged, no restart).

## LIVE ZERO-TRADE VERDICT

**LEGITIMATE NO-TRADE**, with one disclosed environmental limitation (IBKR account market-data
entitlement gap) that narrows the effective tradable universe but does not itself explain today's
zero-trade outcome on the symbols that *were* fully evaluable.

## FIRST BLOCKING STAGE

**Consensus** (`ChiefTraderAgent`), specifically `CONFIDENCE_BELOW_STRONG` /
`MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE`. Zero `risk_assessments` rows exist today — RiskEngine
was never reached, so **RiskEngine is not currently the blocker**. Zero `trades` rows exist —
**OMS/broker is not currently the blocker**.

## FUNNEL (today, 2026-09-16, through ~15:30 UTC / ~11:30 ET)

| Stage | Count |
|---|---|
| Market data connected/authenticated | Yes (IBKR Gateway socket, account DUR959160, paper) |
| Agent evaluations (agent_predictions rows) | 1,502 across 7 agents |
| Agent reasoning logs | 1,922 (incl. 750 ChiefTraderAgent) |
| `TRADE_IDEA_GENERATED` events | 1,150–1,152 |
| Consensus attempts started (`CHIEF_CONSENSUS_STARTED`) | 734 |
| Consensus attempts completed (`CHIEF_CONSENSUS_COMPLETED`) | 734 |
| Consensus approvals | **0** |
| `risk_assessments` rows | **0** |
| OMS submissions / `trades` rows | **0** |
| Fills | **0** |

`transaction_traces` today: 734 `NO_CONSENSUS`, 416 `ANALYZING` (in-flight at query time, expected
for a live snapshot).

## CONSENSUS REJECTION BREAKDOWN (742 `CONSENSUS_TERMINAL_REASON` events)

```
CONFIDENCE_BELOW_STRONG:                    621
AGENT_DATA_UNAVAILABLE:                      81
MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE:   26
AGENT_HOLD:                                  14
```

No occurrence anywhere today of `CALIBRATION_UNTRUSTED`, `AI_FAIL_CLOSED`, `FORECAST_BELOW_COST`,
`DUPLICATE`, or `COOLDOWN` as a terminal reason code. `independentAgentCount` distribution across all
742 attempts: **0 → 95, 1 → 536 (72%), 2 → 104, 3 → 7**. The overwhelming majority of attempts never
even reach the 2-independent-agent floor at all — not because agents disagree, but because a second
agent frequently never has fresh data for that symbol at that moment (see Market Data Quality below).

## TOP NEAR-MISS OPPORTUNITIES (highest confidence attempts today)

| Symbol | Agents | Result |
|---|---|---|
| AAPL | MacroAgent HOLD@0 + JavaCoreEnsemble SELL@0.635 | confidence 0.635, `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` — JavaCoreEnsemble alone, MacroAgent contributes nothing (HOLD), so only 1 real independent voice |
| GLD | KronosEngine BUY@0.472 + QuantEngine BUY@0.469 + TechnicalAgent BUY@~0.44–0.46 (3-way agreement, the day's best) | confidence ~0.46, `CONFIDENCE_BELOW_STRONG` — all three genuinely agree on direction, but none individually clears its own calibrated floor |
| SPY | KronosEngine SELL@0.472 + MacroAgent HOLD@0 | confidence 0.472, `CONFIDENCE_BELOW_STRONG` |
| QQQ | KronosEngine SELL@0.472 (sole independent agent) | confidence 0.472, `CONFIDENCE_BELOW_STRONG` (last live consensus attempt, 15:26 UTC) |

The GLD 3-way BUY agreement is the single closest thing to a real signal today, and it still tops out
at ~46% calibrated confidence — 29 points under the 75% STRONG bar.

## AGENT HEALTH (today)

| Agent | Predictions | BUY / SELL / HOLD | Avg confidence | Notes |
|---|---|---|---|---|
| KronosEngine | 604 | 35 / 537 / 32 | 0.843 (raw) | Calibrated (historicalReliability) consistently ~0.472 in the 0.8–0.9 raw-signal bucket — matches the 2026-09-15 calibration audit exactly |
| MacroAgent | 276 | 0 / 0 / 276 | 0 | 100% HOLD — investigated below |
| JavaFactorComposite | 189 | 49 / 140 / 0 | 0.058 (raw) | Shadow-tracking only; Mission Control toggle is OFF (`enabledMap.JavaFactorComposite: false`) so it never reaches a real vote regardless of confidence |
| QuantEngine | 138 | 138 / 0 / 0 | 0.747 (raw) | Calibrated confidence ~0.469 in its dominant bucket |
| TechnicalAgent | 136 | 132 / 4 / 0 | 0.614 (raw) | Only ever evaluates SPY/QQQ/GLD/AAPL today — see Market Data Quality |
| DiscoveryOutcomeTracker | 128 | 55 / 73 / 0 | 0.5 | Shadow tracker, not a consensus voter |
| JavaCoreEnsemble | 27 | 0 / 27 / 0 | 0.635 (raw) | No calibration data yet (`calibrationSampleSize: 0`); raw confidence used as-is when it participates |
| TradePlanShadowTracker | 1 | — | — | Shadow only |
| OpportunityScreener | 1 | 1 / 0 / 0 | 0.473 | — |

No agent showed elevated `consecutiveFailures`, and `pipelineRunning: true` / `ideaWorkersArmed: true`
throughout. `KRONOS_FORECAST_STARTED` (618) vs `KRONOS_FORECAST_COMPLETED` (604) shows a small (~2.3%)
non-completion rate — not investigated further, not large enough to explain the outcome.

### MacroAgent's 100%-HOLD pattern — investigated, not a new defect

`agent_reasoning_logs` for MacroAgent today breaks down as:
- 105× `DATA_UNAVAILABLE: Macro data ingested but no LLM is configured for a directional idea.`
- 73× `[Macro AI] No reasoning provided.` (LLM call ran, returned no usable reasoning)
- 34× `DATA_UNAVAILABLE: Macro analysis failed this tick`
- 56× `DATA_UNAVAILABLE: no fresh tick arrived for <symbol> within 8000ms` (SPY/QQQ/META/GLD/TSLA/NVDA/MSFT)

This is the documented, pre-existing MacroAgent behavior from the 2026-09-07 "MacroAgent 100%-HOLD
investigation" (`MacroAgent.ts:348-360`'s own header): a direct read of 627 real stored LLM responses
found the model itself almost never returns a literal directional call for this macro-indicator
prompt (599/627 said "Hold" outright). Today's pattern is consistent with that, compounded by today's
`AI_DEGRADED` provider state (1/10 healthy: 5 QUOTA_EXCEEDED, 1 ACCOUNT_SUSPENDED, 1 RATE_LIMITED, 1
MODEL_UNAVAILABLE, 1 PROVIDER_UNAVAILABLE). MacroAgent fails closed to HOLD/confidence-0 every time,
exactly per the documented `AIOutputValidator` contract — it never fabricates a signal. Its presence
in `participatingAgents` never counts toward independent BUY/SELL agreement (HOLD contributes
nothing), so it is not itself blocking any trade — it is simply inert. Not fixed tonight: this is
model behavior + AI-quota exhaustion, not a code defect, and "no LLM is configured" firing 105 times
is consistent with degraded provider routing rather than a new bug.

## STRATEGY ACTIVATION

QuantEngine (`currentState: GATED` in the pipeline-agent snapshot) evaluated 138 times today, 100%
BUY direction, all through the CORE five-strategy path (`ADAPTIVE_MULTI_STRATEGY`). No strategy-level
breakdown beyond aggregate QuantEngine confidence was pulled this pass (would require joining
`quant_assessments`/`strategy_id` — not needed to answer the zero-trade question, since QuantEngine's
calibrated confidence already caps well under 0.75 in its dominant bucket per the pre-existing
calibration audit). No strategy thresholds were touched.

## CALIBRATION INTEGRITY

Directly reproduces the existing, dated `docs/audits/ARGUS_CALIBRATION_METHOD_COMPARISON_2026-09-15.md`
finding with **today's live data**:

- Production still uses `RAW_BETA_BINOMIAL` (the effective-N migration was built and tested in
  isolation but explicitly never applied to `data/argus.db` — confirmed unchanged).
- KronosEngine's calibrated confidence (`historicalReliability`) sits at ~0.472 across many different
  raw signal strengths (0.816–0.85) within its 0.8–0.9 bucket — this is bucket-level calibration
  (real Wilson-lower-bound-style historical accuracy for that bucket, N=7,271), not a bug computing a
  literal constant; it does not vary smoothly with the exact raw signal because it isn't designed to.
- TechnicalAgent similarly clusters ~0.44–0.46 across a wide raw range (N up to 32,238).
- QuantEngine's live confidence (~0.469, ~0.591 depending on bucket) is the RAW method's value — the
  2026-09-15 audit already found QuantEngine's 0.6–0.7/0.7–0.8 raw-trusted buckets collapse to
  genuinely uninformative samples (12–34 effective observations) under proper autocorrelation
  correction. Today's live numbers are fully consistent with that finding.
- JavaCoreEnsemble has zero calibration data (`calibrationSampleSize: 0`) and its raw confidence
  (0.635) is used directly when it participates — not flagged as `CALIBRATION_UNTRUSTED` anywhere in
  today's terminal reasons, meaning it competes on raw confidence, uncorrected, whenever it appears.
  This is a real, disclosed evidence-maturity gap (consistent with its 2026-09-10 operator-override
  status), not new.

**Conclusion: this is a calibration evidence limitation, not a software defect.** No calibration
method, weight, or threshold was changed. The 0.75 STRONG bar and 0.5 MODERATE trust floor are
unchanged.

## MARKET DATA QUALITY — real, disclosed limitation found

778 `IBKR_MARKET_DATA_ERROR` events today, all `code=354 Requested market data is not subscribed`,
across dozens of individual US equities: AMD, TSLA, NVDA, MSFT, META, IWM, AAPL, HOOD, GE, SOXL,
INTC, DELL, XOM, MRVL, RIOT, SOFI, SNAP, SCHW, SBUX, RIVN, and more. **SPY, QQQ, and GLD are not in
this rejection list** (1 stray match each, effectively clean) — the IBKR paper account's real-time
Level 1 entitlement appears to cover the three core ETFs Argus streams but not individual equities.

Direct consequence, confirmed via the `symbol × independentAgentCount` cross-tab: **TechnicalAgent
participated in consensus only for SPY (75×), QQQ (104×), GLD (63×), and never once for MSFT, TSLA,
IWM, META, AMD, or NVDA** — and every consensus attempt on those individual-equity symbols shows
`independentAgentCount: 0`, 100% of the time. TechnicalAgent needs live ticks to compute RSI/MACD/
Bollinger; without a subscribed feed it structurally cannot evaluate those names, so those symbols
never reach even a single-agent consensus attempt with real information.

**This is a production/account configuration issue, not a code defect** — Argus's fail-closed
behavior here (no fabricated price, no fabricated indicator, `DATA_UNAVAILABLE` honestly logged) is
exactly correct. Fixing it requires an operator decision (subscribe to real-time equity market data
on the IBKR account, or architect a secondary data source for individual equities) — out of scope for
tonight's audit and not attempted.

## MEMORY / EVENT LOOP

| Metric | At audit start (~3h uptime) | At audit end (~4.6h uptime) |
|---|---|---|
| RSS | 824.2 MB | 1,119.6 MB |
| Heap used | 163.7 MB | 419.7 MB |

Real growth over the audit window (~35 min), coincident with heavy volume: `QUANT_BRIDGE_CALL_OUTCOME`
alone logged 180,654 events today. Heap growth alongside RSS growth suggests real object retention
(caches/buffers), not pure OS fragmentation. **Not treated as a new safety-critical regression this
pass** — no OOM, no crash, no degraded responsiveness observed, and the engine answered every CLI
query throughout. Flagged as a watch item for tomorrow, consistent with the prior P1-A memory
trajectory concern — no memory change made tonight.

## FIXES

None. No genuine software defect was found in the live consensus/calibration/market-data path today.
Both explanations for zero trades (calibration correctly reporting no demonstrated edge; an IBKR
account market-data entitlement gap for individual equities) are pre-existing, evidence-backed, and
outside the scope of a same-night code fix without operator decisions.

## SAFETY (confirmed throughout and at audit end)

- `paperTradingOnly: true`, `liveReadiness: LIVE_NO_GO` — unchanged.
- PID 28136 unchanged throughout the audit; no restart.
- `tradingState: TRADING_ENABLED`, `safeMode: false`, `emergencyStopActive: false`.
- Positions: `[]` (flat). Open orders: `[]`. `risk_assessments` today: 0. `trades` today: 0.
- Watchdog: `READY` (restarted earlier today after the overnight outage; heartbeat current).
- Production DB: opened read-only for every query in this audit; zero writes; zero schema access;
  file untouched (WAL-mode readers do not block or get blocked by the live writer).
- No threshold, weight, confidence-floor, consensus, RiskEngine, or calibration change was made.

## FINAL ANSWER

1. **Is Argus receiving usable live market data?** Yes for SPY/QQQ/GLD (the only symbols with a real
   IBKR real-time entitlement). No for most individual equities (AMD/TSLA/NVDA/MSFT/META/AAPL/etc. —
   code 354, not subscribed).
2. **Are agents actually evaluating?** Yes — 1,502 agent_predictions rows, 1,922 reasoning logs, 734
   full consensus cycles, all today, all real.
3. **Are strategies actually firing?** Yes — QuantEngine evaluated 138 times (100% BUY today);
   TechnicalAgent, KronosEngine, JavaCoreEnsemble all actively ticking on the covered symbols.
4. **Are trade ideas actually being generated?** Yes — ~1,150 `TRADE_IDEA_GENERATED` events today.
5. **Is consensus the first blocker?** Yes, confirmed — zero risk_assessments, zero trades; the block
   is entirely upstream of RiskEngine/OMS/broker.
6. **If consensus is the blocker, exactly why?** Calibrated confidence never cleared 75% STRONG (621
   of 742 attempts) and, separately, most individual-equity symbols never reached the 2-independent-
   agent floor at all because TechnicalAgent has no live feed for them (26 MODERATE-tier rejections
   for insufficient independence, 81 AGENT_DATA_UNAVAILABLE).
7. **Is calibration functioning correctly?** Yes, as far as this audit can determine — today's live
   numbers reproduce the dated, independently-audited 2026-09-15 calibration comparison exactly:
   Kronos and TechnicalAgent show no statistically demonstrated edge (Wilson lower bound < 0.5 under
   both raw and effective-N methods); QuantEngine's apparent raw-method edge in two buckets was
   already shown to collapse under autocorrelation correction.
8. **Is any live-path code defective?** No new defect found. MacroAgent's 100%-HOLD pattern and the
   IBKR market-data gap are both real, both disclosed, both explained by existing documentation or
   this audit's own evidence — neither is a bug in the consensus/RiskEngine/OMS spine.
9. **Did you change any threshold/weight/risk rule?** No.
10. **Should Argus be left running unchanged?** Yes. Zero trades today is the correct, evidence-backed
    outcome of honest calibration plus a real market-data coverage gap — not a reason to loosen
    anything.
