# Backtest & Replay Engine Parity Audit

Read-only audit. No code changes. Scope: `src/server/replay/FullArgusReplayEngine.ts` (read in full,
1423 lines), `src/brokers/HistoricalReplayBroker.ts` (read in full, 289 lines), `src/server/engines/RiskEngine.ts`'s
replay-branching logic (grepped and read in context, not the full 24-gate body line-by-line — the
non-replay behavior of each gate is taken from `docs/architecture/ARGUS_ARCHITECTURE.md (Risk Engine Gates section)`/`CLAUDE.md`,
already verified against this file earlier in this session, not re-derived here). `BacktestEngine.ts`
(1008 lines, TS `SAME_BAR_CLOSE` engine) and `JavaBacktestEngine`/`quant-core-java`'s backtest package
were **not** re-read line-by-line this pass — their scope and disclosed limitations were already
established earlier this session (building/testing them) and are cited, not re-verified, below. Where
a claim is not backed by a citation in this document, it is carried forward from that earlier,
in-session verification and marked as such.

There are, in this codebase, **three separate, non-interchangeable simulation systems** — conflating
them is the single most common source of overclaiming in prior documents, so this audit keeps them
apart throughout:

| System | File | Fill model | Status |
|---|---|---|---|
| **Argus Historical Evaluation (MODE B)** — the one this audit is about | `src/server/replay/FullArgusReplayEngine.ts` | NEXT_BAR_OPEN | Reuses real ChiefTrader vote-math/RiskEngine/OMS against `HistoricalReplayBroker` |
| Research backtest engine | `src/server/engines/backtest/BacktestEngine.ts` | SAME_BAR_CLOSE | TA-rule-based, no AI, long-only, explicitly non-promotable per `CLAUDE.md` |
| Java Quant Core backtest | `quant-core-java/.../backtest/engine/JavaBacktestEngine.java` | Configurable | Advisory-only, isolated, built and disclosed earlier this session (real 27,438-bar/31-symbol inventory, not the spec's assumed 1M-bar scale) |

## 1. Parity Scorecard

| Dimension | Live | Replay (MODE B) | Verdict |
|---|---|---|---|
| TechnicalAgent | Real RSI/MACD/BB via `TechnicalAgent.ts` | Real, via `evaluateReplayTechnical`/`replayArgusStrategy` on point-in-time closed bars | **PARITY** |
| QuantEngine (CORE strategies) | Real, `evaluateAll()` | Real, same strategy modules replayed via `replayArgusStrategy` | **PARITY** (CORE only; experimental strategies follow the same env-flag rule as live) |
| **NewsAgent** | Real RSS + paid APIs, optional LLM | **Fixture-only.** `FullArgusReplayEngine.ts:624-628`: `golden_replay` fixture path gets a PIT-filtered fixture feed explicitly labeled `'not a live NewsAgent voter'`; any real historical window gets `'Historical news unavailable. NewsAgent excluded from this replay.'` | **GAP — disclosed, not fabricated** |
| **FundamentalAgent** | Real, AlphaVantage + AIRouter | `FullArgusReplayEngine.ts:630`: `{ status: 'UNAVAILABLE', reason: 'Point-in-time fundamentals not loaded' }` — always, unconditionally | **GAP — disclosed** |
| **MacroAgent** | Real, AlphaVantage + AIRouter | `FullArgusReplayEngine.ts:631`: `{ status: 'UNAVAILABLE', reason: 'Point-in-time macro releases not loaded' }` — always, unconditionally | **GAP — disclosed** |
| KronosForecastAgent | Optional, local Chronos | Not referenced anywhere in `FullArgusReplayEngine.ts` (0 matches) | **GAP — absent, not disclosed via an explicit status field the way Fundamental/Macro are** (see §3) |
| OpportunityDiscovery / OpportunityScreener | Real, watchlist-only voting | `FullArgusReplayEngine.ts:649`: explicitly does not run inside the replay clock — universe is fixed at replay creation, never organically discovered | **PARITY BY DESIGN** (both are correctly out of scope for a fixed-universe replay; not a fidelity failure, a scope boundary) |
| ChiefTrader consensus math (0.75 / 2 agents) | Real | Real — `replayChiefTraderFromEvidence` (`PitReplay.ts`) reuses the same vote math; `resolveReplayAiModeConsensus`/`mergeLiveConsensusDebateVote` (`replayAiModeConsensus.ts`) handle AI-mode debate parity | **PARITY**, but the pool of independent voters it draws from is structurally smaller than live (see NewsAgent/Fundamental/Macro/Kronos rows above) |
| RiskEngine (24 gates) | Real | **Real, same `RiskEngine.evaluateRisk()` call** (`FullArgusReplayEngine.ts:158`) | **PARITY**, with documented gate-level substitutions (see §2) |
| OMS | Real | **Real, same `OrderManagementService` singleton** (`FullArgusReplayEngine.ts:66,72`) — `RISK_ASSESSMENT_COMPLETED → executeOrder` wiring is literally the live wiring, not a replay-only copy | **PARITY** |
| Broker | AlpacaBroker/IBKR | `HistoricalReplayBroker` — MARKET orders only, real spread/slippage/commission (`applyFillPrice`), volume-participation cap, partial fills, session/extended-hours gating, short-selling gate, cash/buying-power checks | **PARITY** — see §4 for the one real nuance (LIMIT/STOP order types) |
| Daily Goal Campaign | Real, `CampaignTracker.ts` | **Not present anywhere in `FullArgusReplayEngine.ts`** (0 matches for "campaign") | **GAP — undisclosed in the TS replay path** (a *separate*, Java-side `CampaignPolicySimulator.java`, built earlier this session, simulates policy triggers against a trade list — but it is not wired into real replay execution; see §3) |
| Portfolio equity/cash/P&L per bar | Real | Real — `HistoricalReplayBroker.portfolio()`/`snapshotCosts()` computed every fill | **PARITY** |

## 2. Risk Engine Gate Parity Detail (grepped/read from `RiskEngine.ts`, not asserted from memory)

| Gate | Live behavior | Replay behavior | Source |
|---|---|---|---|
| `emergency_stop` | `tradingEngine.state.tradingState` | Forced `'TRADING_ENABLED'` — research clock always runs | `RiskEngine.ts:263-265` |
| `autobot_enabled` | `tradingEngine.state.enabled` | `replaySafety.allowBuysInReplay` config flag | `RiskEngine.ts:274` |
| `same_symbol_cooldown` / dedup queries | Full-table `trades` scan | Scoped to `replay.replayId` via `LIKE` on `traceId`/`reasoning` — a real perf fix disclosed in the file's own comment (avoids re-fetching the whole table every evaluation on a long replay) | `RiskEngine.ts:285-296` |
| `duplicate_signal` | Real dedup window | Explicitly `skipped: true`, `reason: 'replay_session_uses_openStops_dedup'` — replay dedupes via its own `openStops` map instead | `RiskEngine.ts:305-311` |
| `daily_loss` | `tradingEngine`-derived budget/limit | `replay.config.allocationBudget`/`replay.config.maxDailyLoss` — correctly isolated from live capital | `RiskEngine.ts:352-359` |
| `order_rate_limit` | Real `maxOrdersPerMinute` check | **Always passes**, `skipped: !!replay` — a MAX-speed replay can evaluate many bars within one wall-clock minute, so this gate is a live-only concern | `RiskEngine.ts:474-485` |
| `market_hours` | Real Alpaca `/v2/clock` | Session classifier (`classifyMarketSession`/`sessionAllowsFills`) or an assumed-open daily-bar path for 1Day frequency | `RiskEngine.ts:490-500` |
| `data_freshness` | Real tick age vs `stalePriceThresholdMs` | **Always** `priceAgeMs: 0, passed: true` — "Replay uses last completed bar at T; daily age is not live-tick staleness" | `RiskEngine.ts:507-515` |
| `news_veto` | Real `news_clusters` lookup | Real gate logic, but sourced from `newsVisibleAt(replay.news, replay.cutoff, symbol)` — a genuine point-in-time check, **but only ever populated when a historical news source is actually loaded** (golden_replay fixture only, per §1's NewsAgent row) | `RiskEngine.ts:525-537` |
| `argus_capital_allocation` | `settings.budget` | `replay.config.allocationBudget`, scoped `trades` query by `replay.replayId` | `RiskEngine.ts:625-634` |

**Net assessment:** every gate still executes and is recorded (no gate is silently bypassed), but 3 of
the 10 sampled here (`duplicate_signal`, `order_rate_limit`, `data_freshness`) are structurally
incapable of ever failing in replay, and `news_veto` is vacuously-always-pass outside the golden_replay
fixture. This is a genuine, disclosed set of divergences — not a defect, since each substitution has an
explicit, sound rationale in the code's own comments — but it means a replay's gate-rejection funnel is
**not** a like-for-like comparison against a live session's funnel (e.g., the Friday audit in
`ARGUS_CURRENT_STATE_AND_FRIDAY_SESSION_FORENSIC_AUDIT.md` found real `data_freshness` and
`duplicate_signal` rejections live — replay could never reproduce those specific rejections by
construction, not because the underlying condition didn't occur in the replayed window).

## 3. Gaps & Discrepancies Inventory

1. **FundamentalAgent, MacroAgent: structurally absent from every replay run**, not feature-flagged or
   partially degraded — `FullArgusReplayEngine.ts:630-631` unconditionally reports them
   `UNAVAILABLE`. This is disclosed *in the code's own honesty-report output*, which is good practice,
   but it is not disclosed anywhere in `ARGUS_HISTORICAL_EVALUATION.md`/`docs/ARGUS_REPLAY_USER_GUIDE.md`
   as a headline caveat (not independently re-read this pass to confirm the exact wording of those
   docs — **NOT VERIFIED** whether they already say this).
2. **NewsAgent: real only for the golden_replay fixture; excluded for any real historical window.**
   Same file, lines 624-628.
3. **KronosForecastAgent: zero references anywhere in `FullArgusReplayEngine.ts`.** Unlike
   Fundamental/Macro, there isn't even an explicit `UNAVAILABLE` status field for it in the honesty
   report at that line range — it appears to simply not exist as a concept in replay at all, rather
   than being explicitly excluded. This is a smaller, more silent gap than the Fundamental/Macro one
   and is worth an explicit `KronosForecastAgent: UNAVAILABLE` entry for consistency, if the intent is
   parity in *disclosure* even where parity in *function* isn't achievable.
4. **OpportunityDiscovery/OpportunityScreener not running in replay is by design**, not a gap — a
   fixed-universe replay has no discovery to do. Flagged here only to close out the request's explicit
   question, not as a remediation item.
5. **Daily Goal Campaign has no representation in `FullArgusReplayEngine.ts` at all.** The only
   campaign-policy simulation in this codebase is the Java `CampaignPolicySimulator` built earlier this
   session — advisory-only, operates on an already-produced trade list grouped by NY day, and its own
   header comment discloses that `TRAIL_STOPS_ONLY` and `LOCK_AND_IDLE` produce identical results in
   that simulation (a disclosed simplification layered on top of an already-absent integration). A
   multi-month replay today cannot answer "would the campaign's soft-lock have changed this session's
   outcome" — it can only be approximated after the fact in a separate, non-integrated tool.
6. **Trade-ledger fees/slippage display**: `FullArgusReplayEngine.ts`'s `tradeLedger.push({..., fees: 0,
   slippage: 0, ...})` (lines ~225-226, ~259-260) hardcodes zero regardless of what
   `HistoricalReplayBroker` actually charged. This is **not** a P&L correctness bug — `realizedPnl` is
   computed from the broker's own cost-inclusive accounting (`HistoricalReplayBroker.ts:248`:
   `this.realizedPnl += (priced.fill - existing.entryPrice) * sellQty - commission`) — but any UI or
   report reading the `tradeLedger` array's own `fees`/`slippage` fields directly (rather than deriving
   them from `session.broker.snapshotCosts()`) would display $0 costs on trades that were, in fact,
   costed. A cosmetic/reporting gap, not an execution-fidelity gap.

## 4. Execution Fidelity — Real, With One Named Nuance

`HistoricalReplayBroker.ts` (read in full) models: real bid/ask spread and slippage in basis points
(`applyFillPrice`, config-driven via `costProfile` → `replaySafety.json`'s cost profiles), real
per-share commission, a real volume-participation cap (`maxVolumeParticipationPct` × the fill bar's own
reported volume — never fabricated, defaults to unbounded if unset), real partial fills when the
participation cap binds, real cash/buying-power rejection on BUY, real short-selling gate (rejects SELL
beyond position unless `shortSelling` is explicitly enabled), and real session/extended-hours gating
(`classifyMarketSession`/`sessionAllowsFills`).

**The one nuance:** `placeOrder()` accepts an `orderData.type` field but does not actually branch on it
— every order, regardless of the type value passed in, fills at the pre-set `nextFillPrice` (the next
bar's real open, confirmed at `FullArgusReplayEngine.ts:774`: `session.broker.nextFillPrice.set(symbol,
next.open)` — genuine NEXT_BAR_OPEN, not SAME_BAR_CLOSE). There is no LIMIT-price check and no
STOP-trigger logic. **This is not a replay-vs-live fidelity gap** — live Argus itself only ever places
whole-share MARKET orders (`CLAUDE.md`: "whole-share MARKET → broker"; no LIMIT/STOP order path exists
in the live spine either). The request's framing assumed a live capability (LIMIT/STOP/bracket orders)
that does not actually exist to have parity against — so there is nothing to remediate here specifically
*for parity's sake*; a LIMIT/STOP execution model would be a genuinely new capability for both live and
replay, not a replay catch-up item.

## 5. Look-Ahead Bias Audit

- **Bar-level:** `InformationCutoff.assertNotFuture()` throws `LOOK_AHEAD_BIAS_DETECTED` on any future
  timestamp (verified by an existing, passing test: `phase18.fullReplay.test.ts`'s `'InformationCutoff
  throws on future timestamps'`, re-run as part of this session's full suite, 348/348 green).
