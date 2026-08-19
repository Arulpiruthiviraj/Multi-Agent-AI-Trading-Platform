# Why didn't Argus trade?

Exact troubleshooting procedure. Work top-down. Stop at the first failed stage — later stages never ran.

Companion: [ARGUS_FORENSIC_DEBUGGING_GUIDE.md](ARGUS_FORENSIC_DEBUGGING_GUIDE.md).

**Fast path:** `GET /api/v2/diagnostics/why-not-trading`  
**CODE-VERIFIED** — `DiagnosticService.collectDiagnostics`, `v2System.ts`. Returns `isTrading`, `primary`, `blocking`, `passing`, `explanation` (`formatWhyNoTrade` of last consensus), `lastConsensus`.

Also: `GET /api/v1/system/pipeline-agents` (heartbeats), Diagnostics tab `WhyNotTradingStrip`.

---

## STEP 1 — Did market data arrive?

**Event:** `MARKET_DATA` (in-memory ring only; **not** SQLite).

Check:

- Process up (`/health`, `/ready`)
- Alpaca keys configured (do **not** print them — see security section in [ARGUS_DAILY_FORENSIC_CHECKLIST.md](ARGUS_DAILY_FORENSIC_CHECKLIST.md))
- WebSocket OPEN: diagnostics `MD-005` if not
- Symbol, price, volume, timestamp on a recent in-memory event
- Freshness: `stalePriceThresholdMs` = 300000 (5 min). **Null age (never ticked) fails `data_freshness` later** — DEF-08 by design

If no ticks:

- Investigate `MarketDataWorker` / Alpaca IEX WS
- `MARKET_DATA_DISCONNECTED`, `MARKET_DATA_REJECTED` (future skew / out-of-order)
- Unconfigured keys → diagnostic `MD-002`; `market_hours` gate **skips/passes** when clock API has no keys (**CODE-VERIFIED** CLAUDE.md)

**Verify:** `GET /api/v2/diagnostics` `passing` row `MARKET_DATA`.

---

## STEP 2 — Did agents evaluate?

**HTTP:** `GET /api/v1/system/pipeline-agents`

Per togglable agent (`config/pipelineAgents.json`): `lastTickAt`, `lastSuccessfulTickAt`, `lastFailureAt`, `lastError`, `currentState` (`IDLE|TICKING|SUCCESS|FAILED|GATED`), `healthLabel` (`ENV_OFF|OFFLINE|NOT_ARMED|DEAD|HEALTHY|GATED`).

| Agent | What “evaluated” means | DB evidence |
|---|---|---|
| TechnicalAgent | Heard ticks, enough history for RSI/MACD/BB | `agent_predictions` if it emitted an idea |
| KronosForecastAgent | Chronos `/health` + 30+ ticks + cooldown | `kronos_predictions` |
| FundamentalAgent | Timer ~60s, Alpha Vantage cache | `agent_predictions`, `external_data_cache`, `ai_calls` |
| MacroAgent | Timer ~75s | same |
| NewsEngine | Clusters every ~10s | `news_clusters` / `news_articles`. Ideas **off** by default |
| QuantSignalAgent | Cycle 5 min **and** `QUANT_ENGINE_ENABLED=true` | `quant_assessments` even when no idea |

**HOLD / unavailable:** LLM fail-closed HOLD confidence 0 (`AIOutputValidator`). Alpha Vantage exhausted → `DATA_UNAVAILABLE` shape (HOLD 0, excluded from consensus denominator).

**Cooldowns / rate limits:**

- Alpha Vantage daily budget `alphaVantageDailyRequestBudget` 25 — `external_data_cache.rate_limited_until`
- Kronos 1 call/symbol/60s
- News LLM `newsLlmMaxCallsPerCycle` 2
- Heavy models mutex (`qwen2.5:14b`, `deepseek-r1:14b`) maxConcurrent 1
- Opportunity loop default **off** (subscribe-only if enabled)

Autobot off: **new BUY ideas** are gated (`isLiveIdeaGenerationEnabled` / RiskEngine `autobot_enabled`). SELL/exits still require `TRADING_ENABLED`. Technical ticks can still flow if `TRADING_ENABLED` — **CODE-VERIFIED** CLAUDE.md.

---

## STEP 3 — Was TRADE_IDEA_GENERATED created?

**Inspect:**

1. `event_traces` where `event_type = 'TRADE_IDEA_GENERATED'` and `payload` JSON contains the symbol  
2. `agent_predictions` for `symbol` + `timestamp` window  
3. `TRADE_IDEA_REJECTED` / `ASSET_CANDIDATE_BLOCKED` if gated

```sql
SELECT timestamp, source, correlation_id, SUBSTR(payload, 1, 400)
FROM event_traces
WHERE event_type IN ('TRADE_IDEA_GENERATED', 'TRADE_IDEA_REJECTED', 'ASSET_CANDIDATE_BLOCKED')
ORDER BY timestamp DESC
LIMIT 50;
```

