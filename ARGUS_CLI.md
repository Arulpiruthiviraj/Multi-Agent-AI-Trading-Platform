# ARGUS CLI

The Argus CLI is a **thin HTTP client** for a running Argus Engine.

```text
argus-cli / ./argus
    │
    │ HTTP
    ▼
Argus Engine :3000
    │
    ├── ArgusCoreBoot
    ├── TradingEngine
    ├── ChiefTrader / Consensus
    ├── RiskEngine
    ├── PositionSizing
    ├── OMS
    ├── BrokerManager
    ├── SQLite
    ├── Historical Evaluation
    └── QuantCoreBridge ──HTTP──► Java Quant Core :8085 (optional, advisory-only)
```

The CLI does **not** contain or run its own:

* RiskEngine
* OMS
* BrokerManager
* trading decision engine
* broker execution logic

**One engine. One trading brain. The CLI is a remote control and observability client.**

The optional Java Quant Core (`quant-core-java/`, port 8085, default **off** —
`QUANT_JAVA_CORE_ENABLED=false`) is **not** a second trading brain and is **not** part of the
decision spine above: it is a loopback-only, advisory calculation service (indicator math + CORE
strategy decision logic + a research backtester) that Argus Engine's own `QuantCoreBridge.ts`
talks to. It has no broker access, no credentials, and cannot place an order. See
`docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md` and
`docs/audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md`.

Shell operator entry: [`./argus`](argus) — see [`ARGUS_SHELL_CLI.md`](ARGUS_SHELL_CLI.md).  
Name philosophy: [`README.md`](README.md) § Why "ARGUS"?  
Engine: [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md).

---

## 1. Start the Argus Engine

You can run Argus without opening the browser UI.

### Development

```bash
npm run start:engine
# or:
./argus start
```

### Production build

```bash
npm run build
npm run start:engine:prod
# or:
./argus start --prod
```

### Start through the CLI

```bash
npm run argus-cli -- start --headless
./argus start --headless
```

The default engine API address is:

```text
http://127.0.0.1:3000
```

The browser UI is optional. The engine can continue running without Vite or React.

---

## 2. Check engine status

```bash
./argus status
npm run argus-cli -- status
```

For health information:

```bash
./argus health
npm run argus-cli -- health
```

Trading readiness (LIVE readiness is currently **NO-GO** — that is expected):

```bash
./argus ready
```

The CLI communicates with the running Argus Engine over HTTP.

Daily Goal Campaign (optional; does not lower consensus — see `ARGUS_CAMPAIGN_TRACKER.md`):

```bash
./argus campaign   # formatted - see §4. Or via HTTP directly:
curl -s http://127.0.0.1:3000/api/v2/campaign/status
# PATCH /api/v2/campaign/settings  { campaignEnabled, budget, dailyTargetAmount, … }
```

Recent EventBus ring (observability; not a second brain):

```bash
./argus events
npm run argus-cli -- events
```

---

## 3. Portfolio and trading information

```bash
./argus positions
./argus trades
./argus orders
```

These commands read information from the running engine and its persistence layer.

---

## 4. Observability

```bash
./argus config
./argus risk
./argus agents
./argus events
./argus logs
```

These help inspect active configuration, RiskEngine state, agent availability, EventBus activity, and diagnostics.

### Java Quant Core (optional, advisory-only bridge)

```bash
./argus quant-core   # GET /api/v2/quant-core/health - connectivity + enabled state
./argus parity       # GET /api/v2/quant-core/parity  - recent shadow-parity divergences (>0.01%)
```

`quant-core` reports `DISABLED` unless `QUANT_JAVA_CORE_ENABLED=true`. `parity` reads real,
already-persisted divergence records from `observability_events` (written by
`QuantCoreBridge.ts`/`ParityComparator.ts`) — an empty list honestly means either the bridge is
disabled or no divergence has been recorded yet, never a fabricated row.

### Opportunity discovery

```bash
./argus discovery    # GET /api/v2/continuous-intelligence/status
```

Reports the real scan/shortlist/subscription state: last scan's scanned count and top movers,
shortlisted candidates (watchlist-subscribe only — **never** a second order path per
`CLAUDE.md`), and `MarketDataWorker`'s active subscription count against its configured cap.

### Consensus / funnel / strategy observability