- **Fill timing:** confirmed genuine NEXT_BAR_OPEN via direct code read (§4) — a decision formed using
  bar N's close does not fill at bar N's own close/price, it fills at bar N+1's real open, with spread/
  slippage applied on top.
- **News:** `newsVisibleAt(provider, cutoff, symbol)` filters to `publishedAt <= cutoff` — verified by
  an existing, passing test (`'future news is not visible before publishedAt'`, `phase18.fullReplay.test.ts`,
  green in this session's full suite run).
- **PIT ledger (`HistoricalDataGateway.ingestPitLedgerEntry`/`getPitNewsAsOf`/`getPitAiRowsAsOf`)**:
  read in full earlier this session (§ "IBKR historical data adapter" work) — `ingestPitLedgerEntry`
  throws `LOOK_AHEAD_FORBIDDEN` if `publishedAtMs > asOfMs`, and both getters filter
  `publishedAtMs <= nowMs`. This is a second, independent look-ahead guard layered under the replay
  path, not just `InformationCutoff`.
- **No lookahead issue found this pass** in the code actually read. This audit did not attempt to
  construct a new adversarial look-ahead test beyond what already exists and passes.

## 6. Remediation Plan (Prioritized)

| Priority | Item | Root cause | Recommended action | Files | Risk |
|---|---|---|---|---|---|
| P1 | Fundamental/Macro/Kronos/News absence materially shrinks the independent-agent pool in replay vs. live, meaning replay consensus can behave differently (easier or harder to reach 2-agent agreement) purely from voter-count, not from the strategy being tested | No point-in-time fundamentals/macro/Kronos/real-news ledger exists to replay against | Build a real PIT ledger ingestion for AlphaVantage fundamentals/macro releases and Chronos-equivalent point-in-time forecasts (a genuinely large undertaking — likely its own multi-phase project, not a quick fix) | New PIT providers analogous to `HistoricalNewsProvider.ts` | High effort, no safety risk (research-only) |
| P2 | Add an explicit `KronosForecastAgent: UNAVAILABLE` entry to the honesty-report object for consistency with Fundamental/Macro's disclosure pattern | An omission is less honest than an explicit UNAVAILABLE, even though the practical effect (agent doesn't vote) is identical | One-line addition next to lines 630-631 | `FullArgusReplayEngine.ts` | Low |
| P2 | Cross-link this audit's Fundamental/Macro/News/Kronos absence into `ARGUS_HISTORICAL_EVALUATION.md`/`docs/ARGUS_REPLAY_USER_GUIDE.md` as a headline caveat, not just an in-code status field | Operators reading the user guide may not discover this by reading code | Doc edit only | `ARGUS_HISTORICAL_EVALUATION.md`, `docs/ARGUS_REPLAY_USER_GUIDE.md` | None |
| P3 | Populate `tradeLedger`'s `fees`/`slippage` fields from `session.broker.snapshotCosts()` deltas instead of hardcoding 0 | Cosmetic gap only (§3 item 6) | Compute a per-trade delta the same way `realizedPnl` already is | `FullArgusReplayEngine.ts` | Low — reporting only, no execution-path change |
| P4 | Decide whether Daily Goal Campaign policy simulation belongs inside `FullArgusReplayEngine.ts` itself (a real integration) vs. staying a separate, disclosed, post-hoc Java tool | Currently the only campaign simulation is unintegrated | Architectural decision needed before implementation — not undertaken in this audit | `FullArgusReplayEngine.ts`, `quant-core-java/.../CampaignPolicySimulator.java` | Needs a scoping decision first |

## 7. What This Audit Did Not Do

- Did not re-read `BacktestEngine.ts` (SAME_BAR_CLOSE) or `JavaBacktestEngine.java` line-by-line this
  pass — their scope/limitations were established earlier this session and are not re-verified here.
- Did not independently reproduce a live-vs-replay side-by-side run on the same historical window to
  empirically measure how much the missing-agent gap (§3 item 1) actually changes consensus outcomes —
  this would require a real PIT fundamentals/macro dataset that does not currently exist (see P1).
- Did not re-read `docs/ARGUS_REPLAY_USER_GUIDE.md`/`ARGUS_HISTORICAL_EVALUATION.md` to confirm whether
  they already disclose the Fundamental/Macro/News/Kronos gap — flagged as **NOT VERIFIED**, not
  assumed either way.
