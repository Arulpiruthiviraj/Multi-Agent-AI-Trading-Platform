# Argus documentation audit

Date: 2026-08-18. Scope: forensic debugging + database documentation under `docs/`. **No trading/schema/config behavior changes** in this pass except pointer lines in `README.md` and `CLAUDE.md`.

This set is **not 100% complete**. Runtime UI, chaos/webhook routes, research warehouse scripts, and sibling engines were not exhaustively traced listener-by-listener.

---

## 1. Database tables discovered

| Source | Count |
|---|---|
| `sqliteTable(` in `src/server/db/schema.ts` | **58** CODE-VERIFIED |
| Live `data/argus.db` `sqlite_master` (readonly, 2026-08-18) | **56** DATABASE-VERIFIED |
| Delta | Live DB missing `config_overrides`, `config_change_events` (Drizzle `0040_config_overrides.sql` not applied to this file) |

SQL foreign keys: **0**. Unique indexes: 4 named (plus PK uniqueness).

---

## 2. EventBus events discovered

**79** unique string names in `config/eventNames.json` after dropping `persist` / `$comment`. Duplicate JSON keys: `SYSTEM_ANOMALY`, `SERVER_LOG`.

`persist[]` is the EventStore **subscribe** list, not a guarantee of SQLite writes (`MARKET_DATA` subscribed then skipped).

---

## 3. Agents documented

**16 named** in `ARGUS_AGENT_FORENSICS.md`, classified:

| Class | Names |
|---|---|
| LIVE idea | TechnicalAgent, KronosForecastAgent, FundamentalAgent, MacroAgent, NewsEngine (ideas default off), QuantSignalAgent (flag off) |
| Always-on | ChiefTraderAgent, RiskEngine/RiskAgent, OMS, PortfolioMonitor/PortfolioManager, MarketDataWorker |
| Supporting | ReflectionEngine, ExplainabilityAgent, Bull/Bear (flag), OpenAlice (advisory) |
| Not a live voter | MarketRegimeAgent, strategiesEngine |

UI-only non-classes (SentimentAgent, OrderFlowAgent) noted as absent.

---

## 4. Services documented

**42** non-test modules under `src/server/services/*.ts` catalogued at file-name level. Spine services read in source: ChiefTrader, EvidenceAggregator, RiskAgent, OrderManagement, PortfolioMonitor, PipelineFlatten, PortfolioRebalance, MarketDataWorker, ReflectionEngine, TransactionRegistry, EventStore, DiagnosticService, plus `RiskEngine`, `NewsEngine`, `BrokerManager`.

Not every helper (RemoteOperations, AgentSynergy, …) has a dedicated forensic section — **undocumented depth**.

---

## 5. Brokers documented

**6:** InternalPaper, Alpaca, IBKR, Coinbase, Questrade, HistoricalReplay.

---

## 6. Diagnostic endpoints documented

**29** rows in `ARGUS_DAILY_FORENSIC_CHECKLIST.md` (health/ready + diagnostics + traces + observability + recon + desk). Other API routes exist and were **not** fully inventoried.

---

## 7. SQL forensic queries created

**18** scripts (`01`–`17` as requested + `18_integrity_checks.sql`) plus `docs/sql/README.md`.

Readonly execution against `data/argus.db`: **all statements parsed and ran** (empty result sets for placeholder IDs still count as schema-valid). DATABASE-VERIFIED column names.

---

## 8. Relationships documented

ER in `ARGUS_DATABASE_ARCHITECTURE.md`: ~**18** application-level joins (transactions↔consensus↔risk↔trades↔fills, traces, recon snapshots, config overlay). **Zero** SQL FKs claimed.

---

## 9. Tests inspected

Read or grepped (not the full vitest suite):

- `EvidenceAggregator` (math in source; tests exist)
- `ChiefTraderAgent` (eval paths in source)
- `deskIntelligence.test.ts` (newsEmitsTradeIdeas false)
- `RiskAgent.transactionLifecycle.test.ts`
- `PortfolioRebalance.ts` vs CLAUDE 501
- `phase21.invariants.test.ts` cited for sole `placeOrder`
- `pipelineAgentSnapshot` comments
- Config JSON tests implied by fail-boot loaders

**Not inspected:** majority of `*.test.ts` files. Do not cite a remembered test count.

---

## 10. Undocumented / partial components

- Full `/api/v1` surface (webhooks, chaos, autobot evolve, news CRUD)
- Vite SPA tab internals beyond honesty notes
- `ai_models` leftover metric columns
- Whether `daily_trading_summary` always tracks `trades.profit_loss`
- Exact TechnicalAgent strategy predicates (beyond RSI/MACD/BB emit reasons)
- Every EventBus producer for non-spine events
- Chronos HTTP payload schema
- Migration 0040 unapplied on the inspected live DB

---

## 11–12. Contradictions (docs vs code)

| Topic | Older docs | Current code |
|---|---|---|
| Tabs | Older CLAUDE.md “21 tabs” including `deployment` | **Corrected:** `AppTabId` / `ALL_TABS` = **20**; no `deployment` tab (`responsiveNavConfig.ts`). Phone layout is **6** tabs including Settings. |
| Rebalance | Older CLAUDE.md live path “Rebalance: 501” | **Corrected:** `PortfolioRebalance.ts` submits pipeline ideas through RiskEngine/OMS |
| Trailing stop | Name `trailingStopPct` / EXIT_CODE=TRAILING_STOP | Cost-basis vs `average_price`, not peak trail (`PortfolioMonitor.ts`) |
| Scaling out | Reasoning string | Full-position SELL idea |
| MARKET_DATA persist | `eventNames.json` persist[] includes it | `EventStore` `NO_PERSIST_TYPES` skips SQLite |
| Schema vs live DB | schema 58 tables | inspected `argus.db` 56 tables (no config overlay tables yet) |
| Historical consensus | `agreements_count=1` approved rows in older forensic notes | Current code requires min 2 independents excluding ConsensusDebate |

---

## 13. UNVERIFIED / PARTIAL / UNWIRED

- OMS writing status string `PARTIALLY_FILLED` on every adapter — PARTIAL  
- `daily_trading_summary` sync — PARTIAL  
- `transactions.outcome` WIN/LOSS completeness — PARTIAL (historical stale-process bug documented in TransactionRegistry)  
- Torn consensus/risk inserts without `db.transaction()` — failure mode CODE-VERIFIED possible, not reproduced here  
- Opportunity loop / penny overlay default-off paths — DISABLED / not exercised  
- Coinbase funded-account verification — UNVERIFIED  
- Exact listener list for every one of 79 events — PARTIAL  

---

## 14. Recommended future documentation

1. Apply/verify migration 0040 on operator DBs; re-count tables.  
2. Generate the 58-table column dump from `PRAGMA table_info` after migrate, commit as an appendix.  
3. ~~Fix CLAUDE.md stale “21 tabs” and “Rebalance: 501”~~ **done** (contract + `docs/ARGUS_MOBILE_SETTINGS.md`).  
4. EventBus producer grep table for the 79 names.  
5. Keep `docs/sql/` queries in CI against a temp migrated schema (read-only).  

---

## Confirmation

No RiskEngine, OMS, broker, consensus threshold, Autobot, LIVE, or schema files were modified for this documentation task. Git should show `docs/**`, `README.md`, `CLAUDE.md` pointer edits only (plus this audit).