```bash
./argus funnel                  # GET /api/v2/observability/trading-funnel - candidates, agent votes,
                                 # independence, calibration, RiskEngine/OMS/fills, top no-trade reasons
./argus consensus-shadow        # shadow consensus-mode comparison (read-only, does not vote)
./argus consensus-report        # GET /api/v2/observability/consensus-report - "why no trade" dashboard
./argus provider-health         # per-AI-provider health/cooldown/recent-call-rate matrix
./argus trading-funnel          # same report as `funnel`, explicit name
./argus why-no-trade [symbol]   # single-candidate "why did this not trade" explainer
./argus calibration-maturity    # UNVALIDATED/LEARNING/CALIBRATED/TRUSTED per (agent, bucket)
./argus agent-edge              # agent-edge / strategy-edge / trading-eligibility report
./argus strategy-readiness      # per-strategy readiness classification
./argus strategy-fairness       # organic strategy-selection fairness (setupScore concentration)
./argus strategy-profitability  # real net P&L per strategy from actual fill prices, never estimated
./argus rescue-outcomes         # did a temporary market-data rescue lead to consensus/RiskEngine/a fill?
./argus exploration-health      # Phase 18: joins each STRATEGY_EXPLORATION_PROMOTED promotion to
                                 # rescue grant/denial, idea discard/emission, consensus, RiskEngine,
                                 # and OMS/fill outcomes by shared traceId - a Level 0-6 success ladder
./argus rescue-occupants        # Phase 18: who currently holds a temporary-data-rescue slot, what
                                 # class (ROUTINE_RECOVERY/EXPLORATION/MARKET_MOVER), since when
./argus strategy-scorecard      # combined fairness + profitability + lifecycle status, all 21 strategies
./argus ai-cost-governor        # Project A: current policy, per-(agent,provider) real graded-
                                 # outcome quality ledger, and recent shadow-mode decisions - off by
                                 # default, never gates a trade
```

All of the above are read-only correlations over already-persisted `observability_events` /
`risk_assessments` / `trades` rows — none of them is a new decision path, and none can trigger a trade.
Add `--format=json` semantics are handled server-side (`?format=text` for the human-readable table,
omit for JSON) — these commands print the text form by default. See `docs/ARGUS_OPPORTUNITY_DISCOVERY.md`
for the rescue-fairness mechanism `exploration-health`/`rescue-occupants` report on.

### Daily Goal Campaign

```bash
./argus campaign     # GET /api/v2/campaign/status
```

Reports daily target progress, realized/unrealized P&L, the BUY soft-lock state, and the active
target-achieved policy (`CONTINUE` / `LOCK_AND_IDLE` / `TRAIL_STOPS_ONLY`). See
`ARGUS_CAMPAIGN_TRACKER.md`. Superseded the raw `curl` example from an earlier revision of this
file — same endpoint, now with a formatted CLI command.

---

## 5. Autobot controls

```bash
./argus enable
./argus disable
```

These commands do **not** bypass Argus safety protections. RiskEngine gates, trading state machine, reconciliation, paper/live separation, LIVE readiness, and kill-switch protections remain active. The CLI only sends a control request to the Argus Application layer.

---

## 6. Emergency stop

```bash
./argus kill-switch
```

Uses the existing engine kill-switch. The CLI does not implement a separate kill switch.

---

## 7. Engine lifecycle

```bash
./argus stop
./argus restart
```

Lifecycle uses the Argus engine PID/runtime infrastructure and graceful shutdown (`drainTradingProcess`), not a second PID scheme.

---

## 8. Historical Evaluation

Historical Evaluation runs **inside the Argus Engine**. The CLI submits the request over HTTP:

```text
argus-cli / ./argus
    │ HTTP
    ▼
Argus Engine
    │
    ▼
Historical Evaluation API
    │
    ▼
FullArgusReplayEngine
    │
    ├── Agents
    ├── ChiefTrader / Consensus
    ├── RiskEngine
    ├── PositionSizing
    ├── OMS
    └── HistoricalReplayBroker
```

The CLI does not independently execute the trading engine.

### Run

```bash
./argus replay run --capital 2000 --start 2025-01-01 --end 2025-12-31
```

No symbols are required when using the default **ARGUS_DISCOVERY** universe.

### List / report

```bash
./argus replay list
./argus replay report <runId>
```

### Explicit symbols

```bash
./argus replay run \
  --universe symbols \
  --symbols AAPL,NVDA \
  --capital 2000 \
  --start 2025-01-01 \
  --end 2025-12-31
```

Historical Evaluation must not shortcut:

```text
Agents → Consensus → RiskEngine → PositionSizing → OMS → HistoricalReplayBroker
```

