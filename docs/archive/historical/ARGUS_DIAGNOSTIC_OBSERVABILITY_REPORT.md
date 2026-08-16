# ARGUS Diagnostic Observability Report

**Date:** 2026-08-15  
**Rule:** Fail loudly, explain from real state, recover safely, never hide why a decision did not happen.  
**Still true:** RiskEngine is not weakened. Capital limits are not bypassed. Models are not declared accurate. Real-money GO remains **NO**.

---

## 1. Existing diagnostic infrastructure (reused)

| Piece | What it already did |
|-------|---------------------|
| `IntegrityValidator` | Structural PASS/FAIL/UNKNOWN (tables, brokers, AI seed, news plugins, Chronos `/health`, OpenAlice) |
| `ModelRuntimeManager` | Ollama / Chronos / OpenAlice / IBKR probe with reason + action |
| `MarketDataWorker.isConnected()` / `getLatestPriceAgeMs` | Real WS state and quote age |
| `RiskEngine` gates + `risk_assessments` / `risk_gate_results` | First-failure reason, all gates recorded |
| `CAPITAL_CHECK` / Argus vs broker snapshot | Allocation vs buying power |
| `AwaitingSignal` | Honest empty UI for missing data |
| `GET /api/v2/transactions/:id` | Persisted why-a-trade anatomy |
| `AlertingService` | `AI_PROVIDERS_EXHAUSTED` |
| EventStore | Decision lifecycle persistence |

**Problem this pass fixed:** several UIs still said “unavailable / failed / awaiting” without what/why/impact/fix. `ConnectionStatusDashboard` **fabricated** 45ms latency and 99.9% uptime from a boolean. That fabrication is removed.

---

## 2. New diagnostic architecture

```
Live probes + DB rows
        ↓
buildDiagnostic(code, facts)   ← catalog templates, facts only
        ↓
DiagnosticMessage
        ↓
EventBus (on fingerprint change) + GET /api/v2/diagnostics
        ↓
ExplainCard / DiagnosticCenter / WhyNotTradingStrip
```

Unknown catalog placeholders become `(not reported by the underlying system)` — never a fake PID, CPU%, or uptime.

---

## 3. Components covered

BROKER, MARKET_DATA, NEWS, CHRONOS/KRONOS, OLLAMA, OPENALICE, FUNDAMENTAL (Alpha Vantage key), RISK_ENGINE, CAPITAL, BACKTEST, SYSTEM (kill switch), AI_ROUTER (failover).

Technical/Quant/ChiefTrader health is implied via last risk/consensus rows and existing agent events, not a fake “engine heartbeat.”

---

## 4. Error codes

| Code | Meaning | Trading blocked? |
|------|---------|------------------|
| MD-001 | Quote older than RiskEngine **5 minutes** (not 5 seconds — that is the real gate) | Yes, new orders |
| MD-002 | Alpaca keys unset; worker idle, no fabricated ticks | Tick pipeline inactive |
| MD-003 | WS OPEN + coverage note (top-of-book, no L2) | No |
| MD-004 | L2 missing by design | No |
| CFG-001 | `ALPHAVANTAGE_API_KEY` unset | No (optional evidence) |
| NEWS-001 | Providers online, zero matching articles | No (not an error) |
| NEWS-002 | Paid news provider `isConfigured()===false` | No |
| MOD-001/002 | Chronos/Ollama unreachable | **No** — optional |
| MOD-003/004 | OpenAlice disabled vs enabled-but-down | **No** — never authorizes |
| MOD-005 | Service up, sequence too short | No |
| CAP-001 | Argus allocation, **not** broker BP | This order |
| RSK-001 | Named RiskEngine gate | This entry |
| BRK-001 | Broker API/portfolio failure | This order |
| BT-001/002 | Thin bars / corporate action | Backtest only |
| SYS-001 | Pause / emergency stop | New orders |
| AI-001 | Provider failover (via `MODEL_FALLBACK`) | No |

---

## 5. Automatic recovery behavior

- **Probe retry** (`POST /api/v2/diagnostics/retry/:component`): re-runs `ModelRuntimeManager.refresh()`. Does not skip RiskEngine.
- **Spawn/restart** still requires `ARGUS_START_LOCAL_MODELS` / `ARGUS_START_CHRONOS` (unchanged). Diagnostics will not start Chronos just because the UI clicked Retry.
- **No auto-resume** of emergency stop.
- **No auto-ignore** of stale data. RiskEngine `data_freshness` remains authoritative.
- AIRouter failover now emits `MODEL_FALLBACK` **only when a later provider actually succeeds**, so a total outage is still `AI_PROVIDERS_EXHAUSTED`, not a fake fallback.

---

## 6. User-facing explanations

`ExplainCard` always shows: Why, Impact, Trading, Can Argus continue, Fix, steps, code.  
New **DIAGNOSTICS** tab + Command Center **Why is Argus not trading?** strip.  
Transaction explain: `GET /api/v2/diagnostics/why/:id` from persisted consensus/risk/fills.

---

## 7. Trading-impact rules

- Optional model down → `tradingBlocked: false`, evidence excluded.
- Required safety (stale quote, kill switch, capital gate, other RiskEngine gates) → blocked with the **gate name**, not “TRADE REJECTED”.
- CAP-001 text states broker buying power is **not** the reason.

---

## 8. Model availability

Chronos default endpoint remains **`LOCAL_AI_SERVICE_URL` or `http://localhost:8008`**, not 8001. Kronos throw text now says the service is optional and how to start it. CPU/memory/PID are **not** shown unless a real process inspector exists (it does not).

---

## 9–13. Broker / capital / RiskEngine / data quality / frontend

- Broker vs Argus numbers still from `orchestration/capital` + diagnostic snapshot.
- Last `risk_assessments` rejection is surfaced as RSK-001 or CAP-001.
- Market-data quality: last tick age from `MarketDataWorker`; L2 explicitly MD-004.
- `ConnectionStatusDashboard` rewritten onto `/api/v2/diagnostics`.
- `AwaitingSignal` can mark `emptyResult` (no matching data ≠ outage).

---

## 14. EventBus

Persisted: `DIAGNOSTIC_CREATED`, `DATA_STALE`, `MODEL_UNAVAILABLE`, `MODEL_FALLBACK`, `CAPITAL_BLOCK`, `RISK_BLOCK`.  
Emitted on **status fingerprint change** so a 15s UI poll does not spam identical rows.

---

## 15. Tests

`src/server/diagnostics/diagnostics.test.ts` — interpolation, optional Chronos, stale 5-minute window, NEWS-001 vs API key, CAP-001 vs broker, BT-002, missing placeholders.

Run with existing RiskEngine/capital/OMS tests; do not delete prior suites.

---

## 16. Remaining blind spots

- Paid news `healthCheck()` still returns `true` for several plugins — NEWS-002 uses `isConfigured()`, not a live HTTP status those plugins do not implement.
- No per-process CPU/RAM for Chronos (would be fabricated).
- Why-not-trading treats Autobot `enabled===false` as “not trading” even when diagnostics are green (correct: the bot is off).
- ChiefTrader HOLD narrative is evidence rows on `diagnostics/why/:id`, not a new LLM paragraph.
- Legacy `GET /api/v1/signals` is still a separate order path; diagnostics describe the EventBus pipeline.
- Replay speed 0.5x–10x over `event_traces` was not added in this pass.

**Do not** treat a prettier error card as a trading edge.
