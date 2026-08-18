# Argus Consensus & Idea-Generation Runtime Forensic

**Scope:** read-only. No code, config, or trading state was changed to produce this report. All figures below are queried live from `data/argus.db` and `logs/argus-dev.log` / `data/logs/crash.log` on 2026-08-18 (query time ~20:31 UTC). Where a claim can't be backed by a row, a timestamp, or a line of code, it's marked **UNRESOLVED**, not asserted as fact.

**Bottom line up front:** Argus is not "safely rejecting bad trades." It is structurally unable to reach its own quorum. Two of five documented idea agents are silently dead (a live bug, not a rejection), one is off by design, and the two survivors (`TechnicalAgent`, `KronosEngine`) routinely disagree on direction — which the math below shows is enough by itself to keep `agreements_count` high and `weighted_confidence` low simultaneously. Zero approvals have been recorded in 5+ days of continuous evaluation.

---

## 1. Intended architecture

Per `CLAUDE.md` and `config/agentWeights.json`, five idea agents feed `ChiefTraderAgent`:

| Agent | Default weight | Data source |
|---|---|---|
| TechnicalAgent | 0.25 | Real RSI/MACD/Bollinger on tick data |
| NewsAgent | 0.25 | RSS + paid news APIs (+ optional LLM) |
| FundamentalAgent | 0.20 | AlphaVantage + AIRouter |
| KronosEngine | 0.20 | Local Chronos forecast |
| MacroAgent | 0.15 | AlphaVantage + AIRouter |

`ConsensusDebate` (weight 0.35) is not a sixth independent voice — it's a multi-model AI panel `ChiefTraderAgent` convenes itself when any single idea's confidence exceeds `debateTriggerConfidence` (0.6), and it's explicitly excluded from the independent-agreement count (`ChiefTraderAgent.ts:408-411`). It is also a **hard-veto agent** (`agentWeights.json.consensusHardVetoAgents: ["NewsAgent", "ConsensusDebate"]`): a HOLD-with-confidence>0 from either of these penalizes both BUY and SELL sides at once.

Approval requires **both**: `weighted_confidence ≥ 0.75` (`consensusApprovalThreshold`) **and** `≥ 2` independent agreeing agents (`minIndependentAgreeingAgents`), enforced at `ChiefTraderAgent.ts:411` (`uniqueIndependent.size >= MIN_INDEPENDENT_AGREEING_AGENTS`). This was designed assuming most or all of the five agents are live simultaneously — see §13.

## 2. Actual runtime architecture (right now)

| Agent | Alive? | Evidence |
|---|---|---|
| TechnicalAgent | **YES** | Last prediction 2026-08-18T20:30:22 (seconds ago at query time) |
| KronosEngine | **YES** | Last prediction 2026-08-18T20:24:58 |
| QuantEngine | **YES**, but N=1 | Off by default (`QUANT_ENGINE_ENABLED`); 1 prediction ever, today 14:08 |
| FundamentalAgent | **NO — dead** | Last prediction 2026-08-18T04:28:57. Silent 16h+ through a process that never restarted or crashed in that window (see §5/§6) |
| MacroAgent | **NO — dead** | Last prediction 2026-08-18T04:28:27. Same pattern |
| NewsAgent (idea path) | **NO — off by design** | Last TRADE_IDEA_GENERATED 2026-08-13T01:37:42 (5 days). Its clustering/news_veto path is separately alive: 513 `news_clusters` rows in the last 24h, most recent 2026-08-18T20:31:41 |

So of five documented idea agents, **exactly two are actually voting**: TechnicalAgent and KronosEngine.

## 3. Active agents

- **TechnicalAgent** — ~50,900 predictions in `agent_predictions` since 2026-08-10; `current_weight` 0.926 (learned, up from the 0.25 default via `ReflectionEngine`); ticking normally right now.
- **KronosEngine** — 77 predictions total; `current_weight` 0.987; ticking normally right now.
- **QuantEngine** — technically alive but effectively inert (1 prediction ever; only counts if `QUANT_ENGINE_ENABLED=true`, which is an operator opt-in, not default).

## 4. Inactive agents and reason for inactivity

### FundamentalAgent / MacroAgent — Q1, Q2, Q3 (partial), Q4, Q5

