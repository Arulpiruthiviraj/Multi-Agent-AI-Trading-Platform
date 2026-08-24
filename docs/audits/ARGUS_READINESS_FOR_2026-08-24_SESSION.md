# ARGUS — Readiness Check for the 2026-08-24 (Monday) Trading Session

Concise status note, not a new full audit. Ground truth for LIVE/paper eligibility is still `evaluateLiveReadiness()` and the organic `trades`/`fills` tables — this file does not raise readiness scores, per CLAUDE.md.

## What this covers

Since the last real trading session (Friday 2026-08-21, see `docs/audits/ARGUS_CURRENT_STATE_AND_FRIDAY_SESSION_FORENSIC_AUDIT.md`), the following were fixed and verified in this repository. Nothing below changes `PAPER_TRADING_ONLY`, consensus floors, or `LIVE_NO_GO`.

## Fixes applied and verified

| Area | What was wrong (Friday 08-21 evidence) | Fix | Verification |
|---|---|---|---|
| Broker environment classification | `BROKER_ENVIRONMENT_UNKNOWN` killed 2 real manual-override orders (TSLA, RIOT) | `OrderManagement.ts` reads trading mode through `normalizeTradingMode()` (fail-safe default `PAPER`, never an unclassified string) | Unit tests green; confirmed still in place this session (`grep normalizeTradingMode` in `OrderManagement.ts`) |
| Capital allocation race | Two back-to-back BUY approvals inside the same evaluation window could jointly exceed `settings.budget` before OMS's async insert lands (documented, unfixed race from `ARGUS_CAPITAL_AUDIT_REPORT.md`) | New `src/server/engines/PendingCapitalReservations.ts` in-memory reservation, folded into RiskEngine gate 23 (`argus_capital_allocation`) before OMS commits, released on every `executeOrder` exit path | New test suite (7 tests) including a direct $1500+$1500-vs-$2000-budget reproduction; global `vitest.setup.ts` `afterEach` reset added after finding cross-test pollution |
| Quant cold-start / warm-up | `computeLiveStrategyWinRate()` treated any `sampleSize >= 1` (e.g. a 3-trade "100% win rate") as a fully trusted EV input, no minimum-sample floor | `QuantSignalAgent.ts` now gates on `sampleSize < MIN_SAMPLE_SIZE_FOR_KELLY` the same way it already gated zero-trade cold-start | `QuantSignalAgent.warmingUp.test.ts` (bootstrap-off regression), existing bootstrap-on test still green |
| Silent P&L attribution failure | An unattributable FILLED SELL left `profit_loss` null with only a raw `console.warn` | `OrderManagement.ts` now emits a structured `pnl_attribution_failed` observability event (never fabricates the number — still null) | New `OrderManagement.test.ts` case asserting the structured log fires |
| Replay fees/slippage | `FullArgusReplayEngine.ts` hardcoded `fees: 0, slippage: 0` in every trade-ledger row | Real per-order deltas from `session.broker.snapshotCosts()` | Existing replay suite green; sample replay run below shows non-fixture behavior intact |
| Replay Kronos disclosure | Kronos silently absent from replay's honesty report | Explicit `KronosForecastAgent: UNAVAILABLE` entry | Verified in `agentAvailability` output below |
| Replay PIT Agent Ledger | Fundamental/Macro/News were permanently hardcoded `UNAVAILABLE` in replay regardless of any real historical data | 3 new tables (`historical_macro_releases`, `historical_fundamental_snapshots`, `historical_news_archive`) + 3 loader/point-in-time-filter modules, wired into `FullArgusReplayEngine.ts`. NewsAgent casts a real vote from stored `sentimentScore` once archive data exists for the window; Macro/Fundamental surface as real point-in-time context (`DATA_LOADED_CONTEXT_ONLY`) but deliberately do **not** vote — see `config/replaySafety.json`'s `historicalPitAgentDisclosure` for why (that interpretive step is AIRouter's job live, not a hardcoded TS formula) | `src/server/replay/pitProviders.test.ts` (6 tests, proves zero lookahead per provider) + two live end-to-end sample replays run against the real DB — one with no PIT rows (all three correctly stay `UNAVAILABLE`), one with seeded rows (News → `AVAILABLE` real voter, Macro/Fundamental → `DATA_LOADED_CONTEXT_ONLY`); scratch rows deleted after |
| ChiefTrader telemetry gap | 4,400 consensus cycles vs 360 persisted `consensus_decisions` rows looked like a drop | Root-caused as intentional per-resolution-window collapse (correct), not a bug. Added a diagnostic-only interim-evaluation counter/log — no behavior change | `ChiefTraderAgent.test.ts` new case; 30/30 green in that file |
| `ORDER_EXECUTED` telemetry gap | 6 emits vs 4 real orders looked like duplication | Root-caused as intentional multi-emit-per-lifecycle-transition design (main finalization + legitimate follow-up poll) - documented, no code change | N/A (no defect) |
| IBKR historical replay provider showing unavailable after Settings said connected | Settings > Brokers correctly restores IBKR Gateway as the active broker on server boot (`BrokerManager.initialize()` reads `settings.selectedBroker`), but only `setActiveBroker()` (the mid-session switch path) called `applyMarketDataBinding()` — the step that registers the real `reqHistoricalData` bridge (`registerHistoricalBarProvider({id:'ibkr_gateway', ...})`). `initialize()` never called it, so after any restart with IBKR already selected, the bridge stayed unregistered and `HistoricalDataProviderRegistry.ts`'s `ibkrProvider` correctly (if confusingly) reported `DATA_PROVIDER_UNAVAILABLE`, and a replay with `dataProvider: 'ibkr'` failed `DATA_UNAVAILABLE` even though IB Gateway really was connected | `BrokerManager.ts`'s `initialize()` now calls `applyMarketDataBinding(this.activeBroker)` at the end of boot, same as the mid-session switch path — no new IBKR client, no loosened id matching, just the missing call to the bridge that already existed | `src/brokers/` suite (86/86), `HistoricalDataProviderRegistry.ibkr.test.ts` + `architecture.protection.test.ts` (30/30), full suite re-run |

