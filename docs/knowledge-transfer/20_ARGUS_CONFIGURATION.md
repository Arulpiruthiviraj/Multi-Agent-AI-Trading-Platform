# 20 — Configuration

## Env (see `.env.example`; not every key has a class)

**Secrets:** ALPACA_*, GEMINI/OPENAI/DEEPSEEK/NVIDIA, ALPHAVANTAGE, POLYGON, FINNHUB, FMP, FRED, AUTH_PASSWORD, AUTH_SESSION_SECRET, ENCRYPTION_SECRET, Coinbase CDP, Questrade OAuth, IBKR path.

**Flags:** QUANT_ENGINE_ENABLED, QUANT_*_STRATEGY_ENABLED (see `quantExperimentalStrategies.json`), QUANT_BULL_BEAR_ENABLED, OPENALICE_ENABLED + OPENALICE_MCP_URL, PAPER_TRADING_ONLY, ARGUS_SKIP_*, LOCAL_AI_SERVICE_URL.

**Ecosystem (orchestrator only — [CONFIG.md](../CONFIG.md)):** `VIBE_TRADING_PATH`, `AUTOHEDGE_PATH`, `OPENALICE_PATH`, `FINCEPT_TERMINAL_PATH`, `ENABLE_VIBE_TRADING_MCP`, `ENABLE_AUTOHEDGE_WORKER`, `ENABLE_OPENALICE`, `ENABLE_FINCEPT_TERMINAL`, `FINCEPT_CMD`. AutoHedge child always gets empty `WALLET_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY`.

**PORT:** **unused**. Fail if absent: production AUTH; tradingSafety required JSON keys **fail boot**. Bind `127.0.0.1` when `AUTH_PASSWORD` unset.

## JSON (`config/`, loadRepoConfigJson)

tradingSafety.json, eventNames.json, agentWeights.json, markets.json, smcConfluence.json, thesisInvalidation.json, noTradeReasons.json, bullBearResearch.json, consensusFixtures.json, quantExperimentalStrategies.json, quantStrategyTaxonomy.json.

Not API/UI knobs. Tests must load the same files.
