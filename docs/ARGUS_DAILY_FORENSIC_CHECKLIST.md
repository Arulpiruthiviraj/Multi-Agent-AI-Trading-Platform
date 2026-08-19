# Argus daily forensic checklist

Operator checklist for “was the desk healthy today?” Each item says **where** to verify. Do not enable LIVE or Autobot from this document.

Auth: `/api/*` returns 401 unless the request is authed (`server.ts` middleware). `/health` and `/ready` are unauthenticated. When `AUTH_PASSWORD` is unset, bind is localhost-only — treat API as local operator.

---

## Checklist

- [ ] **Market data healthy**  
  `GET /api/v2/diagnostics` → `passing.MARKET_DATA` / codes `MD-002` `MD-005` `MD-001`. WS OPEN; tick age ≤ 300s. In-memory only for ticks.

- [ ] **Agents running**  
  `GET /api/v1/system/pipeline-agents` → togglable `healthLabel` not `DEAD`/`NOT_ARMED` when you expect ideas. Autobot off ⇒ many agents `NOT_ARMED` **by design**.

- [ ] **Agent heartbeats current**  
  Same payload: `lastTickAt`, `lastTickAgeMs` vs `pipelineAgentDeadAfterMs` 180000. **Memory-only** — restart zeros them.

- [ ] **Fundamental provider healthy**  
  `external_data_cache` for alphavantage/fundamentals; `ai_calls` errors; Alpha Vantage budget. Diagnostics MODEL_* optional.

- [ ] **Macro provider healthy**  
  Same cache `data_type = macro`; interval 75s.

- [ ] **News provider healthy**  
  `news_clusters` recent `updated_at`; `NEWS_PROVIDER_FAILED` events. Ideas may still be off (`newsEmitsTradeIdeas: false`).

- [ ] **LLM providers healthy**  
  `GET /api/v1/config/provider-status`; `GET /api/v2/orchestration/models`; `ai_providers.health`. Heavy-model queue full → HOLD 0. NVIDIA NIM default fallback is an ops defect.

- [ ] **Consensus receiving evidence**  
  Fresh `consensus_evidence` / `CHIEF_CONSENSUS_COMPLETED` in `event_traces`. `why-not-trading.explanation`.

- [ ] **RiskEngine evaluating**  
  Fresh `risk_assessments`. `passing.RISK_ENGINE` requires `TRADING_ENABLED`.

- [ ] **OMS active**  
  Cannot be toggled off. Check `trades` inserts when approvals exist; OMS crash-recovery logs.

- [ ] **Broker connected**  
  `GET /api/v1/config/brokers`; `broker_connections.status`; diagnostics BROKER/CAPITAL. Questrade cannot place.

- [ ] **Orders acknowledged**  
  `trades.broker_order_id` or explicit UNKNOWN timeout text. `ORDER_ACCEPTED`.

- [ ] **Fills arriving**  
  `fills` rows; unique watermark. InternalPaper fills on next tick.

- [ ] **Reconciliation healthy**  
  `GET /api/v1/system/reconciliation/status`; latest `reconciliation_events.matches`; no unacked `FILLED_ORDER_MISSING_LOCALLY`.

- [ ] **Portfolio monitor running**  
  Always-on catalog. Logs `[PortfolioWorker]` ~60s; `PORTFOLIO_DECISION_RECORDED`.

- [ ] **Exit engine running**  
  Same as PortfolioMonitor (there is no separate exit process).

- [ ] **No unexpected kill switch**  
  `GET /api/v1/system/trading-state`; `kill_switch_events` last `to_state`; `GET /api/v1/system/kill-switch-events`.

- [ ] **No database errors**  
  Logs `SQLITE_*`; `/ready`; integrity SQL `docs/sql/18_integrity_checks.sql`.

- [ ] **No event-loop failures**  
  `data/logs/crash.log`; `SYSTEM_ANOMALY`; process uptime `/health`.

---

## Diagnostic HTTP inventory (exist in source)

Authoritative **decision** data is SQLite + `getDecisionTrace`, not these snapshots.

