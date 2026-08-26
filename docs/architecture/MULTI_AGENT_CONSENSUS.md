# Multi-Agent Consensus (ChiefTraderAgent)

Authoritative source: `CLAUDE.md` §1 ("How a BUY / SELL happens", the live-path diagram) and §3
(AI routing). This file is a focused summary of the debate/quorum mechanics specifically —
`CLAUDE.md` is still ground truth if anything here reads stale.

## Inputs

Every idea agent (TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent, PortfolioMonitor,
QuantSignalAgent, KronosForecastAgent, Opportunity Discovery/Screener) emits
`TRADE_IDEA_GENERATED { traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice }`
via `eventBus.emitTradeIdea(...)`, which gates it through `gateTradeIdea()` /
`looksLikeListedTicker()` before ChiefTrader ever sees it (garbage tickers/prices are rejected as
`TRADE_IDEA_REJECTED`, not silently dropped or passed through).

## Weighting

- Live weights come from `agent_performance_stats.currentWeight`, seeded from
  `config/agentWeights.json`'s defaults.
- `ReflectionEngine` (~60s cadence) updates weights based on real prediction-vs-outcome scoring,
  gated by **effective sample size** (not raw count) so autocorrelated/duplicated predictions from
  one agent can't inflate its own influence — see `src/server/research/effectiveSampleSize.ts` and
  `predictionIndependencePolicy.ts`. Weight changes are bounded per cycle
  (`tradingSafety.maxWeightAdjustmentPerCycle`) so one noisy cycle can't swing weighting to an
  extreme immediately.
- The risk-exit agent (`config/agentWeights.json`'s `riskExitAgent`, currently `PortfolioManager`)
  is excluded from this weight-learning loop entirely — its role is risk-exit, not alpha-seeking.

## Debate

- If confidence exceeds `tradingSafety.debateTriggerConfidence`, ChiefTrader can trigger a real
  multi-provider AI debate via `AIRouter.getInstance().routeConsensus(...)` (fans out to multiple
  providers in parallel — there is no single "Chief Trader model"). Provider failure fails closed
  (HOLD / confidence 0), never fabricates a vote.
- Requires at least `tradingSafety.minIndependentAgreeingAgents` (currently 2) independent agents
  agreeing, at a weighted confidence ≥ `tradingSafety.consensusApprovalThreshold` (currently 0.75).
  **Do not lower these to increase trade frequency** — see `CLAUDE.md`'s own repeated instruction
  on this exact point.
- A HOLD vote with confidence > 0 actively penalizes the opposing side's weighted score (it is not
  simply ignored).
- Risk-exit ideas (PortfolioMonitor SELL/REDUCE) skip debate and the min-agents requirement — exits
  are not alpha calls, they're risk management — but still go through every RiskEngine gate and OMS
  unchanged.

## Output

On approval, ChiefTrader mints a `transactionId` and emits `CHIEF_APPROVED_IDEA` — the **only**
event that authorizes RiskAgent to run `RiskEngine.evaluateRisk()`. The full, reviewed allowlist
of files permitted to emit this event (and why each one is there) lives in
`src/server/architecture.protection.test.ts` — a new emitter is a new order-approval path and
must never be added silently.

## Manual override / operator-confirmed trades

The Advanced Trade Sandbox's "Execute Override" and Opportunity Feed's CONFIRM BUY/SELL both route
through `runManualTradeCoEvaluation()` (`src/server/services/manualTradeCoEvaluation.ts`), which
triggers the same on-demand agent co-evaluation and waits for a real `ChiefTraderAgent` consensus
outcome at the same floors as the autonomous path (0.75 / min-2) — it does **not** shortcut
consensus or emit `CHIEF_APPROVED_IDEA` itself.

## ConfluenceCoordinator (automatic on-demand co-evaluation)

Added 2026-08-25 after real DB evidence showed ~90% of consensus attempts never reached
`minIndependentAgreeingAgents` — not from low confidence, but because `TechnicalAgent` almost
never had a second independent agent evaluate the *same* symbol in its ~60s freshness window.
`src/server/services/ConfluenceCoordinator.ts` (`tradingSafety.confluenceCoordinatorEnabled`,
default **on**) listens for `TRADE_IDEA_GENERATED`, and when the emitting agent is specifically
`TechnicalAgent` with a qualifying BUY/SELL at confidence ≥
`confluenceCoordinatorConfidenceThreshold` (not already in a per-symbol
`confluenceCoordinatorCooldownMs` cooldown), it calls `QuantSignalAgent.evaluateSymbol(symbol)`
and `KronosForecastAgent.evaluateOnDemand(symbol)` — the same on-demand entry points the manual
CONFIRM BUY/SELL path above already uses, not a new bypass. Both take only a symbol string (no
side/confidence/reasoning), so there is no channel for either to copy TechnicalAgent's vote;
independence is structural. It changes **how often** a second agent evaluates a symbol in-window —
never ChiefTrader's weights, threshold, or gate. NewsAgent is deliberately excluded (real paid-API
cost per call, no per-symbol on-demand hook, and it is already the rarest/most independent voice —
triggering it reactively risks burning its budget on symbols it wouldn't have chosen itself).
**Runtime-verified 2026-08-26:** fired 495 times in one ~3-hour session; quorum-cleared rounds
(`agreements_count >= 2`) were 21.1% of that session's 180 consensus rounds. Logged via
`structuredLogger` as `CONFLUENCE_COORDINATOR_TRIGGERED` into `observability_events` — a different
table than the EventBus-instrumented `event_traces` most other lifecycle events land in.

## What ChiefTrader is not

- Not a place to add a second "AI decides everything" shortcut — AI interprets quant evidence, it
  does not replace RiskEngine or invent prices/EV.
- `QuantCoreJava` (the optional Java Quant Core bridge, when live-idea emission is ever enabled)
  participates as **one more named agent** through the exact same `emitTradeIdea()` →
  weight/debate/consensus path — it gets no special treatment or separate quorum. See
  `docs/architecture/JAVA_QUANT_CORE.md`.
