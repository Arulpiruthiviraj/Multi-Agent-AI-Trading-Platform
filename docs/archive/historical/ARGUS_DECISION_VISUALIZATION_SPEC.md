# ARGUS_DECISION_VISUALIZATION_SPEC.md

Existing UI: Digital Twin (live WebSocket node graph), **Agent Workflow Theater** (`src/components/AgentWorkflowTheater.tsx` on the Agent Network tab — educational per-agent motion scenes; cards pulse on real events; looping stages are architecture, not fabricated ticks), OrchestrationStatus, ReplayResearchPanel, QuantSignalsPanel (experimental strategies labeled UNVALIDATED).

Do **not** show hidden chain-of-thought. Safe fields: side, confidence, EV, model name, latency, data-quality status, NO_TRADE code, `inventedNumericFieldsRejected`.

Safe node payload: INPUT snapshot ids, OUTPUT side/confidence/EV, model **name**, latency, data-quality status, NO_TRADE code.

Historical AI replay of a past year remains **UNAVAILABLE** without point-in-time news/LLM logs (`aiReplayAvailability.ts`). Show that status; do not animate a fake 2022 debate.
