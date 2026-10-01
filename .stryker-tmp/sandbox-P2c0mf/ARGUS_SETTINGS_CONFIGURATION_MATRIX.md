# ARGUS Settings Configuration Matrix

Source of truth: `config/runtimeEnvCatalog.json`. This table is a human index; if they drift, the JSON wins.

Legend: **DB** = `config_overrides` allowed. **Secret** = never returned, never stored in overlays.

| ENV | Setting UI | DB override | Secret | Default | Safety | applyMode |
|---|---|---|---|---|---|---|
| QUANT_ENGINE_ENABLED | Quant Engine | yes | no | false | no | RESTART_REQUIRED |
| QUANT_ENGINE_INTERVAL_MS | Quant interval | yes | no | 300000 | no | RESTART_REQUIRED |
| QUANT_SMC_STRATEGY_ENABLED | SMC experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_VWAP_STRUCTURE_ENABLED | VWAP structure experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_ORB_STRATEGY_ENABLED | ORB experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_VWAP_REVERSION_ENABLED | VWAP reversion experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_DONCHIAN_STRATEGY_ENABLED | Donchian experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_MA_CROSSOVER_ENABLED | MA crossover experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_OSCILLATOR_MOMENTUM_ENABLED | Oscillator experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_BOLLINGER_VOLATILITY_ENABLED | Bollinger experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_PREVIOUS_PERIOD_BREAKOUT_ENABLED | Prev-period experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_CANDLESTICK_REVERSAL_ENABLED | Candle experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_GAP_STRATEGY_ENABLED | Gap experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_FIBONACCI_PULLBACK_ENABLED | Fib experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_VOLUME_CONFIRMATION_ENABLED | Volume experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_SR_BOUNCE_ENABLED | S/R experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_RELATIVE_STRENGTH_ENABLED | RS experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_STATISTICAL_REVERSION_ENABLED | Stat reversion experimental | yes | no | false | no | HOT_RELOAD |
| QUANT_BULL_BEAR_ENABLED | Bull/Bear notes | yes | no | false | no | HOT_RELOAD |
| QUANT_PAPER_TESTING_PARAMS | Paper-testing overlay | yes | no | false | no | HOT_RELOAD |
| ARGUS_MULTI_ASSET_ENABLED | Multi-asset engine | yes | no | false | no | HOT_RELOAD |
| ARGUS_PENNY_STOCK_ENABLED | Penny stock engine | yes | no | false | no | HOT_RELOAD |
| ARGUS_OPPORTUNITY_LOOP_ENABLED | Opportunity scanner | yes | no | false | no | HOT_RELOAD |
| ARGUS_PORTFOLIO_INTEL_ENABLED | Portfolio intel overlay | yes | no | false | no | HOT_RELOAD |
| OPENALICE_ENABLED | OpenAlice | **no** (construct-time) | no | false | no | BOOT_ONLY |
| ENABLE_VIBE_TRADING_MCP | Vibe orchestrator | no | no | false | no | BOOT_ONLY |
| ENABLE_AUTOHEDGE_WORKER | AutoHedge orchestrator | no | no | false | no | BOOT_ONLY |
| ENABLE_OPENALICE | Spawn OpenAlice | no | no | false | no | BOOT_ONLY |
| ENABLE_FINCEPT_TERMINAL | Fincept orchestrator | no | no | false | no | BOOT_ONLY |
| ARGUS_SKIP_CHRONOS / OLLAMA / OPENALICE / IBKR | Launcher skips | no | no | false | no | BOOT_ONLY |
| OLLAMA_HOST / LOCAL_AI_SERVICE_* | Local AI URLs | no | no | see catalog | no | BOOT_ONLY |
| ACTIVE_LLM | LLM hint | no | no | gemini | no | BOOT_ONLY |
| ALPACA_DATA_STREAM_URL | IEX URL | no | no | (built-in) | no | RECONNECT_REQUIRED |
| ARGUS_TRADING_MODE | Env preselect | no | no | PAPER | demoted by PAPER_TRADING_ONLY | BOOT_ONLY |
| PAPER_TRADING_ONLY | Paper-only lock | **no** | no | true | **yes** | SAFETY_CRITICAL |
| IBKR_GATEWAY_URL | Gateway URL | no | no | localhost:5000 | no | RECONNECT_REQUIRED |
| ARGUS_DB_PATH | SQLite path | **no** | no | data/argus.db | **yes** | BOOT_ONLY |
| NODE_ENV | Node env | **no** | no | development | **yes** | BOOT_ONLY |
| AUTH_USERNAME | Auth user | **no** | no | (unset) | **yes** | BOOT_ONLY |
| AUTH_PASSWORD / AUTH_SESSION_SECRET / ENCRYPTION_SECRET | Auth/crypto | **no** | **yes** | (unset) | **yes** | BOOT_ONLY |
| ALPACA_API_KEY / ALPACA_SECRET_KEY | Alpaca | **no** | **yes** | (unset) | **yes** | RECONNECT_REQUIRED |
| GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / others | LLM keys | **no** | **yes** | (unset) | **yes** | RESTART_REQUIRED |
| ALPHAVANTAGE / POLYGON / FINNHUB / FMP / FRED | Data keys | **no** | **yes** | (unset) | **yes** | RESTART_REQUIRED |
| COINBASE_* / QUESTRADE_* | Other brokers | **no** | **yes** | (unset) | **yes** | RECONNECT_REQUIRED |
| ALERT_WEBHOOK_URL | Alert URL | **no** | **yes** | (unset) | **yes** | RESTART_REQUIRED |

## Remaining `process.env` reads (intentional)

Still read `process.env` directly (classified, not Settings-overridable):

- Secrets and broker keys (Alpaca, AV, LLM, Coinbase, Questrade)
- `PAPER_TRADING_ONLY` (`tradingModeEnv.ts`, AlpacaBroker, BrokerManager)
- `ARGUS_DB_PATH` (must resolve before the overlay service exists)
- `AUTH_*`, `NODE_ENV`, bind host, encryption
- Launcher/orchestrator scripts (`scripts/ecosystem-dev.ts`, `devWithOpenAlice.ts`)
- OpenAlice constructor (`OPENALICE_ENABLED` at construct time)
- Tests

Overridable flags used by agents/strategies go through `isRuntimeFlagEnabled`.

## Unused / weakly used (identified, not deleted)

`.env.example` still documents keys that may only hit `SECRET_SPECS` or sibling launchers: `MISTRAL_API_KEY`, `KIMI_API_KEY`, `GROK_API_KEY`, `POLYGON_API_KEY`, path overrides (`VIBE_TRADING_PATH`, …). They remain valid env bootstrap. They are not live RiskEngine inputs.

`PORT` remains unused (listen stays 3000) — unchanged.

## Existing `settings` table (not this overlay)

`takeProfitPct`, `trailingStopPct`, `budget`, `tradingMode`, `autoBotEnabled`, `selectedBroker`, `selectedAiProvider`, pipeline agent JSON, strategy-engine mode, etc. continue to use `GET/POST /api/v1/config/settings` (also mounted as `GET/POST /api/v1/settings` — same `configRouter`). Dual-config does not migrate those columns into `config_overrides`. Phone Settings writes the TP/stop/broker/LLM-preselect fields through that settings row, not overlays.
