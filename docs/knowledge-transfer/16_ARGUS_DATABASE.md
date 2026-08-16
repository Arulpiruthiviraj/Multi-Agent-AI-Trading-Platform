# 16 — Database

Engine: better-sqlite3 + Drizzle, WAL, `data/argus.db` (gitignored). **44** `sqliteTable` exports in `src/server/db/schema.ts`. Import `db` from `index.ts` only (second process → false SQLITE_CORRUPT reports seen).

Backup: `GET /api/v2` or v1 export-db (checkpoint). Restore: octet-stream import + restart. Copy `data/.encryption_key`.

## Tables (purpose)

users, sessions — auth.  
settings — budget, Autobot, TP/trail, onboarding.  
kill_switch_events — audit.  
broker_connections — encrypted keys.  
ai_providers, ai_models, ai_usage, ai_calls — router + ledger.  
trades, fills — live path orders.  
daily_trading_summary — session stats.  
reconciliation_events, portfolio_snapshots, portfolio — holdings + recon.  
learned_rules, memory_rules, agent_memory — reflection.  
agent_predictions, agent_performance_stats, agent_confidence_calibration — weights/calibration.  
explainability_reports — narratives.  
event_traces — persist-listed events.  
news_articles, news_clusters, news_providers — news.  
kronos_predictions — forecasts.  
agent_routing_overrides — per-agent model.  
ohlcv_bars — history cache.  
backtest_runs, quant_strategy_backtests, quant_backtest_decision_log, quant_assessments — BT/quant.  
prediction_engine_weights, prediction_outcomes, training_examples — learning loop.  
escalation_decisions — AI escalation.  
transactions, consensus_decisions, consensus_evidence — observatory.  
risk_assessments, risk_gate_results — gates.  
openalice_verifications — MCP.  
external_data_cache — HTTP cache.

ER: settings 1—portfolio N; trades 1—fills N; risk_assessments 1—gate_results N; consensus_decisions 1—evidence N. Exact FKs: read `schema.ts` (SQLite often logical FKs).

Retention: not a TTL job for most tables — **CONFIGURATION-DEPENDENT / unbounded growth**.
