# ARGUS_MODEL_PERFORMANCE_SPEC.md

## Already real

- `agent_performance_stats.currentWeight` from ReflectionEngine (closed trades).
- NewsAgent evaluated accuracy **44.6% / 242**.
- Beta-Binomial calibration in ChiefTrader when history exists.
- Quant EV gate uses `LiveStrategyPerformance` and refuses below sample / non-positive EV.

## Do not do

Weight Claude vs Gemini vs Ollama as independent votes on the same prompt. Record **which model** produced a structured note (`AIRouter` already tracks provider). Tournament tables wait for outcome-linked predictions.

## Bull/Bear

`config/bullBearResearch.json` + `parseResearchNote`. Enabled only when `QUANT_BULL_BEAR_ENABLED=true`. Not in the always-on path.
