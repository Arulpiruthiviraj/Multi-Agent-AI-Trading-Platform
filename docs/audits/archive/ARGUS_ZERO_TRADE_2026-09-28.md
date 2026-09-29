# Argus zero-trade incident — September 28, 2026

Incident date: September 28, America/New_York (EDT, UTC−04:00). Deployment verification continued at 22:xx EDT (September 29 UTC). This is a dated forensic snapshot; the living architecture remains `docs/architecture/ARGUS_ARCHITECTURE.md`.

## Finding

Argus was discovering symbols and calculating assessments, but the entry gate suppressed ideas before ChiefTrader and RiskEngine. Runtime showed `TRADING_ENABLED`, Autobot enabled, `interruptedSessionHold=true`, and `liveIdeaGenerationEnabled=false`. Broker synchronization was stuck at `FAILED`, so the reconciliation worker repeatedly skipped. This is not evidence that consensus thresholds or risk limits were too strict.

A controlled restart reproduced a concrete startup cause: the production database lacked `crypto_paper_broker_state`, `crypto_paper_orders`, and `crypto_paper_positions`. Crypto paper is initialized in the all-adapter startup loop even when the saved broker is Alpaca. The missing tables caused initialization to fail before normal broker selection.

The missing tables were caused by migration ordering, not a missing SQL file. `0078_skinny_mockingbird` has journal timestamp 1790593282631, below already-applied 0077's 1790600000000. The installed Drizzle migrator uses the latest database timestamp as a watermark, skipping 0078 on that upgrade path. A fresh database applies it, which explains why fresh-database tests passed. A separate reconnect defect allowed successful later adapter activation without resetting `FAILED`; reconciliation could then remain blocked indefinitely.

The original morning initialization exception was not retained by the old durable logs. The missing schema, deployed watermark, reproduced startup error and recovery after repair are verified. Attribution of that same exception to the original morning boot is strongly supported, but its original stack trace is unavailable.

## Date-scoped evidence

Read directly from production SQLite using a read-only connection, without importing application DB bootstrap. Runtime evidence used authenticated local GET endpoints. No account identifiers or credentials are included.

Regular session window: [2026-09-28T13:30:00.000Z, 2026-09-28T20:00:00.000Z), i.e. 09:30–16:00 EDT.

- 2,496 persisted quant assessments across 91 symbols; every `emitted_trade_idea` was false. The assessment EventBus count independently agreed.
- 4,576 discovery-admitted events across 409 symbols. These are repeated discovery events, not 4,576 executable opportunities.
- 1,602 `DESK_NO_TRADE` events across 57 symbols. Older generic reasons did not explain every withheld candidate.
- 79 `RECONCILIATION_WARMUP` events, zero `RECONCILIATION_MATCH`.
- Zero `TRADE_IDEA_GENERATED`, `CONSENSUS_TERMINAL_REASON`, consensus decision rows, risk assessment rows, trade rows, fill rows or reconciliation rows.

Earlier intraday snapshot: [04:00Z, 19:58Z), midnight–15:58 EDT, contained 4,016 quant assessments across 95 symbols, all non-emitting; 5,813 discovery-admitted events across 485 symbols; 100 reconciliation warmups; and zero ideas/decisions/risk/trades/fills/reconciliation rows. This cutoff is two minutes before the close and is not interchangeable with the completed regular-session window above.

The dirty-session event at 11:40:38.114Z referenced the prior process's last heartbeat at 03:22:18.397Z. A recorded resume event at 11:42:08.563Z did not release the reconciliation-dependent entry hold. Before recovery, the most recent persisted reconciliation was 03:17:34.822Z, which belongs to September 27 at 23:17 EDT, not the September 28 trading session.

At 19:50:59.897Z, the live feed had 12/12 subscribed symbols with valid fresh quotes, while the broker readiness check failed. That proves partial active-feed availability, not coverage of the whole discovered universe. At 20:02:41.638Z, the active Alpaca portfolio endpoint returned HTTP 200 in 261 ms with no positions, while the broker synchronization latch still prevented reconciliation.

## Repairs

1. **Forward migration 0079:** creates the three missing crypto paper tables and indexes if absent. Preserves existing broker balances, positions and orders. Does not change historical SQL/journal timestamps or manually edit the migration ledger.
2. **Broker activation recovery:** successful explicit authentication/binding transitions to READY before the existing reconciliation path. Concurrent activation/initialization/reconciliation cutovers are rejected. Invalid IDs leave the existing synchronization state unchanged. A rejected replacement does not disconnect the prior adapter.
3. **Boot authentication:** a false adapter authentication return now fails initialization instead of being silently treated as success.
4. **Durable diagnostics:** broker initialization failure records stage, adapter and error class without secrets. Activation records the prior/current state. Event persistence retains synchronization state, transition states and refusal codes.
5. **Readiness and refusal visibility:** a separate Entry Generation check exposes restart/pause/Autobot/checkpoint holds. Quant candidates withheld by the entry or agent gate now emit an explicit refusal reason instead of silently disappearing.

