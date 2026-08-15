# ARGUS_TRADINGAGENTS_COMPARISON.md

Reference: [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) v0.3.1 README (Apache-2.0). Research framework; Portfolio Manager sends orders to a **simulated exchange**. Not a replacement for Argus.

## Verdict

Argus remains system of record and execution. Adopt **ideas**, not LangGraph wholesale, not simulated-exchange assumptions.

## Feature-by-feature

| Idea | Adopt? | Why |
|---|---|---|
| Bull vs Bear researchers | **Concept yes** | Highest value. Both get the same Quant evidence. Structured notes. Default **off** (`QUANT_BULL_BEAR_ENABLED`). |
| Persistent decision memory with lessons | **Concept yes, later** | Argus has event_traces, learned_rules (write-only to prompts), agent_performance_stats, replay ledger. Do not inject future news. |
| Structured agent outputs | **Yes, additive** | `TradeThesis` + `parseResearchNote` (numeric fields from Quant only). |
| Broad LLM provider list | Partial | Argus already routes via AIRouter. Do not add providers just to match a README. |
| LangGraph checkpoint | **Rejected as a rewrite** | Argus already has OMS crash recovery and EventStore. Per-symbol analysis checkpoint is P2, not a new orchestration runtime. |
| Simulated exchange | **Rejected** | BrokerManager + RiskEngine stay. |
| LLM as final authority | **Rejected** | NewsAgent 44.6% accuracy. |
| Counting correlated AI votes | **Rejected** | Same mistake as counting RSI+MACD+Stoch as independent. |

## Code map (Argus, not vendored TradingAgents)

| Concept | Argus files |
|---|---|
| Bull/Bear schema | `config/bullBearResearch.json`, `src/server/ai/research/parseResearchNote.ts` |
| Structured thesis | `src/server/quant/thesis/assembleTradeThesis.ts` |
| NO_TRADE catalog | `config/noTradeReasons.json` |
| Thesis invalidation | `config/thesisInvalidation.json`, `src/server/quant/analysis/ThesisInvalidation.ts` |

Implemented as **concepts in Argus code**, not a copy of TradingAgents: config-driven invalidation, TradeThesis on Quant ideas, Bull/Bear parser (not wired to ChiefTrader), NO_TRADE catalog.

## Explicitly not implemented (and not enabled)

Edge Engine over 183 comparable setups, 30 new strategies, strategy sleeping, MAE/MFE engine, LangGraph, shadow-portfolio runner, TSX-wide scanner, options, L2, historical AI replay of 2022 (still UNAVAILABLE).