## What is unchanged (and should stay that way)

- `evaluateLiveReadiness()` remains `LIVE_NO_GO`. Nothing above touches the 5-layer LIVE arm, `PAPER_TRADING_ONLY`, `consensusApprovalThreshold` (0.75), or `minIndependentAgreeingAgents` (2).
- Organic PAPER FILLED SELL P&L is still **0** — none of these fixes create or backdate a trade. Soak floors (`researchSafety.json`) are unmet.
- Friday's zero-organic-approval outcome was root-caused as *correct* consensus math (genuine Kronos-vs-Technical disagreement, `DISAGREEMENT_PENALTY` working as designed), not a defect — nothing here is expected to change trade frequency by itself.
- Java (`quant-core-java/`) remains advisory-only and inactive at runtime (`QUANT_JAVA_CORE_ENABLED=false`, `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED=false`). It is **not** "migration completed" — see `docs/audits/JAVA_QUANT_ENGINE_ARCHITECTURE_CORRECTION_AUDIT.md` for the honest PARTIAL verdict and `docs/audits/JAVA_MIGRATION_COMPLETION_PLAN_SUPPLEMENT.md` for the one real remaining blocker (`JMIG-001`, the shared feature-computation pipeline). CLAUDE.md's `## Java 26 Engine Authority` section now also explicitly requires future engine **bug fixes** (not just new features) to land in Java when a Java counterpart exists or is in progress.

## Test status

- `npx tsc --noEmit`: clean.
- `src/server/replay/` + `src/server/db/`: 132/132 passed.
- `src/server/replay/pitProviders.test.ts`: 6/6 passed.
- Full `npx vitest run`: launched this session; see the run's own completion notification for the final file/test counts rather than a number restated here (numbers go stale the moment a new test is added).

## Before Monday's open (unchanged pre-market checklist, CLAUDE.md §5)

1. Confirm Alpaca paper keys + MarketDataWorker WS OPEN before expecting `data_freshness` to pass.
2. Reconcile broker vs local before enabling Autobot; do not auto-resume a mismatch.
3. Confirm `GET /api/v2/live-readiness` still reports `LIVE_NO_GO`.
4. Expect `market_hours` to correctly FAIL until Alpaca's clock says open.
5. None of this session's fixes require a new operator action beyond the existing checklist.