**What is proven by direct evidence:**

- Both agents ran normally for over a week (FundamentalAgent: 659 predictions 08-10→08-18; MacroAgent: 527 predictions, same window).
- At 2026-08-18T04:26:57–04:28:57Z, **both** hit an AlphaVantage rate-limit/budget exhaustion simultaneously (they share one AlphaVantage quota) and each emitted a `HOLD`/confidence-0 idea for all three watched symbols (AAPL/NVDA/TSLA) with reasoning `"DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted - real data resumes after a 24h cooldown."` — this is real, correct, honest behavior per `FundamentalAgent.ts:135-148`.
- **After that exact moment, zero further predictions from either agent — for 16+ hours, and counting**, despite:
  - `runtimeIntervals.json`: `fundamentalAgentMs=60000`, `macroAgentMs=75000` — should have fired ~960 / ~768 times since.
  - The code path taken (`data.peRatio === "RATE_LIMITED"`) unconditionally calls `eventBus.emitTradeIdea(...)` **every cycle**, rate-limited or not — `ReflectionEngine`'s always-on `eventBus.on('TRADE_IDEA_GENERATED', ...)` listener (`ReflectionEngine.ts:24`) persists every such event to `agent_predictions` regardless of confidence. So "still rate-limited" would still be producing rows. It isn't. **The interval itself has stopped firing, not just producing uninteresting output.**
- This 16-hour dead window sits entirely *inside* one continuous run: `kill_switch_events` shows no pause/stop/restart between 2026-08-18T04:09:05 (resume from EMERGENCY_STOP) and 13:06:44 (next pause, for an unrelated reconciliation mismatch), and `reconciliation_events` ticks cleanly on its normal ~5min cadence right through 04:11→04:25 with no gap — proving the process was up and other subsystems were healthy the whole time.
- `settings.pipeline_agent_enabled_json` is `'{}'` right now — meaning no Mission Control toggle has ever disabled these agents in this process's life (a toggle would have called `persistPipelineAgentEnabled()`, which writes *all six* agents' booleans, not an empty object). `isPipelineAgentEnabled('FundamentalAgent'|'MacroAgent')` therefore evaluates `true` right now, by code inspection (`pipelineAgentGate.ts`: empty map → `defaultEnabled()` → `true`).
- `data/logs/crash.log` has zero mentions of "AlphaVantage", "Fundamental", "Macro", or "rate limit" anywhere, ever, and no entries at all near 04:2x — so this did not go through the P0.6 `unhandledRejection`/`uncaughtException` path either.
- `pipelineAgentRuntime.ts`'s start/stop wiring treats `FundamentalAgent`/`MacroAgent` identically to `TechnicalAgent`/`KronosEngine` (same `runtimes` registry, same `isPipelineAgentEnabled()` gate, same `togglableIdeaAgentIds()` catalog membership — read in full, no special-casing found).

**Conclusion:** This is a genuine, reproducible-looking runtime bug: **the `setInterval` driving `analyzeFundamentals()`/`analyzeMacro()` died silently at the exact moment the rate-limit condition first triggered, without any corresponding log line, DB row, kill-switch event, or crash-log entry, in a process that otherwise never restarted.** The exact triggering line is **UNRESOLVED** — I cannot attach a debugger or add instrumentation without changing code, which is out of scope for this report. My leading hypothesis, unconfirmed: something in the first-ever real 429/budget-exhaustion transition inside `AlphaVantageBudget`/`ExternalDataCache` (shared by both agents, which explains why both died within 90 seconds of each other) threw or hung in a way neither agent's outer try/catch nor the global error handlers caught, silently orphaning the interval's closure. See §15 for a concrete, non-invasive next diagnostic step.

**Q4 (is AlphaVantage rate-limiting the only cause):** No — rate-limiting explains the *content* of the last real prediction, but the code is explicitly structured to keep emitting a HOLD every cycle while rate-limited (§ above). Rate-limiting cannot explain 16 hours of *zero* rows. Something else killed the timer at that moment.

**Q5 (why did the expected ongoing DATA_UNAVAILABLE HOLDs stop):** Because the interval stopped firing at all, not because the agents started suppressing the HOLD. Confirmed by the complete absence of new `agent_predictions` rows of any kind (not just non-HOLD ones) since 04:28.