If rejected: `gateTradeIdea` reasons (invalid ticker / missing price) or asset overlay (`ASSET_*` codes in `config/noTradeReasons.json`).

---

## STEP 4 — Did ChiefTrader receive it?

ChiefTrader listens to `TRADE_IDEA_GENERATED`. Ideas live in **memory** (`recentIdeas`) for `chiefTraderIdeaTtlMs` (60000). Restart loses the window.

**DB (only after an evaluation cycle persists):**

- `consensus_decisions`
- `consensus_evidence`
- `transactions`
- `agent_predictions` (idea log, not the ChiefTrader window itself)

**Logs:** `[ChiefTrader]`. `lastConsensusOutcome` is process-memory — `why-not-trading.explanation`.

If no consensus row and no `CHIEF_CONSENSUS_COMPLETED` in `event_traces`: the idea expired, debate is in flight, `consensusEvalMinIntervalMs` (5000) skipped a duplicate-agent replace, or workers not armed.

---

## STEP 5 — Why was consensus rejected?

Current rejection paths (**CODE-VERIFIED** `ChiefTraderAgent.evaluateConsensusSerialized` + `EvidenceAggregator`):

| Reason | Condition |
|---|---|
| HOLD / below threshold | `result.side === 'HOLD'` **or** `confidence <= 0.75` (must **exceed** threshold) |
| Insufficient independent agents | Unique agreeing agents excluding `ConsensusDebate` < `minIndependentAgreeingAgents` (2) |
| Debate HOLD | `ConsensusDebate` side HOLD (hard veto agent) |
| Bear HOLD | Bear researcher HOLD when that agent is in evidence (`QUANT_BULL_BEAR_ENABLED`) |
| Quant AI contradiction | `quantDetail.aiContradictionAnalysis.available && aiAgreesWithSide === false` |
| Debate fail-closed | 0 usable debate providers → HOLD vote pushed |
| Stale idea | TTL 60s — idea dropped from `recentIdeas` before a second independent voice |
| Duplicate/coalesced | `coalesceEvidenceByAgent`: last observation per agent wins; extra ticks are **not** extra votes |
| Unavailable agent | HOLD confidence 0 excluded from denominator |
| Risk-exit exception | `PortfolioManager` SELL **approves** without quorum — not a reject path |

**Manual reconstruction** from DB (approved=0 rows):

```sql
SELECT agent, side, confidence, weight, agreed, reasoning
FROM consensus_evidence
WHERE transaction_id = 'ARG-…';
```

Recompute with [ARGUS_CONSENSUS_FORENSICS.md](ARGUS_CONSENSUS_FORENSICS.md). Note: persisted `confidence` is **calibrated** (Beta-Binomial lookup) when a calibration row exists.

SQL: `docs/sql/03_failed_consensus.sql`, `04_consensus_evidence.sql`.

---

## STEP 6 — Did CHIEF_APPROVED_IDEA occur?

```sql
SELECT * FROM event_traces
WHERE event_type = 'CHIEF_APPROVED_IDEA'
ORDER BY timestamp DESC LIMIT 20;

SELECT * FROM consensus_decisions WHERE approved = 1 ORDER BY created_at DESC LIMIT 20;
```

If no: **stop at consensus.** RiskEngine never ran for this idea.

If yes: `transactions.status` typically `OPEN`; `transactionId` is on the event payload.

---

## STEP 7 — Did RiskAgent receive it?

RiskAgent is a thin listener on `CHIEF_APPROVED_IDEA`. Telemetry pulses are ignored.

**Logs:** `[RiskManager] Validating {side} on {symbol}`

**Prove:** `risk_assessments` row with matching `trace_id` (the **approved idea’s** traceId, not every contributing agent’s).

If Chief approved but no risk row: listener throw (EventBus isolates throws — remaining listeners still run), persist failure, or process crash between emit and persist.

---

## STEP 8 — Which RiskEngine gate failed?

```sql
SELECT rejection_gate, approved, reasoning FROM risk_assessments WHERE trace_id = '…';

SELECT sequence, gate_name, passed, detail
FROM risk_gate_results
WHERE trace_id = '…'
ORDER BY sequence;
```

All 24 gates are recorded (SELL adds `sell_position_exists`; BUY omits it). Catalog order: `config/riskGateOrder.json`. Pass/fail **must** come from this table, not the JSON file.

See [ARGUS_RISK_FORENSICS.md](ARGUS_RISK_FORENSICS.md). SQL: `05_risk_failures.sql`, `06_risk_gate_summary.sql`.

If persist failed: `RISK_BLOCK` gate `risk_assessment_persist` — OMS will not execute.

---

## STEP 9 — Was the order passed to OMS?

