# 17 — EventBus and logging

Canonical strings: `config/eventNames.json`. High-frequency ticks not all durable.

**Persisted (persist array):** MARKET_DATA, CALCULATION_COMPLETED, TRADE_IDEA_GENERATED, CHIEF_APPROVED_IDEA, RISK_ASSESSMENT_COMPLETED, ORDER_EXECUTED, LEARNED_NEW_RULE, OPENALICE_*, CHIEF_CONSENSUS_*, RISK_ASSESSMENT_STARTED, ORDER_SUBMITTED/ACCEPTED/FILLED, CAPITAL_CHECK, AGENT_DISAGREEMENT, POSITION_*, MODEL_*, DIAGNOSTIC_CREATED, DATA_STALE, MODEL_UNAVAILABLE, MODEL_FALLBACK, CAPITAL_BLOCK, RISK_BLOCK.

**PORTFOLIO_UPDATE** listed but **not** in persist array.

Also emitted (not all in JSON): `MARKET_DATA_UPDATED`, `MARKET_REGIME_DETECTED`, recon match/mismatch, Kronos types.

WS: wildcard to SPA. UI trade visibility: ORDER_* + Observatory `GET /api/v2/transactions*`. Console logs are the ops log; no required ELK.