### NewsAgent idea path — Q3 (main answer)

Distinct from Fundamental/Macro: this one is **explained and intentional**, not a bug. `config/deskIntelligence.json`: `"newsEmitsTradeIdeas": false`. `NewsEngine.ts:234`: `if (deskIntelligence.newsEmitsTradeIdeas && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('NewsAgent'))` gates the `emitTradeIdea` call — the clustering/sentiment/veto pipeline above that line runs regardless (confirmed alive: 513 fresh `news_clusters` rows in 24h). "News is a catalyst, not an independent BUY/SELL vote" (code comment, `NewsEngine.ts:231-233`) is current desk policy, tested (`deskIntelligence.test.ts` asserts this flag is `false`). NewsAgent's last real idea (2026-08-13) predates this being locked to `false`, or predates the quorum gate being enforced as strictly as it is now (see §12 for how that reconciles with old approvals).

## 5. Restart survival — Q6

**No evidence of restart-dependency was found, and the dead window is not restart-adjacent.** The 04:28 death sits inside a continuously-running process (see §4 timestamps). Separately, the *current* process booted at 2026-08-18T19:42:18 (from `logs/argus-dev.log`, PID 21920) — this is the 5th distinct `TRADING_ENABLED`/pause cycle of the day per `kill_switch_events` (listed in full in §6). TechnicalAgent and KronosEngine both resumed cleanly in this newest process (predictions minutes old). FundamentalAgent/MacroAgent have zero predictions in this newest process either — consistent with "still dead from earlier," not informative about whether a *fresh* boot would restart them cleanly, since code inspection says it should (`SystemBootstrap.start()` → `startEnabledIdeaAgents()` → uniform `applyAllIdeaAgentRuntimes()` loop, no per-agent skip logic found). **This specific sub-question (does a fresh, from-scratch boot restart these two correctly) is UNRESOLVED** — it would require an intentional restart, which is a state-changing action outside this report's read-only mandate.

## 6. Full state-transition timeline (today, from `kill_switch_events`)

| Time (UTC) | Transition | Actor | Reason |
|---|---|---|---|
| 02:06:37 | PAUSED → EMERGENCY_STOP | admin | Manual |
| 04:09:05 | EMERGENCY_STOP → ENABLED | admin | Operator resumed from banner |
| **04:26–04:28** | *(no state change — agents die mid-run)* | — | Fundamental/Macro's last predictions, then silence |
| 13:06:44 | ENABLED → PAUSED | system:PortfolioReconciliation | ~$403.20 mismatch vs Alpaca |
| 14:25:42 | PAUSED → PAUSED | gracefulShutdown | Process shutdown drain |
| 17:22:35 | PAUSED → ENABLED | admin | Reconciliation re-verified stable (7/7 clean cycles) |
| 19:29:15 | ENABLED → PAUSED | admin | Emergency stabilization: idea-loop firing 500+/min, 15k+ AI calls/min, crashing the process (the TechnicalAgent per-tick bug fixed earlier this session) |
| 19:30:46 | PAUSED → ENABLED | admin | Resumed via `POST /api/v1/system/resume` |
| 19:42:18 | *(process boot)* | — | Current live process, PID 21920 |

This confirms the runaway-loop crash and the Fundamental/Macro death are **two separate incidents**, ~15 hours apart, not the same root cause.

## 7. How many independent agents can realistically produce ideas right now — Q7

**Two.** TechnicalAgent and KronosEngine. (QuantEngine is a third if an operator explicitly sets `QUANT_ENGINE_ENABLED=true`, which is off by default and not currently set.) FundamentalAgent, MacroAgent, and NewsAgent's idea path contribute nothing right now, for three different reasons (dead / dead / off-by-design).

## 8. How ConsensusDebate is instantiated — Q8

Not a persistent process. `ChiefTraderAgent` calls `AIRouter.getInstance().routeConsensus("ConsensusDebate", debatePrompt, idea.traceId)` inline, synchronously as part of evaluating one idea, whenever that idea's own confidence exceeds `debateTriggerConfidence` (0.6). There is no standing "debate agent" — it's a per-idea AI panel call, fired again independently for every qualifying idea, including repeats of the same underlying signal on the same symbol.

