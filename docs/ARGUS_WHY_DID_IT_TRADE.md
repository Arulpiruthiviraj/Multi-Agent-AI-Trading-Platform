# Why did Argus trade?

Given **symbol + approximate timestamp** and/or **trade id / order id / transaction id / traceId**, reconstruct the full chain.

Do not invent missing rows. Absence is evidence.

---

## Inputs you can start from

| You have | Start here |
|---|---|
| `trades.id` (UUID) | SQL `docs/sql/02_trade_full_trace.sql` |
| `broker_order_id` | `SELECT * FROM trades WHERE broker_order_id = ?` |
| `transaction_id` (`ARG-YYYY-MM-DD-NNNNNN`) | `GET /api/v2/transactions/:id` and `/api/v2/diagnostics/why/:id` |
| `trace_id` (`trace_AAPL_…`) | `GET /api/v2/traces/:traceId` (`getDecisionTrace`) |
| Symbol + time window | Section 18 below |

`traceId` on the **order** is the triggering idea’s id, **not** a join of every voter. Voters are in `consensus_evidence.source_trace_id`. **CODE-VERIFIED** — `TransactionRegistry.ts` header.

---

## Reconstruction chain

```
MARKET DATA (in-memory / logs only)
  → AGENT SIGNALS (agent_predictions, kronos_predictions, quant_assessments)
  → AGENT EVIDENCE (consensus_evidence)
  → CONSENSUS (consensus_decisions)
  → DEBATE (debate_used, ConsensusDebate evidence row, ai_calls agent ConsensusDebate)
  → APPROVAL (CHIEF_APPROVED_IDEA event_traces; transactions.status)
  → RISK (risk_assessments + risk_gate_results)
  → POSITION SIZE (risk_assessments.max_quantity; PositionSizing in RiskEngine)
  → ORDER (trades)
  → BROKER (trades.broker_order_id, adapter logs)
  → FILL (fills)
  → POSITION (portfolio via recon)
  → EXIT (PortfolioManager idea + second trade SELL)
  → P&L (trades.profit_loss)
```

HTTP bundle: `GET /api/v2/traces/:traceId/export` schema `argus.decision_trace.v1`. Export includes `live: "NO-GO"` honesty fields — presence of a trace is **not** organic paper evidence. **CODE-VERIFIED** CLAUDE.md.

---

## Database records to join (APPLICATION-LEVEL)

```
transactions.id  = consensus_decisions.transaction_id
                 = consensus_evidence.transaction_id
                 = trades.transaction_id
                 = risk_assessments.transaction_id   (nullable)
                 = event_traces.transaction_id       (from approval onward)

trades.trace_id  = risk_assessments.trace_id
                 = risk_gate_results.trace_id
                 = event_traces.correlation_id       (typical)
                 = agent_predictions.trace_id        (triggering agent)
                 = transaction_traces.trace_id
                 = observability_events.trace_id / decision_id

fills.order_id   = trades.id

consensus_evidence.source_trace_id → other agents' agent_predictions.trace_id
                                   → ai_calls.trace_id
```

**No SQL FKs.** Unique indexes: `idx_trades_trace_id_unique`, `idx_fills_order_cumulative`.

---

## What to determine (and where)

| Question | Source |
|---|---|
| Which agents supported | `consensus_evidence` where `agreed = 1` and `side` matches decision |
| Each agent's direction | `consensus_evidence.side` |
| Confidence | `consensus_evidence.confidence` (calibrated at eval time) |
| Weight | `consensus_evidence.weight` (from `agent_performance_stats.currentWeight` or `config/agentWeights.json` defaults) |
| Disagreement | `agreed = 0`; event `AGENT_DISAGREEMENT` |
| Consensus calculation | Recompute per [ARGUS_CONSENSUS_FORENSICS.md](ARGUS_CONSENSUS_FORENSICS.md); compare to `weighted_confidence` |
| Debate result | `debate_used`, evidence `agent = 'ConsensusDebate'` |
| Risk decision | `risk_assessments.approved`, `rejection_gate` |
| Risk gates | `risk_gate_results` ordered by `sequence` |
| Position sizing | `max_quantity`; settings `maxTradeSize` / `positionSizingMode`; **not** Kelly |
| Order quantity | `trades.quantity` (whole shares `Math.floor`) |
| Execution / fill price | `trades.price` vs `fills.price` |
| Exit reason | SELL `trades.reasoning` / PortfolioManager `agent_predictions.reasoning` |
| Realized P&L | FILLED SELL `trades.profit_loss` |