OMS listens to `RISK_ASSESSMENT_COMPLETED`. Unapproved assessments should not place.

**Prove:** `trades` row with `trace_id` unique (`idx_trades_trace_id_unique`).

```sql
SELECT id, status, submitted_at, reasoning FROM trades WHERE trace_id = '…';
```

If approved risk but no trade: OMS ignored telemetry pulse, duplicate `trace_id`, `authorizeProductionOrder` refused, or listener error.

---

## STEP 10 — Did OMS call the broker?

**Prove (any one):**

- `trades.broker_order_id` populated
- `ORDER_SUBMITTED` in `event_traces`
- Structured log category `ORDER` / `BROKER` with `orderId`
- Broker adapter logs (Alpaca REST, IBKR Gateway, InternalPaper queue)

`placeOrder` throw **before** brokerOrderId: row stays **PENDING**, not REJECTED. Reconcile; do not retry blindly. **CODE-VERIFIED** OMS comments.

P0.1: LIVE_NO_GO blocks OMS `placeOrder` on live; paper unaffected.

---

## STEP 11 — Did the broker accept/reject?

| Broker | Evidence |
|---|---|
| InternalPaperBroker | In-memory fill on next broker tick; `execution_environment=PAPER` |
| Alpaca | REST order id → `broker_order_id`; circuit breaker in `tradingSafety.json` |
| IBKR | Gateway session; paper `DU*` vs live `U*` fail-closed (P0.2) |
| Coinbase | `placeOrder` **refuses in paper**; live needs LIVE_ARM |
| Questrade | `placeOrder` **throws** — read-only |

Statuses on `trades.status`: PENDING, FILLED, REJECTED, CANCELED (schema comment). Also PARTIALLY_FILLED appears in diagnostic explain path — **PARTIAL** whether OMS writes that string on every adapter.

---

## STEP 12 — Was it filled?

```sql
SELECT * FROM fills WHERE order_id = 'TRADES.ID';
SELECT status, filled_at, quantity, price FROM trades WHERE id = '…';
```

Unique `(order_id, cumulative_quantity)` — duplicate broker callbacks are a unique-constraint no-op (P0.4).

Timeout ≠ fill.

---

## STEP 13 — Did reconciliation see the position?

```sql
SELECT * FROM portfolio WHERE symbol = 'AAPL';
SELECT * FROM reconciliation_events ORDER BY id DESC LIMIT 5;
```

`portfolio` is **current state**, hydrated by recon, **not** inserted by OMS at fill. Empty `portfolio` shortly after fill can be **timing**, not a missing fill.

`FILLED_ORDER_MISSING_LOCALLY` requires operator ack (`reconciliation_acknowledgements`). Never auto-resume.

---

## STEP 14 — Did PortfolioMonitor evaluate?

Timer `portfolioMonitorMs` 60000. Needs a `portfolio` row **and** a live IEX tick or it records `NO_PRICE` (no fabricated exit).

Logs: `[PortfolioWorker]`. Event `POSITION_MONITORED` / `PORTFOLIO_DECISION_RECORDED`.

---

## STEP 15 — Was an EXIT candidate generated?

`agent_predictions` with `agent_name = 'PortfolioManager'` (config `riskExitAgent`) and `prediction = 'SELL'`.

Reasoning prefixes: `EXIT_CODE=TARGET_REACHED`, `EXIT_CODE=HARD_STOP`, `EXIT_CODE=TRAILING_STOP` (cost-basis backstop — **not** peak trail), `EXIT_CODE=THESIS_INVALIDATION`.

See [ARGUS_PORTFOLIO_EXIT_FORENSICS.md](ARGUS_PORTFOLIO_EXIT_FORENSICS.md).

---

## STEP 16 — Did the SELL execute?

Same chain as BUY from STEP 4, except:

- Risk-exit **skips** min-2 / debate
- Gate `sell_position_exists` is recorded
- Gate `autobot_enabled` does **not** block SELL
- Still requires `tradingState === TRADING_ENABLED`
- Still full RiskEngine + OMS + broker

Complete forensic chain:

`portfolio` → PortfolioMonitor → `TRADE_IDEA_GENERATED` (PortfolioManager) → ChiefTrader risk-exit approve → `CHIEF_APPROVED_IDEA` → RiskEngine → `trades` SELL → `fills` → `profit_loss`.

---

## Common “idle all day” fingerprints

| Fingerprint | Likely stage |
|---|---|
| WS not OPEN | 1 |
| Agents NOT_ARMED / Autobot off | 2 |
| News-only, no second agent | 5 (quorum). News ideas default **off** anyway |
| `data_freshness` / `market_hours` fail | 8 |
| `QUANT_ENGINE_ENABLED` false and Technical never fires | 2 — confirm tick count / RSI path |
| Last consensus “need 2 independents” | 5 — expected with News ideas off |
