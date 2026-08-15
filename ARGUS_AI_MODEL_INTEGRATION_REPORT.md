# ARGUS_AI_MODEL_INTEGRATION_REPORT.md

## Existing stack (preserved)

- `AIRouter` — all LLM calls; failover, cost estimate, agent routing overrides.
- Local: Ollama (non-blocking boot check), Chronos/Kronos via `npm run ai:serve` / `ModelRuntimeManager` (spawn only with explicit env flags).
- Optional OpenAlice MCP verification — fire-and-forget after approval; never blocks the trade that already executed.
- Quant contradiction review — qualitative only; cannot change deterministic side/confidence.

## What this pass did **not** do

- Did not add a sequential Chronos→Kronos DAG on every tick (agents already run in parallel on timers / MARKET_DATA).
- Did not make trading depend on a single model.
- Did not enable historical AI replay of 2022 (UNTESTABLE without point-in-time prompts and news).

## Live evidence that still forbids “smarter NewsAgent”

NewsAgent directional accuracy **44.6%** on **242** real evaluated predictions (`ARGUS_AI_VALIDATION_REPORT.md`). Worse than chance. Weighting already flows through `agent_performance_stats`; do not increase NewsAgent power until calibration and outcome recording stay honest.

## Feature snapshot vs AI

ChiefTrader now *can* receive `supportingQuantDetail.featureSnapshot` when QuantEngine contributed. That is structured quantitative evidence for interpretation. It is **not** an automatic BUY and **does not** bypass RiskEngine.

## ModelRegistry

`ModelRuntimeManager` already tracks local service health. A separate all-provider ModelRegistry UI was **not** added this pass (would not change edge). Failures must remain visible as health/status, not silent HOLD fabrication.