No strategy calculations changed. Consensus remains 0.75 with the existing independence policy; risk, sizing, OMS, broker order authority, reconciliation and LIVE arming remain intact. No fabricated match, price, vote, approval or order was introduced.

## Regression evidence

- Final focused readiness/broker/telemetry/quant-refusal run: 34 tests passed.
- Related runtime/restart/architecture/reconciliation suites: 89 tests passed.
- Migration repair, journal guard, crypto broker and broker recovery suites: 41 tests passed. These include upgrade from the production timestamp watermark, existing populated ledger preservation, fresh full-journal migration, repeated migration and unique client-order protection.
- Isolated rerun of the three files implicated by the first broad run: 21 tests passed.
- Typecheck: passed, including a final run after migration tests were added.
- Production build: passed. Existing chunk-size/import warnings remain.
- Whitespace/error check: passed.
- Completed full-suite rerun: **594 files / 4,559 tests passed**, exit 0, 687.47 seconds. The new three-case migration test file was added after full-suite file discovery and is covered by the separate 41-test migration run above; it is not included in the 594-file total. Local command logs: `.argus-sep28-final-full-suite.log`, `.argus-sep28-migration-tests.log`, `.argus-sep28-migration-typecheck.log`, `.argus-sep28-final-build.log`.

The first broad run is retained as a failure, not relabeled: 4,555 passed and 3 failed. Two failures loaded code before the final fixes landed; both passed on the final-code rerun. The third was the catalog route's already-documented 15-second full-run timeout and passed in isolation. Full-run evidence above is separate from that rerun.

Broker recovery tests use the real manager/reconciliation/session listener with isolated SQLite and a fixture provider; match/mismatch/unreachable/auth-rejection paths retain paused state and never submit orders. Quant refusal tests use the existing strategy fixture and prove the gate/diagnostic behavior, not organic alpha or a full market-to-fill path.

## Deployment and operational state

Two normal CLI graceful stop/start cycles were used, without `--enable-trading` or `resume`. The first deployed the new diagnostics and exposed the crypto initialization error at 2026-09-29T02:17:12.183Z (`INITIALIZE_ADAPTER`, `crypto_paper`, `SqliteError`). The second applied 0079 through the ordinary boot migrator.

Verified after the second restart:

- Engine PID 28476; clean predecessor shutdown; persisted broker selection Alpaca, PAPER mode.
- Migration watermark 1790648400000 and all three expected crypto paper tables present.
- Runtime broker readiness `alpaca: Healthy`.
- Real production reconciliation at 2026-09-29T02:22:04.467Z: Alpaca, matches=1, action_taken=null. The corresponding match event persisted at 02:22:04.880Z.
- Runtime entry readiness explicitly blocked by `TRADING_PAUSED`; no resume was issued. The interrupted-session hold is false following the clean restart; that alone is not reconciliation proof—the separate real match above is.
- Existing watchdog remains running (PID 23116).
- Live-readiness endpoint at 02:22:59.377Z returned `LIVE_NO_GO`, live eligibility FAIL, empirically justified to risk capital=false.

## Remaining limits and next operator action

The verified startup/recovery defects are repaired and deployed. The application remains PAUSED. Resume supervised PAPER through the normal operator route only after reviewing current reconciliation and feed readiness; do not change trading state directly or bypass a refusal. Fresh quote coverage was 0/12 at 22:22 EDT, outside the regular session. The next trading session must supply fresh quotes and organic decisions before trading effectiveness can be assessed.

Other observed conditions are not claimed fixed: AI quota/credit/rate-limit/provider failures (only 1/10 providers healthy in the intraday snapshot), earlier IBKR entitlement/history errors, and a 12-symbol active Alpaca feed cap. They were not the immediate all-day zero-idea explanation. Reflection telemetry also showed multi-second scans over large history tables and occasional slow authenticated diagnostics; causality and a safe performance change were not established. Fourteen malformed Java volatility responses were rejected fail-closed; this audit did not establish their numerical root cause.

No organic trade or profitable strategy was demonstrated by these repairs. They restore correct startup/recovery and make blocked entry state visible; they do not guarantee that a valid trading opportunity exists.

Pre-existing architecture-document edits and the untracked AI-outage integration test from other work were preserved. Changes from this incident are not committed.