## 9. How many AI providers actually participate — Q9

Checked `ai_calls` for `agent='ConsensusDebate'`, grouped by `trace_id` (one debate instance), last 20 debates: **19 of 20 used exactly 1 provider; 1 used 2** (both calls errored on that one). Configured/enabled providers today: `LiteLLM Gateway`, `Ollama (Local)` (healthy, 2194 requests, 96% success), `NVIDIA` (enabled but offline, 25% success). Gemini/OpenAI/Claude/Kimi/OpenRouter/Mistral are all `enabled: 0` in `ai_providers` right now. So in practice there's really only one consistently-healthy participant (Ollama/local), occasionally joined by a second.

## 10. Is "Based on 1 models" expected or a defect — Q10

**Both, depending on when.** `consensus_evidence.reasoning` for `ConsensusDebate` rows is overwhelmingly `"...Based on 1 models"`; a small minority say `"...Based on 2 models"` (confirmed one directly, transaction `ARG-2026-08-18-000078`, kronos-triggered debate on QQQ). Given §9's provider-health finding (5 of 8 providers disabled, 1 more offline-but-enabled), "1 model" is the **expected consequence of provider configuration**, not evidence of a broken fan-out mechanism — the fan-out code path is real (it did produce 2 on at least one call), it just rarely has more than one healthy target to fan out to. This is Category **D** (configuration mismatch) wearing the appearance of a code bug: the multi-model debate design assumes several enabled/healthy providers; today's `ai_providers` table has effectively one.

## 11. Repeated-HOLD accumulation within one idea TTL — Q11, Q12

**Confirmed, and far worse than "repeated HOLD accumulation" — this is the same bug pattern as the runaway-loop crash, expressed in the consensus ledger.** `consensus_evidence` rows attached to a single `transaction_id`:

| transaction_id | symbol | ConsensusDebate rows attached | Total evidence rows | Created |
|---|---|---|---|---|
| ARG-2026-08-18-000024 | QQQ | (subset of) | **3,536** | 18:24:24 |
| ARG-2026-08-18-000023 | QQQ | — | 2,153+1,053=3,206 (agreements+disagreements) | 18:14:53 |
| ARG-2026-08-18-000027 | QQQ | — | 2,197+991=3,188 | 19:10:44 |
| ARG-2026-08-18-000021 | SPY | — | 1,147+534=1,681 | 18:05:16 |

All four fall inside the 17:22:35→19:29:15 `TRADING_ENABLED` window — exactly the window the runaway per-tick TechnicalAgent bug was live and generating 500+ ideas/minute before it was patched (see §6, 19:29:15 entry). Every one of those runaway ideas that crossed `debateTriggerConfidence` (0.6) triggered its own `ConsensusDebate` call, and every debate result got appended as one more disagreeing (HOLD, hard-veto) row against the *same* `transaction_id`, because `evaluateConsensus()` accumulates evidence for a symbol across its whole `chiefTraderIdeaTtlMs` (60s) window without deduplicating repeat debates from the same underlying signal.

**Quantified effect (Q12):** for ARG-2026-08-18-000024, `weighted_confidence` settled at 0.458 against a 0.75 threshold, with `agreements_count=2405` vs `disagreements_count=1131`. The *raw* agreement count is enormous and would look like strong support if read naively — but each `ConsensusDebate` disagreement carries weight 0.35 and, being a hard-veto agent, also caps the opposing side. The sheer volume of repeated debate rows doesn't change the *ratio* much (both accumulate proportionally), but it does mean a single noisy tick storm can generate thousands of DB rows and thousands of real LLM calls for what is, semantically, one trade decision — a cost and data-integrity problem independent of whether the math itself is "safe."

## 12. Was the current config designed for 4+/5+/6+ active agents — Q13

