# 23 — Performance (no changes)

Bottlenecks: LLM debate latency (20s cap); Alpaca REST; Quant on 400-day bars per symbol; SQLite single writer; ChiefTrader window; WS fanout; Chronos CPU/GPU first load; `status=all` orders on inbound recon.

No GPU required for Node. Parallel agents yes; RiskEngine serialized. Rate limits: Alpaca 429 retry-after. Memory: in-memory EventStore ring + InternalPaper.

Possible issues: App.tsx size; inbound `orders?status=all` unbounded; news 10s timer.
