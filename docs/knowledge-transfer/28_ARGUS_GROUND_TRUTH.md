# 28 — Ground truth vs documentation

Primary: **code + tests**. Dated reports: `docs/archive/historical/`.

| Claim | Reality |
|---|---|
| 45 tables | **44** sqliteTable |
| AGENTS.md ATR live sizing | `stopLossAssumptionPct` 0.05 |
| Section 30.12 recon flag ignored | **Obsolete** — TRADING_PAUSED |
| Section 30.5 no timeouts | **Obsolete** — AbortController |
| Section 30.5 no crash recovery | **Obsolete** — OMS ingest + stale |
| 53% readiness | **Do not reuse** — no new % invented |
| Grok Real in old matrix | **No GrokProvider class** |
| Coinbase stub | Adapter JWT real; paper placeOrder refuses |
| PipelineFlatten skips RiskEngine | Emits CHIEF_APPROVED_IDEA into RiskAgent |
| LiteLLM | Stale comment |
| 760 strategies | Taxonomy aliases |
| CLAUDE.md 45 tables | Drift — count schema |
| FINAL_ANALYSIS §1 “9 gates” | **18** recorded |
| Adding markdown raises LIVE | **False** |