---

## §18 How to investigate symbol AAPL

Pick a time range (ISO timestamps). Read-only.

1. **Market data:** cannot query SQLite ticks. Use logs, in-memory `recentEvents` if process still up, diagnostics freshness, optional `ohlcv_bars` for research bars only.
2. **Agent predictions:**
   ```sql
   SELECT timestamp, agent_name, prediction, confidence, trace_id, reasoning
   FROM agent_predictions
   WHERE symbol = 'AAPL' AND timestamp BETWEEN '2026-08-18T13:00:00' AND '2026-08-18T21:00:00'
   ORDER BY timestamp;
   ```
3. **Kronos / quant:** `kronos_predictions`, `quant_assessments` for `symbol`.
4. **Consensus:**
   ```sql
   SELECT * FROM consensus_decisions
   WHERE symbol = 'AAPL' AND created_at BETWEEN '…' AND '…';
   ```
   Then `consensus_evidence` for those `transaction_id`s.
5. **Debate:** `ai_calls` where `agent` like `%Consensus%` or `trace_id` in evidence; `debate_used` flag.
6. **Risk:** join `risk_assessments` on `transaction_id` or triggering `trace_id`.
7. **Orders / fills:** `trades` / `fills` for symbol.
8. **Portfolio / exits:** `portfolio`, PortfolioManager predictions, SELL trades.
9. **P&L:** FILLED SELL `profit_loss`; `daily_trading_summary`.
10. **Errors:** `observability_events` where `symbol = 'AAPL'`; `event_traces` `success = 0`; `ai_calls.status = 'error'`.

Also: `GET /api/v2/traces?symbol=AAPL`.

---

## §19 How to investigate trade ID X

`X` = `trades.id`.

```sql
SELECT * FROM trades WHERE id = 'X';
SELECT * FROM fills WHERE order_id = 'X';
```

Then use `trace_id` and `transaction_id` from that row with `docs/sql/02_trade_full_trace.sql` (replace the placeholder).

HTTP: `GET /api/v2/observability/orders/:orderId` (`getOrderTrace`).

Lifecycle: `transaction_traces` by `trace_id`; `trade_lifecycle_transitions` by `candidate_id` (often the traceId).

---

## §20 How to investigate order ID X

Order ID may be:

| Kind | Column |
|---|---|
| Local OMS UUID | `trades.id` |
| Broker id | `trades.broker_order_id` |
| Client/idempotency | `trades.request_id` (comment: == id today) |

Chain:

```
trade (trades)
  → risk (risk_assessments.trace_id = trades.trace_id)
  → broker (broker_order_id + adapter logs)
  → fill (fills.order_id = trades.id)
  → transaction (transactions.id = trades.transaction_id)
  → reconciliation (reconciliation_events.mismatches JSON; portfolio_snapshots)
```

If you only have a broker id:

```sql
SELECT * FROM trades WHERE broker_order_id = 'X';
SELECT * FROM reconciliation_acknowledgements WHERE broker_order_id = 'X';
```

---

## Canonical “trace one trade by ID”

1. Operator copies `trades.id` from UI / `01_recent_trades.sql`.
2. Load trade row → note `trace_id`, `transaction_id`, `broker_order_id`.
3. `GET /api/v2/traces/{trace_id}/export` **and** `GET /api/v2/diagnostics/why/{transaction_id}`.
4. Confirm voters in `consensus_evidence` (do not assume `trace_id` was the only agent).
5. Confirm every `risk_gate_results.passed` (do not stop at `rejection_gate` if you need the full ladder).
6. Confirm fill watermark vs `trades.quantity`.
7. If SELL, find the opening BUY by symbol + earlier `filled_at`, and the PortfolioManager idea.

IDs reference: [ARGUS_TRADE_FORENSIC_IDS.md](ARGUS_TRADE_FORENSIC_IDS.md).