| Method | Path | Purpose | Authoritative? | Source |
|---|---|---|---|---|
| GET | `/health` | Liveness | process only | `server.ts` |
| GET | `/ready` | SQLite reachable | DB connectivity | `server.ts` |
| GET | `/api/v2/diagnostics` | Full diagnostic snapshot + whyNotTrading | live probes; not a trade ledger | `DiagnosticService` |
| GET | `/api/v2/diagnostics/why-not-trading` | Idle/block explanation + lastConsensus | last consensus is **memory** | same |
| GET | `/api/v2/diagnostics/why/:id` | Explain transaction id | yes if row exists; 404 not fabricated | `explainTransaction` |
| POST | `/api/v2/diagnostics/retry/:component` | Retry a diagnostic component | operational | `v2System.ts` |
| GET | `/api/v1/system/pipeline-agents` | Agent switches + heartbeats | heartbeats memory | `pipelineAgentSnapshot` |
| POST | `/api/v1/system/pipeline-agents` | Enable/disable togglable idea agents | settings persist | same |
| GET | `/api/v2/live-readiness` | `evaluateLiveReadiness()` | machine LIVE gates | `v2System.ts` |
| GET | `/api/v2/system/startup-health` | Boot probes | snapshot | `v2System.ts` |
| GET | `/api/v2/system/mission-control` | Mission control bundle | mixed | `v2System.ts` |
| GET | `/api/v2/system/status` | Engine status | operational | `v2System.ts` |
| GET | `/api/v1/system/status` | v1 status | operational | `systemRoutes.ts` |
| GET | `/api/v1/system/trading-state` | Kill-switch state | yes for state | `systemRoutes.ts` |
| GET | `/api/v1/system/integrity` | Integrity helper | operational | `systemRoutes.ts` |
| GET | `/api/v1/system/reconciliation/status` | Recon | recon tables | `systemRoutes.ts` |
| GET | `/api/v1/system/kill-switch-events` | Kill history | `kill_switch_events` | `systemRoutes.ts` |
| GET | `/api/v2/traces` | List traces | DB | `traceRoutes.ts` |
| GET | `/api/v2/traces/:traceId` | Assembled trace | DB | same |
| GET | `/api/v2/traces/:traceId/export` | Export JSON | DB + honesty flags | same |
| GET | `/api/v2/observability/metrics` | sessionId + counters | telemetry | `observabilityRoutes.ts` |
| GET | `/api/v2/observability/events` | Structured logs | `observability_events` | same |
| GET | `/api/v2/observability/decisions/:traceId` | Decision logs | DB | same |
| GET | `/api/v2/observability/orders/:orderId` | Order trace | DB | same |
| GET | `/api/v2/transactions/:id` | Observatory assemble | DB | `v2System.ts` |
| GET | `/api/v2/desk/intelligence` | Elite desk scores | advisory | `v2System.ts` |
| GET | `/api/v2/desk/lifecycle` | Lifecycle | `trade_lifecycle_transitions` | `v2System.ts` |
| GET | `/api/v1/system/event-traces` | Raw event_traces | durable events | `systemRoutes.ts` |

Many other `/api/v1` and `/api/v2` routes exist (config, quant research, news, webhooks). They are **not** all diagnostic. Do not treat research backtest routes as fill evidence.

Example:

```bash
curl -s http://127.0.0.1:3000/api/v2/diagnostics/why-not-trading
curl -s http://127.0.0.1:3000/api/v1/system/pipeline-agents
```

Add session cookie if `AUTH_PASSWORD` is set.

**Count for audit:** 29 rows in the table above.

---

## Configuration hierarchy (do not change behavior)

```
BOOTSTRAP (process start)
    ↓
.env  (and process.env)
    ↓
config/*.json  (fail boot if required keys missing)
    ↓
database settings row  (operator UI: budget, Autobot, take-profit, …)
    ↓
config_overrides  (catalogued env flags; DB > .env > catalog default)
    ↓
runtime EffectiveRuntimeConfig
    ↓
services
```

**.env remains supported.** Settings UI can expose configurable values (desktop Dual configuration and phone Settings tab — `docs/ARGUS_MOBILE_SETTINGS.md`). First boot does **not** write overlay rows. Overlay save persists DB; restart hydrates; `.env` is never rewritten. Reset-to-env deletes overlay only.

Boolean true is still exactly `'true'`.

`PAPER_TRADING_ONLY` and LIVE_ARM **cannot** be overridden from Settings.

Full matrix: repo-root `ARGUS_CONFIGURATION_ARCHITECTURE.md`, `ARGUS_SETTINGS_CONFIGURATION_MATRIX.md`, `ARGUS_CONFIGURATION_SECURITY.md`.

Secrets stay in `.env` / encrypted `broker_connections` / `ai_providers` — never in `config_overrides` return payloads.

---

## Secret-safe verification

Never print API keys, secrets, passwords, `ENCRYPTION_SECRET`, wallet keys, tokens.

Safe checks (configured vs not):

```bash
# PowerShell: names only, not values
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k = ($_ -split '=',2)[0]
  $v = ($_ -split '=',2)[1]
  $set = if ([string]::IsNullOrWhiteSpace($v)) { 'NOT CONFIGURED' } else { 'CONFIGURED' }
  "$k=$set"
}
```

HTTP: `GET /api/v2/settings/effective` returns source ENV/DB/DEFAULT and **redacts secrets**.

Do not `SELECT api_key_encrypted` in forensic notes. Confirm `IS NOT NULL` only:

```sql
SELECT broker_name, paper_mode, status,
       CASE WHEN api_key_encrypted IS NULL OR api_key_encrypted = '' THEN 'NOT CONFIGURED' ELSE 'CONFIGURED' END AS key_state
FROM broker_connections;
```
