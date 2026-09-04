# Argus — ChiefTrader Calibration + Reliability Deep-Dive (2026-09-03)

Follow-up to `ARGUS_FULL_SYSTEM_AND_MARKET_AUDIT_2026-09-03.md`, investigating: (1) ChiefTrader score construction and whether the 0.75 gate is correctly calibrated, (2) a counterfactual analysis of independence-rejected rounds, (3) agent contribution/weight quality, (4) ETF concentration, (5) the Sept 3 admission collapse, and (6) memory growth — including a **third silent engine death that occurred live, during this investigation**.

Evidence labels: `[PROVEN-CODE]` `[PROVEN-DATABASE]` `[PROVEN-LIVE]` `[PROVEN-LOG]` `[INFERENCE]` `[UNVERIFIED]`.

**Corrected framing, adopted from review**: this report does not claim "ChiefTrader correctly declined to trade." It claims: *the dominant observed rejection point is ChiefTrader's 0.75 confidence gate; whether that gate is well-calibrated to distinguish bad setups from genuinely profitable ones is the subject of this investigation, and the findings below are mixed* — one real, structural gap was found (§2), one hypothesis was tested and refuted (§1), and one config-driven skew was confirmed (§4).

---

## 0. A live silent death occurred during this audit

`[PROVEN-DATABASE]` `[PROVEN-LOG]` At the start of this investigation, the engine (PID 23448, healthy at 16:38 UTC with `memoryRssMb: 3845.8`) was found unreachable. Forensics:

- `data/.argus_runtime_session.json`: `lastHeartbeatAt: "2026-09-03T17:20:13.322Z"`, `cleanShutdown: false`, `exitCode: null`.
- Last DB activity: `observability_events` max `ts` = `17:20:25.642Z`; `event_traces` max = `17:20:13.443Z`.
- `data/logs/crash.log`: **zero new entries** — the last entry remains the `unhandledRejection` from before today's fix (10:44:50Z).
- `tasklist` confirmed no `node.exe` process running at all.
- Windows **Application** and **System** event logs: **zero entries in the 13:10–13:35 ET window** (the exact death window, converted from UTC via confirmed `Eastern Time (US & Canada)`, currently EDT/UTC-4). No Application Error, no crash dump reference, nothing.
- Windows `Microsoft-Windows-Resource-Exhaustion-Detector/Operational` log: real "low on virtual memory" events **did** fire that day, but at 10:10–11:11 AM ET (14:10–15:11 UTC) — **over two hours before** the actual 17:20 UTC death, not contemporaneous with it.
- One coincidental, non-causal data point: a Norton 360 `SecurityCenter` status-update event at 13:22:38 ET (17:22:38 UTC), ~2 minutes after the last heartbeat.

**Conclusion**: `[UNVERIFIED]` root cause, same as the Sept 2 incident. This is now the **third** observed instance of this exact signature (zero Argus-side log, zero OS-side log) on this machine this week. The temporal gap between the last resource-exhaustion signal (2+ hours prior) and the actual death argues against a simple "OS killed it for memory" story, but does not rule out memory pressure building more gradually without re-triggering that specific detector. **This should now be treated as a recurring pattern, not a one-off** — it has happened on Sept 2 and twice-observed-adjacent today. The engine was restarted and trading resumed after this investigation; see the parent audit's Q24 answer (unattended-readiness) — this finding reinforces "NO."

---

## 1. ChiefTrader score construction (formula, read from source)

`[PROVEN-CODE]` `src/server/services/ChiefTraderAgent.ts` + `EvidenceAggregator.ts`:

- **Confidence is not raw LLM self-report.** Every agent's stated confidence passes through `calibrateConfidence()` (line 558), a real Beta-Binomial lookup against `agent_confidence_calibration` — a per-agent, per-confidence-bucket correction based on that agent's own historical accuracy at that exact confidence level. Falls back to the raw value only when zero real evaluated history exists for that bucket. **This directly answers one of the review's questions: yes, confidence calibration against historical outcomes already exists and runs on every round.**
- **Weight is separate from calibration.** `resolveWeight()` (line 492) returns `agent_performance_stats.currentWeight` — a flat, per-agent scalar updated by `ReflectionEngine` from real prediction outcomes (not touched by this investigation's code, but its *output* was inspected — see §3).
- **Aggregation formula** (`EvidenceAggregator.ts:58-67`):
  ```
  weightedConfidence = Σ(confidence_i × weight_i)  for agents agreeing with the winning side
                      − Σ(confidence_i × weight_i × 0.5)  for agents disagreeing (real DISAGREEMENT_PENALTY=0.5)
  finalConfidence = weightedConfidence / totalWeight    (clamped to [0,1])
  ```
- **Tested and refuted hypothesis**: I initially hypothesized that FundamentalAgent/MacroAgent's near-universal HOLD votes structurally drag down every round's confidence. **This is false**, confirmed by direct code reading: a plain HOLD (confidence > 0) from an agent **not** on `config/agentWeights.json`'s `consensusHardVetoAgents` list (currently `["NewsAgent", "ConsensusDebate"]` — Fundamental/Macro are **not** on it) enters **neither** the agreeing nor disagreeing set for either candidate side. It is excluded from the ratio entirely, not just discounted. **Fundamental/Macro's participation is mathematically neutral, not a drag.**
- **Real consequence of this formula**: when exactly one real directional agent votes on a symbol with no directional disagreement and no hard-veto HOLD, `weightedConfidence / totalWeight` reduces to that one agent's own calibrated confidence — the weight literally cancels out. This is the mechanism behind §2.

## 2. The independence-rejection counterfactual (the review's suspicion, confirmed)

`[PROVEN-DATABASE]` All 15 independence-rejected `transaction_traces` rows found across both days (query: `terminal_reason LIKE '%independent agent%'`) share one number: **`consensus_score: 0.7727272727272726`** — the identical value, to 16 significant digits, in every single row, regardless of symbol (QQQ ×12, AAPL ×2, plus one earlier) or nominal "contributing agents" list. Per §1's formula, this is not a coincidence: it is **QuantEngine's own calibrated confidence, reached alone**, every time `["...", "QuantEngine", "ChiefTraderAgent"]` (or similar) is the listed contributor set — any FundamentalAgent/MacroAgent HOLD entries in that list are mathematically inert per §1, and ChiefTraderAgent itself is the arbiter, not a voting agent.

**Confirmed, precisely, code-and-data-verified**: `enoughIndependentVoices` (line 644) is checked in a branch that is only reached *after* `result.confidence > CONSENSUS_APPROVAL_THRESHOLD` has already been established (line 661's `if` catches everything at-or-below 0.75 first; line 693's `else if (!enoughIndependentVoices)` only runs for what's left). **QuantEngine, alone, has cleared 0.75 fifteen separate times across two days and been rejected every single time solely for lack of a second independent directional agent voting the same side in the same aggregation window** — never once for the confidence itself being weak.

**A real, structural gap this reveals**: the MODERATE-tier mechanism (`isConsensusModerateTierEnabled()`, Phase 7E/7H) exists specifically to give a calibration-trust-gated second chance to setups that fall *short* of 0.75 — but it is nested entirely inside the confidence-shortfall branch (line 673) and is **never reached** by a setup that already cleared 0.75 but failed independence. There is currently no analogous "second look" mechanism for the strong-confidence/thin-independence case. This is worth calling out precisely as the review requested: **not evidence the independence rule is wrong, but evidence there is an asymmetry in how the two failure modes are handled** — one gets a nuanced fallback, the other gets a flat rejection.

**What this does *not* prove**: whether QuantEngine's lone signal *should* have been trusted. That requires knowing whether a second, genuinely independent agent's absence in that exact window reflects a real information gap (nothing else had a fresh opinion) or a timing/cadence mismatch (TechnicalAgent/Kronos evaluate on their own cooldowns that happened not to coincide). This investigation did not have time to trace each of the 15 rows' surrounding agent-reasoning-log timeline individually to distinguish these — flagged as the precise next step, not resolved here.

## 3. Agent contribution quality — a real anomaly found

`[PROVEN-DATABASE]` Current `agent_performance_stats`:

| Agent | Weight | Total predictions | Correct | Real accuracy |
|---|---:|---:|---:|---:|
| KronosEngine | 1.016 | 5,339 | 2,603 | 48.8% |
| JavaFactorComposite | 1.023 | 209 | 100 | 47.8% |
| TechnicalAgent | 0.981 | 55,581 | 24,447 | 44.0% |
| NewsAgent | 0.906 | 300 | 144 | 48.0% |
| OpportunityScreener | 0.909 | 345 | 179 | 51.9% |
| QuantEngine | 0.692 | 1,012 | 525 | 51.9% |
| PortfolioManager | 0.6 | 32 | 9 | 28.1% |
| **FundamentalAgent** | **0.2** | 52 | 30 | **57.7%** |
| **MacroAgent** | **0.1** | 150 | 0 | **0.0%** |
| DiagAgent | 0.1 | 3 | 0 | 0.0% |

**Two real anomalies**: MacroAgent's weight (0.1) matches its real 0% accuracy — internally consistent, and (per §1) mathematically inert anyway since it's not a hard-veto agent, so this low weight currently has **no operational effect** on rejections either way. **FundamentalAgent is the actual anomaly**: its weight (0.2, the second-lowest of any real agent) is *inconsistent* with its measured 57.7% accuracy — the **best** real accuracy of any agent in the table, yet weighted lower than agents with worse track records (KronosEngine 48.8%, TechnicalAgent 44.0%, both weighted ~1.0). `[UNVERIFIED]` whether this is a stale weight lagging a real recent improvement, a small-sample artifact (only 52 predictions), or a weight-update formula issue — not resolved in this pass, but a precise, real, worth-investigating discrepancy. **Since FundamentalAgent never votes directionally anyway (100% HOLD, per the prior audit), this discrepancy is currently inert in practice** — but would matter immediately if FundamentalAgent's AlphaVantage rate-limit constraint (the actual cause of its HOLD-only pattern) were ever resolved.

## 4. ETF concentration — confirmed by configuration, not inference

`[PROVEN-CODE]` `config/continuousIntelligence.json`: `coreStreamingSymbols` = `protectedSymbols` = **`["SPY", "QQQ", "GLD"]`**, exactly the three symbols dominating 92-96% of ChiefTrader activity on both days. `MarketDataWorker.ts`'s `requestTemporaryDataRescue()` grants these symbols unconditional, cost-free eviction immunity (line ~352: `if (protectedStreamingSet().has(ticker)) return { granted: true, ... }` — bypassing the entire rescue-budget/capacity logic that every other symbol competes for). **This means SPY/QQQ/GLD receive continuous, uninterrupted, all-day data flow, while every other symbol (including the full `seedSymbols` list: NVDA, AAPL, MSFT, TSLA, IWM, AMD, META) is subject to eviction and rescue-capacity competition and only receives bursts of coverage.** The practical consequence: agents that generate signals on a debounced/cooldown cadence (TechnicalAgent, QuantEngine) get vastly more chances per day to fire on a permanently-streamed symbol than on a dynamically-allocated one. **This is a deliberate design choice (protecting core benchmark symbols from eviction), not a bug — but it directly and provably explains the ETF concentration**, and is very likely a contributing factor to §2's independence-rejection pattern as well (fewer real evaluation windows for stock symbols means fewer chances for two independent agents to coincide on one).

## 5. Sept 3 admission collapse (141 → 40-50) — partially explained, not fully resolved

`[PROVEN-DATABASE]` Full-day filter-reason proportions differ meaningfully: Sept 2 (sampled): PRICE 82%, DOLLAR_VOLUME 16%. Sept 3 (full day, 7,576 rows): PRICE 67%, **DOLLAR_VOLUME 31%** — nearly double the proportional share. `[UNVERIFIED]` whether this reflects genuinely lower dollar-volume liquidity across the scanned universe today (a real market condition) or a change in what's being scanned — no external ground truth was available to distinguish these, consistent with the parent audit's own limitation. Admission count itself, re-queried over the full day (not just through the earlier audit's snapshot time), is 50 — higher than the 40 reported in the parent audit, since real-time admissions continued after that snapshot and through this investigation's own engine restart.

## 6. Priority-ordered findings (refined from the review's roadmap)

| Priority | Finding | Status |
|---|---|---|
| P0 | Third silent death, live-observed, OS-level forensics gathered (§0) | `[UNVERIFIED]` cause; now a confirmed recurring pattern, not a one-off |
| P0 | Independence-gate rejects the ONLY case where confidence structurally clears 0.75 alone, with no fallback mechanism (§2) | `[PROVEN-DATABASE]`+`[PROVEN-CODE]` — a real architectural asymmetry, not yet a proven "wrong rejection" |
| P1 | ETF concentration is config-driven (protected symbols), not a discovery/ranking defect (§4) | `[PROVEN-CODE]` — root cause identified precisely |
| P1 | FundamentalAgent's weight (0.2) is inconsistent with its real 57.7% accuracy (§3) | `[PROVEN-DATABASE]`, currently inert (agent doesn't vote directionally) but worth fixing before it matters |
| P1 | HOLD-vote-dilution hypothesis | **REFUTED** — corrected in this report, do not carry forward |
| P2 | Sept 3 admission-proportion shift toward DOLLAR_VOLUME filtering (§5) | `[UNVERIFIED]` cause; needs external ground truth to resolve |

**Unchanged from the prior audit and this review's own instruction**: `consensusApprovalThreshold` (0.75), `minIndependentAgreeingAgents` (2), all RiskEngine gates, liquidity/stale-data/price-validity gates — **none were touched, none are recommended for change** by this investigation. The independence-gate finding (§2) is a case for **designing a bounded, evidence-gated second-look mechanism analogous to the existing MODERATE tier** (a real engineering option, not a threshold change) — flagged as the next well-scoped design question, not implemented here.

---

## Evidence summary

```
PROVEN-CODE:   ChiefTrader's calibration/weight/aggregation formula (ChiefTraderAgent.ts,
               EvidenceAggregator.ts); consensusHardVetoAgents excludes Fundamental/Macro;
               coreStreamingSymbols/protectedSymbols = [SPY,QQQ,GLD]; independence-gate branch
               ordering (only reached after confidence already exceeds 0.75)

PROVEN-DATABASE: 15 independence-rejected rows, identical consensus_score to 16 significant
               digits; current agent_performance_stats weights/accuracy table; Sept 2 vs Sept 3
               discovery-filter proportions; the live death's exact heartbeat/DB timestamps

PROVEN-LOG:    Zero Argus crash.log entries and zero Windows Application/System log entries at
               the exact death window; real (but non-contemporaneous) resource-exhaustion events
               2+ hours prior

UNVERIFIED:    Root cause of the third silent death; whether the 15 independence-rejected
               QuantEngine-alone setups reflect a real information gap or a cadence-timing
               mismatch with other agents; cause of the DOLLAR_VOLUME filter-share increase
```