### `--engine java` (a genuinely different tool, not an alternate replay backend)

```bash
./argus replay run --engine java --symbols SPY,QQQ,NVDA --start 2022-01-01 --end 2026-08-21 --target 100
```

This does **not** submit to the Historical Evaluation API above. It spawns
`quant-core-java`'s standalone demonstration backtest CLI as a local subprocess (building the jar
via `mvn -B package -DskipTests` on first use if missing) and streams its output — a genuinely
**different, simpler** backtest (`RsiThresholdStrategy` over real historical bars from
`data/argus.db`, read-only) with **zero** ChiefTrader / RiskEngine / PositionSizing / OMS /
HistoricalReplayBroker involvement. The CLI prints an explicit banner every time this flag is
used so the difference is never missed. Default (no `--engine` flag, or `--engine node`) is the
real Historical Evaluation path described above. See
`docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md` §4 (Phase 4) for why the 5 CORE
strategies aren't wired into this backtester yet (they need a feature-computation pipeline —
RegimeEngine/trend/volume/priceAction/supportResistance/MarketContext — not ported to Java).

---

## 9. Prediction-versus-reality analysis

Historical Evaluation is not merely “run → count trades → show P&amp;L.” Reports include decision funnel, agent availability, consensus mode, risk rejections, and post-run **AFTER-THE-FACT** missed-opportunity analysis. That analysis never feeds back into decisions.

A rejected candidate can still be recorded for counterfactual outcome analysis — that does **not** mean Argus should have taken the trade.

See [`ARGUS_HISTORICAL_EVALUATION.md`](ARGUS_HISTORICAL_EVALUATION.md).

---

## 10. Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARGUS_API_URL` | `http://127.0.0.1:3000` | Argus Engine HTTP API |
| `ARGUS_CLI_USER` / `ARGUS_CLI_PASSWORD` | — | Preferred credentials for `argus login` (never printed) |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | — | Fallback credentials for `argus login` (same as server) |
| `ARGUS_CLI_SESSION_FILE` | `data/.argus_cli_session` | Persisted `argus_session` cookie for CLI requests |
| `ARGUS_DEV_TOKEN` | Optional | Dev-only mutating token when **AUTH_PASSWORD is unset**. Ignored by the server when AUTH_PASSWORD is set — use `argus login` instead. |
| `QUANT_JAVA_CORE_ENABLED` | `false` | Gates `QuantCoreBridge.ts`'s connection to the optional Java Quant Core (fixed at loopback port 8085 — see `config/tradingSafety.json`'s `quantJavaCoreBaseUrl`, not yet independently configurable via env). Shadow-only even when true (a second, separate flag gates any live idea emission — see the migration blueprint). |

### Session auth (`AUTH_PASSWORD` set)

When the engine has `AUTH_PASSWORD` configured, `/api/*` requires a session cookie from `POST /api/v1/auth/login`. The CLI does **not** bypass this with `ARGUS_DEV_TOKEN`.

```bash
# Credentials from env (never logged). Prefer ARGUS_CLI_* or reuse AUTH_*.
export ARGUS_CLI_USER="$AUTH_USERNAME"
export ARGUS_CLI_PASSWORD="$AUTH_PASSWORD"

./argus login
./argus status
./argus logout
```

On HTTP 401 the CLI exits with code **5** and tells you to run `argus login` (or unset `AUTH_PASSWORD` for localhost-only no-auth mode).

---

## Architecture summary

```text
                    ┌──────────────────┐
                    │   Browser UI     │
                    │    Optional      │
                    └────────┬─────────┘
                             │ HTTP / WS
┌───────────────┐            ▼
│  ./argus CLI  │ ───HTTP──► ARGUS ENGINE :3000
│  (Bash shell) │            │
└───────┬───────┘            ├── Argus Core
        │                    ├── TradingEngine
        ▼                    ├── Agents / Consensus
  npm run argus-cli          ├── RiskEngine / OMS
  (TypeScript HTTP)          ├── BrokerManager
                             ├── Historical Evaluation
                             ├── SQLite (sole writer)
                             └── QuantCoreBridge ──HTTP──► Java Quant Core :8085
                                                            (optional, advisory-only,
                                                             no broker access, reads
                                                             SQLite read-only if at all)
```

## Core principle

> **One Core. One Trading Brain. One OMS execution boundary.**

The browser is optional. The CLI is optional. Both are adapters and clients. **The Argus Engine is the runtime that owns the trading system.**