**Yes, functionally.** `minIndependentAgreeingAgents=2` is a *minimum*, sized on the assumption that most of the five documented idea agents (Technical, News, Fundamental, Macro, Kronos) are online and can independently corroborate each other, with `ConsensusDebate` as a 6th, deliberately-excluded tiebreaker. Historical data supports this: the only `approved=1` rows in the entire `consensus_decisions` table (283 of them) are all dated **2026-08-13 or earlier**, all at a flat `weighted_confidence=0.7999999999999999` (the flat `debateResultConfidence`), with `agreements_count=1` — e.g. WEN, MSFT, TSM, APP, INTC, AMD, SPCX, GOOGM, NVDA, all BUY. Those rows predate `newsEmitsTradeIdeas` being locked to `false` and look like they predate strict enforcement of the 2-agent quorum (the code today would call an `agreements_count=1` approval a bug, per `ChiefTraderAgent.ts:411/422`; historically it apparently wasn't blocked). **Since 2026-08-13 — over 5 days, 864 total consensus evaluations, 581 of them the exact reasoning `"No consensus reached before the evaluation window closed"` — there have been zero approvals.** That is the single most important number in this report.

## 13. Is the current quorum of 2 appropriate under degraded-agent conditions — Q14

Not as currently degraded, no — but the fix is not "lower the number," per your explicit instruction. With only 2 real independent voices left (Technical, Kronos) and `minIndependentAgreeingAgents=2`, approval now requires those exact two to **agree on direction** — and live evidence shows they routinely don't (Technical BUY vs Kronos SELL on QQQ, confirmed directly in `consensus_evidence` for transaction 000078). A quorum of 2-out-of-2-available is brittle by construction: any single disagreement between the only two live voices makes approval structurally impossible, regardless of how good either signal is. That is not the gate protecting against a bad trade; it's the gate having nothing left to count. The appropriate fix is restoring real agent count (fixing §4's dead agents, revisiting the NewsAgent policy deliberately rather than as a side effect of a bug), not shrinking the threshold to fit the current outage.

## 14. Explicit instruction acknowledged — Q15

**Consensus thresholds (`0.75`) and quorum (`2`) were not touched, and this report does not recommend lowering them.** The recommendation is to restore the agent population the thresholds were designed against.

---

## Rejection classification (as requested)

| Pattern | Volume | Classification | Why |
|---|---|---|---|
| "No consensus reached before the evaluation window closed" (generic, all 581 non-approvals) | 581 / 864 (67%) | **B — STRUCTURAL NO-CONSENSUS** | Not a risk judgment. It's arithmetic: with 2 live voices that disagree, `weighted_confidence` cannot clear 0.75 and `uniqueIndependent.size` cannot clear 2 with disagreement present. The system isn't saying "this trade is bad" — it's saying "I don't have enough agreeing evidence," which is true, but for reasons unrelated to the trade's merit. |
| FundamentalAgent/MacroAgent total silence since 04:28 | 16h+ and counting | **C — DATA/AGENT AVAILABILITY FAILURE** | Confirmed dead interval, no gate, no config, no crash-log trace. A live bug removing 0.35 of documented agent weight from every evaluation. |
| NewsAgent idea-path silence since 08-13 | 5 days | **D — CONFIGURATION MISMATCH** (borderline **intentional**) | `newsEmitsTradeIdeas: false` is a deliberate desk-policy default, working as coded — but it silently removes another 0.25 of documented weight from a system whose quorum math (§12/§13) was sized assuming it contributes. Intentional at the config level, but its *consensus-math consequence* was very likely not re-derived when the flag was set. |
| Technical vs Kronos direction disagreement (e.g. QQQ, IWM) | Recurring, multiple symbols | **A — TRUE SAFETY REJECTION (partial)** | This part is real: two live, independent, data-grounded signals genuinely disagree on direction. Blocking on that disagreement is the RiskEngine/ChiefTrader doing exactly its job. This is the *only* piece of the current rejection pattern that reflects an actual trade-quality judgment. |
| Repeated ConsensusDebate HOLD pile-up during the 17:22–19:29 runaway window | 4 transactions, 1,681–3,536 evidence rows each | **C — DATA/AGENT AVAILABILITY FAILURE** (symptom of the already-fixed TechnicalAgent bug) | Not a safety judgment; a side effect of an idea-generation bug flooding the debate mechanism. Root cause already patched earlier this session; residual effect visible only in historical rows from that window. |
| "Based on 1 models" debate results | Majority of all debates | **D — CONFIGURATION MISMATCH** | 5 of 8 AI providers disabled, 1 more enabled-but-offline. The fan-out code works; it has almost nothing to fan out to. |

**Net honest answer to the framing question:** of the ~864 consensus evaluations on record, the overwhelming majority reduce to Categories B/C/D — the system failing to obtain corroborating evidence because most of its evidence sources are dead, off, or empty of eligible participants — not to Category A, genuine risk-based rejection. The one real Category-A signal (Technical/Kronos direction disagreement) is currently indistinguishable from the noise because it's evaluated inside the same starved quorum as everything else.

## Identified bugs (ranked)

1. **FundamentalAgent/MacroAgent interval death** — silent, no log/crash trace, root cause unresolved. Removes 0.35 combined documented weight from every consensus evaluation. (§4)
2. **ConsensusDebate evidence accumulates unbounded per transaction during idea storms** — up to 3,536 rows on one symbol in one evaluation window; a symptom of (already-fixed) unthrottled idea generation, but the accumulation-without-dedup design in `evaluateConsensus()` would let *any* future idea-storm bug repeat this. (§11)
3. **No liveness signal for idea-agent intervals** — `getPipelineAgentSnapshot()` reports configured `enabled` state only, not whether the underlying timer is actually ticking. This is *why* Fundamental/Macro's death went unnoticed for 16+ hours: nothing distinguishes "enabled and healthy" from "enabled and silently dead." (§15 recommends a fix.)

## Configuration mismatches

- `deskIntelligence.json.newsEmitsTradeIdeas=false` removes an entire documented, weighted agent from the live vote without any corresponding adjustment to `minIndependentAgreeingAgents` or the weight-normalization math — the quorum was sized for a roster this flag structurally shrinks.
- `ai_providers`: 5 of 8 rows `enabled: 0` (Gemini, OpenAI, Claude, Kimi, OpenRouter, Mistral), 1 more `enabled: 1` but `health: Offline` (NVIDIA) — `ConsensusDebate`'s "multi-model" design premise doesn't match the provider roster actually turned on.

## Intentional safety behavior (working as designed, not a defect)

- NewsAgent clustering/news_veto staying alive while its idea-emission is off (`keepsBackgroundPipeline: true` design) — confirmed both halves independently: veto data fresh (513 rows/24h), idea emission off (`newsEmitsTradeIdeas`).
- `ConsensusDebate` and `NewsAgent` as hard-veto agents penalizing both sides on a confident HOLD — this is why a single strong "don't trade" signal can suppress an otherwise-strong BUY, and it is working exactly as coded.
- Technical/Kronos direction disagreement blocking approval — see Category A above. This is the system's real safety value, currently starved of company.

## Recommended fixes (not implemented — reporting only, per instruction)

1. Diagnose §4's dead interval with a **non-invasive** first step: add a per-agent `lastTickAt` timestamp to `getPipelineAgentSnapshot()` (read-only addition, no trading-path change) so a future recurrence is visible within minutes instead of discovered forensically. Then, separately, add defensive logging around the `AlphaVantageBudget`/`ExternalDataCache` rate-limit transition path both agents share, since that's the prime suspect window.
2. Deduplicate `ConsensusDebate` evidence accumulation per underlying signal within a `transaction_id`/TTL window, so a future idea-generation anomaly can't repeat the 3,536-row pile-up regardless of its root cause.
3. Re-derive whether `minIndependentAgreeingAgents=2` and the weight normalization still make sense given `newsEmitsTradeIdeas=false` is a standing policy, not a temporary state — this is a math/design review, not a threshold reduction.
4. Once (1) is fixed and Fundamental/Macro are confirmed alive again, re-measure the rejection mix before concluding anything about "the market disagrees with Argus" — right now that conclusion is contaminated by two silently-dead agents.

## Risks of changing thresholds (why this report does not recommend it)

Lowering `consensusApprovalThreshold` or `minIndependentAgreeingAgents` right now would not fix the actual problem (missing independent evidence) — it would let the same 2-voice, frequently-disagreeing pair approve trades on materially weaker corroboration than the system was designed to require, at the exact moment three of its five evidence sources are unavailable for non-market reasons. That converts a data-availability failure into false trading confidence, which is a worse failure mode than the current one (idling).

---

*Prepared read-only against the live `data/argus.db`, `logs/argus-dev.log`, and `data/logs/crash.log` as of 2026-08-18T20:31Z. No trading state, configuration, or code was modified in the course of this investigation.*
