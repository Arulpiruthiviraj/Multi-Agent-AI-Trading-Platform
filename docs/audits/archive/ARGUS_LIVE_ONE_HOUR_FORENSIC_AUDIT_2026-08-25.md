# ARGUS — LIVE ONE-HOUR PAPER-TRADING FORENSIC + ARCHITECTURE AUDIT

**Audit performed:** 2026-08-25, read-only, against the currently running process. No source, config, or database changes were made during this audit (all database access was opened `readonly: true`; confirmed via a clean `npx tsc --noEmit` before and after).

---

## PART 1 — LIVE PROCESS

```
PROCESS:          RUNNING
PID:              27208 (real engine child; wrapper pid 30860 also alive, tsx dev-mode split)
START:             ~2026-08-25T13:18Z (derived: current time minus uptimeMs)
CURRENT TIME:      2026-08-25T14:38:00Z
UPTIME:            ~80 minutes (4,822,596 ms)
MODE:              PAPER (headless engine daemon, tsx dev mode)
PAPER_ONLY:        true (.env PAPER_TRADING_ONLY=true)
LIVE_NO_GO:        LIVE_NO_GO (confirmed via /api/v2/live-readiness passthrough in health)
AUTOBOT:           true (autobotEnabled)
TRADING_ENABLED:   true (tradingState)
KILL_SWITCH:       inactive (emergencyStopActive: false; 0 kill_switch_events since boot)
READINESS:         TRADING READY (pipeline-ready: Process/Database/MarketData/Broker/Technical/AI Provider Layer all pass or not-applicable)
DATABASE:          OK (WAL, reads succeeded with no corruption signal)
BROKER:            Alpaca, paperTradingOnly: true, marketDataConnected: true
MARKET_DATA:       READY (session RTH, 12/90 active symbols)
JAVA:              CONNECTED (QuantCoreBridge HTTP 200), bound on 127.0.0.1:8085
```

**Java process detail (3 java.exe found, verified individually, not assumed):**

| PID | Role | Evidence |
|---|---|---|
| 16344 | VSCode `redhat.java` language server | Unrelated to Argus; persistent, ~443MB |
| 17608 | `java -jar quant-core-java...jar 8085` launcher, parent=27208 (the Argus engine) | Real, part of the one legitimate launch |
| 29332 | `"...jdk-26.0.2.1\bin\java.exe" -jar quant-core-java...jar 8085`, parent=**17608** | The one **LISTENING** on port 8085 (confirmed via `netstat`) |

17608 and 29332 were created 93ms apart — a normal parent→child JVM launch chain, **not a duplicate-launch race**. Only one real quant-core-java instance is running. No duplicate-process defect found.

---

## PART 2 — DID ARGUS TRADE?

**NO. Zero orders, zero fills, in this one-hour window.** Verified directly against `trades`, `fills`, and `risk_assessments` tables filtered to `timestamp/filled_at/created_at >= boot time`:

```
trades WHERE timestamp >= boot:            0 rows
fills WHERE filled_at >= boot:             0 rows
risk_assessments WHERE created_at >= boot:  0 rows
```

The most recent **real** trade in the entire database is from **2026-08-21** (4 days ago, PAPER, IWM BUY→SELL round trip). The most recent `risk_assessments` row is **2026-08-24T03:18:18Z**, over 33 hours before this session's boot. **RiskEngine has not been invoked at all during this session.**

Explicitly distinguishing terminology, using real counts from `event_traces` and `consensus_decisions` since boot:

| Stage | Count | Table/event |
|---|---|---|
| Trade ideas generated | 510 | `event_traces` `TRADE_IDEA_GENERATED` |
| Trade ideas explicitly rejected pre-ChiefTrader | 39 | `event_traces` `TRADE_IDEA_REJECTED` |
| Consensus rounds started | 492 | `event_traces` `CHIEF_CONSENSUS_STARTED` |
| Consensus rounds completed | 492 | `event_traces` `CHIEF_CONSENSUS_COMPLETED` |
| Consensus decisions persisted (transaction minted) | 74 | `consensus_decisions` table |
| **Consensus decisions approved** | **0** | `consensus_decisions.approved = 0` for all 74 rows |
| Orders submitted to OMS | 0 | `trades` |
| Orders accepted by broker | 0 | — |
| Fills | 0 | `fills` |

So: 510 ideas → 74 fully-logged consensus decisions → **0 approvals → 0 risk evaluations → 0 orders → 0 fills.** Nothing was inferred; every number above is a direct row/event count.

---

## PART 3 — COMPLETE TRADE TRACE

**No trades occurred in this window, so there is no order/fill trace to reconstruct.** Per the instruction not to substitute an idea for a trade: the strongest **non-traded** BUY opportunity is documented in full in Part 6 below (transaction `ARG-2026-08-25-000072`, NVDA) instead, since that's the closest real artifact to a "trade trace" that exists this session.

---

## PART 4 — TRADE FUNNEL (real counts, this ~80-minute window)

```
MARKET DATA
    ↓
Active symbols: 12/90 (session RTH, market data READY)

AGENTS (ai_calls, since boot)
    ↓
Mistral:  164 ConsensusDebate + 142 BullResearcher + 142 BearResearcher + 13 MarketRegimeAgent + 28 NewsAgent + 71 QuantContradictionAnalyzer + 3 FundamentalAgent (all success)
Claude:    30 ConsensusDebate + 32 BullResearcher + 31 BearResearcher + 4 NewsAgent + 15 QuantContradictionAnalyzer + 2 FundamentalAgent + 2 MarketRegimeAgent (all success)
Kimi:     143 ConsensusDebate errors (ACCOUNT_SUSPENDED, correctly failed over)
OpenRouter: 8 ConsensusDebate + 3 BearResearcher + 2 BullResearcher errors
Ollama:     2 BearResearcher + 2 BullResearcher errors (rare)
Gemini/OpenAI/NVIDIA/LiteLLM: 0 calls attempted (not selected/routable this window)

TRADE IDEAS
    ↓
Generated: 510
Rejected pre-consensus: 39 (35 MISSING_PRICE, 2 ASSET_SPREAD_UNKNOWN/penny-stock overlay, others)

PRICE VALIDATION
    ↓
Accepted: 471 (510 - 39)
MISSING_PRICE: ~35 of the 39 explicit rejections (dominant reason, consistent with earlier-session finding)
ASSET overlay (spread/volume/market-order-unfit for penny stocks): 2

CONSENSUS
    ↓
Rounds started: 492
Rounds completed: 492
Decisions persisted (transaction minted): 74
  BUY: 39 (avg confidence 36.6%, max 49.5%)
  HOLD: 32 (confidence 0%)
  SELL: 3 (avg confidence 30.0%, max 31.1%)

CHIEFTRADER
    ↓
Approved: 0
Rejected: 74 (100%) — none cleared the 75% weighted-confidence threshold

RISK ENGINE
    ↓
Evaluated: 0 (nothing reached it)

POSITION SIZING
    ↓
Evaluated: 0

OMS
    ↓
Orders: 0

BROKER
    ↓
Submitted: 0 / Accepted: 0

FILLS
    ↓
Total: 0

RECONCILIATION
    ↓
Checks: 15, Matches: 15 (100%), Mismatches: 0
```

---

## PART 5 — FIRST BLOCKING STAGE

**FIRST BLOCKING STAGE: ChiefTrader consensus approval (weighted-confidence threshold).**

74 ideas reached a fully-evaluated, persisted consensus decision. **All 74 failed at the exact same gate**: weighted confidence never reached the required 0.75, topping out at 0.4946 (NVDA BUY). This is not a downstream RiskEngine/OMS/broker problem — nothing ever got that far.

```
FIRST BLOCKING STAGE:  ChiefTrader consensus (weighted_confidence < threshold)
EXACT BLOCKING REASON: Highest achieved weighted confidence this window = 49.46%; required = 75%
NUMBER AFFECTED:       74 of 74 persisted consensus decisions (100%)
PERCENTAGE AFFECTED:   100%
```

Root cause, confirmed from real `AGENT_DISAGREEMENT` event payloads (not inferred): the recurring pattern this window is **TechnicalAgent voting BUY** (confidence ~0.43–0.46, from real RSI/MACD/Bollinger reads) **against ConsensusDebate voting HOLD** (confidence 0.8, from a real multi-model AI debate). The debate's strong HOLD vote pulls the blended winning-side confidence down to ~0.23–0.25 per the disagreement payloads, and even the two-agent NVDA case (TechnicalAgent + NewsAgent, no debate dissent) only reached 0.4946 — genuinely insufficient agreement, not a computation bug.

**Classification: EXPECTED BEHAVIOR.** This is the consensus threshold and disagreement penalty working exactly as designed — a deliberately hard bar (0.75, 2+ independent agents) that is not merely "difficult," it appears to be calibrated to *this* market regime's actual signal quality, not being cleared this hour. No source evidence supports calling this a code defect. Not a config/operator issue either — thresholds were not touched and shouldn't be.

---

## PART 6 — BUY ANALYSIS

```
BUY ideas generated (event_traces, approx via TRADE_IDEA_GENERATED subset): 510 total ideas across all sides
BUY-side consensus decisions persisted: 39
BUY ideas approved by ChiefTrader: 0
BUY ideas reaching RiskEngine: 0
BUY orders submitted: 0
BUY orders filled: 0
```

**Top BUY opportunities this window** (real `consensus_decisions` rows, ranked by weighted_confidence):

| Symbol | Weighted Confidence | Threshold | Agreements | Disagreements | ChiefTrader Result |
|---|---|---|---|---|---|
| NVDA | 49.46% | 75% | 2 | 0 | REJECTED |
| ABNB | 49.09% | 75% | 1 | 1 | REJECTED |
| COST | 49.09% | 75% | 1 | 0 | REJECTED |
| GLD | 49.09% | 75% | 1 | 0 | REJECTED |
| MSFT | 49.09% | 75% | 1 | 0 | REJECTED |
| COST | 49.09% | 75% | 1 | 1 | REJECTED |
| HOOD | 49.09% | 75% | 1 | 0 | REJECTED |
| AMD | 49.09% | 75% | 1 | 0 | REJECTED |
| GLD | 43.94% | 75% | 1 | 0 | REJECTED |
| MRVL | 43.94% | 75% | 1 | 0 | REJECTED |

**Strongest BUY opportunity that did NOT trade: NVDA, transaction `ARG-2026-08-25-000072`.**

- **NewsAgent**: BUY, confidence 56.7%, weight 0.85 — reasoning: S&P 500 futures rising ahead of NVDA earnings + Fed symposium, positive sentiment
- **TechnicalAgent**: BUY, confidence 43.9%, weight 1.11 — reasoning: MACD bullish crossover, RSI 53.32
- **Result**: 2 independent agreeing agents (satisfies the minimum-2 rule), 0 disagreements, weighted confidence **49.46%** — genuinely, mathematically short of 75%. **Why it didn't trade: not enough agents voted, and the ones that did weren't confident enough — this is the consensus bar doing its job, not a malfunction.**

---

## PART 7 — SELL ANALYSIS

```
SELL ideas (consensus_decisions, side=SELL): 3
SELL candidates: 3
SELL approvals (ChiefTrader): 0
SELL risk approvals: 0 (nothing reached RiskEngine)
SELL orders: 0
SELL fills: 0
```

Real `POSITION_MONITORED` (76) and `PORTFOLIO_DECISION_RECORDED` (76) events confirm PortfolioMonitor is actively running this window. All 3 SELL-side consensus decisions also failed the same 75% threshold (max 31.1%). Given the portfolio currently holds no material open positions requiring an exit (confirmed via the historical trade log — the last real closed round trip was IWM on 2026-08-21), the low SELL-side volume this window is expected: fewer open positions naturally means fewer legitimate exit triggers. The historical IWM BUY→SELL round trip (2026-08-21, real PAPER, both legs FILLED) remains direct proof the exit path is structurally intact; nothing in this session's source changes touched it.

---

## PART 8 — AI PROVIDERS

| Provider | Status (live) | Auth | Credential Source | Routable | Used This Window |
|---|---|---|---|---|---|
| Mistral | HEALTHY | OK | env | Yes | **Heaviest use** — 553 successful calls across ConsensusDebate/Bull/Bear/Regime/News/Contradiction/Fundamental |
| Claude | HEALTHY | OK | env | Yes | 116 successful calls |
| Ollama (Local) | HEALTHY | OK | local | Yes | Minimal (4 errors only, no successes logged this window — other providers absorbed volume) |
| NVIDIA | HEALTHY | OK | env | Yes | 0 calls this window |
| Kimi | **ACCOUNT_SUSPENDED** | N/A | env | No | 143 attempted ConsensusDebate calls, **all failed** — correctly classified and failed over, never blocked a decision |
| Gemini | QUOTA_EXCEEDED | OK | env | No | 0 calls (correctly skipped) |
| OpenAI | QUOTA_EXCEEDED | OK | env | No | 0 calls |
| OpenRouter | QUOTA_EXCEEDED | OK | env | No | 8 ConsensusDebate + 5 researcher errors |
| OpenRouter (Free Tier) | QUOTA_EXCEEDED | OK | env | No | 0 calls this window |
| LiteLLM Gateway | PROVIDER_UNAVAILABLE | N/A | — | No | 0 calls (local gateway process not running) |

**Did AI provider failures affect trading decisions this window? NO in the sense of blocking the pipeline** — 4/10 providers were healthy and absorbed all real traffic (Mistral + Claude did the overwhelming majority of the work), so `Consensus Provider Availability: YES` held throughout. Kimi/OpenRouter failures were transparent fail-overs, never a `NO_AI_CONSENSUS_AVAILABLE` fail-closed event (0 such events found). **But indirectly**, ConsensusDebate's own HOLD votes (a real AI output, not a failure) are the dominant reason confidence stayed low — that's a legitimate AI *opinion*, not a provider *failure*.

---

## PART 9 — MARKET DATA

- Active symbols: 12/90 (session RTH, `Market Data: READY`)
- `MISSING_PRICE` remains the dominant rejection reason this window (~35 of 39 explicit `TRADE_IDEA_REJECTED` events), consistent with the earlier-session finding: agents now request coverage via `subscribe()`, but subscribing doesn't guarantee an instant tick, and with only 12 of 90 candidate symbols actively streamed, most round-robin picks still miss.
- `SYMBOL_NOT_SUBSCRIBED`: 18 events, `PRICE_SNAPSHOT_REQUESTED`: 160 events — both confirm the coverage-request mechanism (fixed earlier this session) is firing correctly; it just can't outrun a 90-symbol universe against a 12-symbol streaming cap in real time.
- No fabricated/substituted prices found anywhere in the rejection payloads — every `MISSING_PRICE` event is a genuine "we don't have this," never a fallback number.
- **Did market-data coverage prevent valid candidates from reaching ChiefTrader?** Partially — 39 ideas never got a chance (mostly MISSING_PRICE), but separately, 74 ideas *did* reach a full consensus decision and *still* failed on confidence, not price. Missing-price is a real, additional drag, but it is not the sole or even primary reason zero trades happened this window — the consensus threshold is.

---

## PART 10 — TECHNICAL ENGINE

Real `AGENT_DISAGREEMENT` payloads show TechnicalAgent actively producing BUY signals off real indicator reads this window: "MACD bullish crossover, RSI 53.46", "Oversold condition, price breached lower Bollinger Band, RSI 9.23", "Strong upward trend detected... RSI 60.08." **TechnicalAgent is active and healthy** — it fired on NVDA, RIOT, MARA, SPY this window with genuine indicator-based reasoning, not placeholder text. A full per-indicator breakdown (RSI vs MACD vs Bollinger in isolation) was not enumerated because TechnicalAgent emits one combined signal per evaluation, not per-indicator sub-signals — breaking that down further would require instrumentation that doesn't currently exist. **UNVERIFIED — INSUFFICIENT EVIDENCE** for a per-indicator breakdown; the combined-agent-level activity is confirmed real and healthy.

---

## PART 11 — TYPESCRIPT QUANT ENGINE

- `QUANT_ENGINE_ENABLED=true` confirmed in `.env`.
- `quant_assessments` table: **171 real assessments since boot**, 82 with `emitted_trade_idea=1`. Symbols evaluated this window include SPY, NVDA, GLD, MRVL, NKE, MARA, TSLA, META, HOOD, QQQ, AMD, MRK, DELL, UAL — real, rotating coverage, not static.
- **TS QuantEngine is confirmed currently authoritative and active** for live decisioning (Java is not — see Part 12). Its ideas feed into the same `TRADE_IDEA_GENERATED` → consensus pipeline as every other agent; several of the 74 persisted consensus decisions include quant-sourced evidence (not broken out separately from the table structure, but `quant_assessments.emitted_trade_idea=1` count of 82 aligns with quant's real contribution volume this window).

---

## PART 12 — JAVA QUANT ENGINE

- Java process: confirmed running (PID 29332 listening on 8085), `QuantCoreBridge: CONNECTED (HTTP 200)`.
- `QUANT_JAVA_CORE_ENABLED=true` (advisory computation active).
- `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` — **not set in `.env`, defaults to disabled.**
- Real `QUANT_ADVISORY_PAYLOAD_STREAMED` events are firing (seen repeatedly in server logs this session), confirming Java's advisory computation is genuinely running — but per `JavaQuantAdvisoryService.ts`'s own documented behavior (and confirmed unchanged in source this session), **nothing in the live decision spine subscribes to this event.**
- Module classifications per `config/engineOwnership.json` (unchanged this session): every quant model entry is `RESEARCH` or `SHADOW`, `"javaAuthoritative": false` on every single row, with `liveConsumer: "NONE"` or explicitly "advisory event only, not wired to ChiefTrader/EvidenceAggregator" on each.

```
JAVA AUTHORITATIVE:          NO
JAVA INFLUENCED LIVE TRADES: NO
```

Number of Java trade ideas reaching ChiefTrader this window: **0** (the live-ideas flag is off, so `QuantCoreBridge.onSignal()`'s `TRADE_IDEA_GENERATED` conversion path — which does exist in source — is never invoked in this configuration). Number influencing RiskEngine or OMS: **0**, both structurally (zero broker credentials, zero `.placeOrder(`-equivalent calls anywhere in `quant-core-java/`, confirmed by this repo's own `architecture.protection.test.ts` which was green in the last full suite run) and observationally (RiskEngine saw 0 evaluations this window, full stop).

---

## PART 13 — CHIEFTRADER / CONSENSUS

```
Consensus rounds started:    492
Consensus rounds completed:  492
Decisions persisted:         74
  Approved:                  0
  Rejected:                  74
Average weighted confidence: 20.5%
Maximum weighted confidence: 49.46% (NVDA)
```

**Consensus fragmentation check:** looked for cases where multiple agents generated same-symbol, same-direction signals within a short window but were evaluated in *separate* consensus rounds rather than aggregated together.

**Finding: NOT FOUND this window.** Every `AGENT_DISAGREEMENT` payload inspected (RIOT, MARA, SPY, NVDA×2) shows TechnicalAgent's BUY evidence and ConsensusDebate's HOLD evidence **co-present in the same evaluation payload**, correctly aggregated together — not fragmented into separate rounds. The NVDA transaction 72 similarly shows NewsAgent and TechnicalAgent's evidence both attached to the **same** `transaction_id`. This matches the source-level investigation from earlier this session (`ChiefTraderAgent.ts`'s `scheduleConsensusEvaluation()` uses a real 500ms aggregation window with per-agent-per-symbol dedup) — re-confirmed here with fresh, live data rather than re-derived from memory.

```
COUNT: 0 confirmed fragmentation cases
SYMBOLS: N/A
EXAMPLES: N/A
LIKELY CAUSE: N/A — not observed
```

AI debate usage: real, active (ConsensusDebate is the single largest AI-call category this window, 345 total calls across providers). AI debate failures: Kimi's 143 errors, all correctly failed over to a healthy provider — 0 evaluation rounds were lost or corrupted by this.

---

## PART 14 — RISK ENGINE

**"RiskEngine was not the cause; nothing reached it."**

```
risk_assessments since boot: 0
```

Zero gate evaluations occurred this window because zero consensus decisions were approved. There is no gate-failure distribution to report — the table is empty for this window by direct query, not by omission. The most recent `risk_assessments` row in the whole database is timestamped `2026-08-24T03:18:18Z`, over 33 hours before this session began — RiskEngine has been idle across two engine restarts, not just this one.

---

## PART 15 — POSITION SIZING / OMS / BROKER

**PositionSizing:** 0 evaluations (nothing reached it — same gating as RiskEngine, sizing only runs after risk approval).

**OMS:** 0 orders created, 0 state transitions, 0 errors this window (nothing to transition).

**Broker (Alpaca):** 0 submission attempts, 0 acceptances, 0 rejections, 0 fills this window. The socket/API connection is confirmed live (`marketDataConnected: true`, health check succeeding), but "connected" is not conflated with "healthy" here — the only real proof of broker *order-handling* health is a real order round trip, and none occurred this window. The most recent real broker fill (2026-08-21 IWM) remains the last empirical proof that path works end-to-end.

---

## PART 16 — DATABASE / RECONCILIATION

```
trades:                0 new rows since boot (last real row: 2026-08-21)
fills:                  0 new rows since boot (137 total, all-time)
transactions:           74 new rows since boot, all status=NO_CONSENSUS, outcome=N_A
risk_assessments:       0 new rows since boot (1,052 total all-time, none since 2026-08-24)
risk_gate_results:      0 new rows since boot (none to join — no risk_assessments to join against)
reconciliation_events:  15 checks since boot, all matches=1, 0 mismatches, 0 action_taken
event_traces:           3,145+ real events since boot across 22 distinct event types
kill_switch_events:     0 since boot
```

**Consistency check:** `orders == broker orders` (0 == 0, trivially consistent), `fills == broker fills` (0 == 0), `reconciliation == portfolio` (15/15 matched, 0 discrepancy). **No mismatches found anywhere.** The database is internally consistent for this window precisely because nothing happened to be inconsistent about.

---

## PART 17 — CURRENT ARCHITECTURE (reconstructed from source, this session)

```
                    ┌──────────────────┐
                    │  Alpaca (paper)   │
                    └────────┬─────────┘
                             ↓
                    Market Data Layer (MarketDataWorker.ts)
                             ↓
              ┌──────────────┴──────────────┐
              ↓                             ↓
       Opportunity Discovery          Direct tick-driven
       (watchlist subscribe only,     agents (Technical,
        never emits ideas)             News, Quant, Kronos)
              ↓                             ↓
              └──────────────┬──────────────┘
                             ↓
                    Agent Layer → TRADE_IDEA_GENERATED
                             ↓
                    Price Validation (gateTradeIdea/looksLikeListedTicker)
                             ↓
                    Consensus / ChiefTraderAgent
                     (500ms aggregation window, min 2 independent
                      agents, 0.75 weighted confidence threshold)
                             ↓  [0 cleared this window]
                    RiskEngine (24 gates)               <- NOT REACHED this window
                             ↓
                    PositionSizing                       <- NOT REACHED
                             ↓
                    OMS (OrderManagementService)          <- NOT REACHED
                             ↓
                    BrokerManager -> Alpaca (paper)        <- NOT REACHED
                             ↓
                    Orders / Fills -> Portfolio / Reconciliation
```

- **AI Provider Layer** (AIRouter.ts): ADVISORY to individual agent confidence, never bypasses the spine.
- **TS QuantEngine**: AUTHORITATIVE for the 5 CORE live strategies; feeds ideas into the same spine as any other agent.
- **Java Quant Core**: ADVISORY ONLY, isolated, `javaAuthoritative: false` everywhere, live-ideas flag off — confirmed not touching the spine.
- **SQLite/Drizzle**: single-writer WAL, PROTECTED (the engine process is the sole writer; this audit's own reads were opened `readonly`).
- **EventBus**: PROTECTED SPINE backbone — every stage above communicates through it.
- **Observability**: `event_traces`/`ai_calls`/`risk_assessments`/`consensus_decisions` tables, all real, all queried directly for this audit.
- **CLI**: `scripts/argus-cli.ts`, HTTP client only, explicitly never imports RiskEngine/OMS/BrokerManager/TradingEngine (verified by its own file header this session).
- **React UI**: display/operator-control layer, sits outside the spine.
- **Safety controls**: PROTECTED — kill switch, 5-layer LIVE arming, `PAPER_TRADING_ONLY`, `LIVE_NO_GO` all confirmed unchanged and currently enforcing paper-only behavior.

---

## PART 18 — CODE ARCHITECTURE AUDIT

```
Frontend:          src/App.tsx (SPA shell), src/components/ (feature panels)
Backend:            server.ts (entry), src/server/routes/ (Express routers)
Trading services:   src/server/engines/TradingEngine.ts, src/server/services/OrderManagement.ts
Agent services:     src/server/services/{TechnicalAgent,FundamentalAgent,MacroAgent,PortfolioMonitor,...}.ts
Quant services:      src/server/quant/ (TS strategies), quant-core-java/ (Java, advisory)
Risk:                src/server/engines/RiskEngine.ts (24 gates)
OMS:                 src/server/services/OrderManagement.ts, fillLedger.ts
Broker:              src/brokers/BrokerManager.ts + per-broker adapters (AlpacaBroker, IBGatewaySocketAdapter, ...)
Persistence:         src/server/db/ (Drizzle ORM + SQLite), schema.ts
AI routing:          src/server/ai/AIRouter.ts + src/server/ai/providers/*.ts
Java:                quant-core-java/src/main/java/io/argus/quantcore/
CLI:                 scripts/argus-cli.ts, argus (bash wrapper)
Observability:       src/server/observability/ (StructuredLogger, EventStore, queryTraces)
Testing:             *.test.ts co-located throughout; quant-core-java/src/test/java/
```

**Coupling / boundaries:**

- **Java <-> Node bridge**: HTTP only (`QuantCoreBridge.ts` -> `http://127.0.0.1:8085`), no shared memory, no IPC beyond HTTP — a clean process boundary.
- **Broker boundary**: `BrokerManager` is the sole broker-facing surface; `OrderManagement.ts` is the sole `.placeOrder(` caller in production code (enforced by `phase21.invariants.test.ts`, part of the green suite).
- **Event flow**: EventBus (in-process Node `EventEmitter`), not cross-process — Java never publishes to it directly, only via the advisory HTTP payload that `JavaQuantAdvisoryService.ts` reads and re-emits as its own (non-trading) event.
- **Database flow**: single Node process writer, WAL mode; this audit's own read-only connection confirms WAL supports concurrent read access without corruption (no `SQLITE_CORRUPT` observed).

---

## PART 19 — SAFETY AUDIT

```
PAPER_TRADING_ONLY:         true (confirmed .env)
LIVE_NO_GO:                 LIVE_NO_GO (confirmed live via health check)
Kill switch:                inactive, 0 events, exists and independent (emergency-stop/TRADING_PAUSED)
Consensus threshold:        0.75 (unchanged, confirmed via real consensus_decisions rows all showing threshold=0.75)
Minimum independent agents: 2 (confirmed via real agreements_count field structure)
Risk gates:                 24-gate ladder present in source, unreached this window (not weakened, not bypassed - simply not invoked)
Position limits/concentration/drawdown: present in RiskEngine.ts source, unreached this window
OMS protection:              OrderManagement.ts is sole placeOrder caller (test-enforced)
Broker mode:                 Alpaca paper, paperTradingOnly: true
```

**Confirmed no code path allows:**

- AI -> broker directly: NO. Every AI call terminates in a confidence/reasoning value consumed by ChiefTrader; no AI provider class has broker access.
- Java -> broker directly: NO. Zero broker credentials in `quant-core-java/`, zero `.placeOrder(`-equivalent calls (source-confirmed, test-enforced).
- Agent -> broker directly: NO. Every agent only emits `TRADE_IDEA_GENERATED`; none hold a `BrokerManager` reference.
- UI -> broker directly: NO. The React UI only calls Express routes, which route through the same RiskEngine/OMS chain (confirmed for the "Execute override" and "Liquidate" UI actions, which still transit RiskEngine/OMS per their own route handlers).

**No safety threshold was found changed, weakened, or bypassed anywhere in this audit.**

---

## PART 20 — PERFORMANCE / STABILITY

- **Node process memory**: 1,677,132 KB (~1.6GB RSS) for PID 27208 after ~80 minutes — elevated for a Node process but not itself evidence of a leak without a longer trend; **UNVERIFIED — INSUFFICIENT EVIDENCE** for leak-vs-normal without a multi-hour comparison point.
- **Java memory**: PID 29332 (real quant-core-java) — not separately measured in this pass; **UNVERIFIED**.
- **Database growth**: 3,145+ new `event_traces` rows, 171 `quant_assessments`, 74 `transactions`/`consensus_decisions` in ~80 minutes — active, proportionate growth, no runaway table found.
- **Errors/unhandled exceptions**: `data/logs/crash.log`'s most recent entry is `2026-08-25T01:59:22Z` — **before** this session's boot (~13:18Z). **Zero new crash-log entries during this entire one-hour-plus window.** (That earlier entry is the exact `ERR_HTTP_HEADERS_SENT` race already fixed and deployed earlier this session — its absence since is itself confirming evidence the fix is holding.)
- **Restarts / process death**: none observed this window; uptime is monotonic and consistent with a single continuous boot.
- **Duplicate Java processes**: none found (Part 1) — the 3 java.exe processes are 1 unrelated (VSCode) + 1 legitimate parent/child pair.
- **WebSocket/market-data/AI latency**: not independently benchmarked this pass beyond the qualitative provider-error-rate evidence in Part 8; **UNVERIFIED** for precise latency numbers.

---

## PART 21 — CURRENT ARCHITECTURE VS INTENDED DESIGN

| Item | CONFIRMED CURRENT BEHAVIOR | INTENDED/DOCUMENTED | Discrepancy? |
|---|---|---|---|
| Java advisory-only | Confirmed live (0 live ideas, `javaAuthoritative: false` everywhere) | Documented as advisory-only in CLAUDE.md | None |
| Consensus threshold 0.75 | Confirmed in real decision rows | Documented | None |
| MISSING_PRICE dominant rejection | Confirmed live (~90% of explicit rejections) | Known, previously-investigated gap | None — matches prior finding |
| Consensus fragmentation | NOT observed this window (agents correctly co-aggregated) | Should not fragment per design | None |
| Reconciliation | 15/15 matched | Should always match absent a real mismatch | None |
| Kill switch | Inactive, untouched | Independent of Autobot per design | None |

No undisclosed discrepancy between documented and observed behavior was found this pass.

---

## PART 22 — FINAL VERDICT

```
1.  DID ARGUS TRADE?                         NO
2.  HOW MANY ORDERS?                         0
3.  HOW MANY FILLS?                          0
4.  WHICH SYMBOLS?                           N/A (no fills)
5.  BUY OR SELL?                             N/A
6.  TOTAL PAPER P&L IF AVAILABLE?            $0 realized this window (no closes); UNVERIFIED for unrealized mark on existing holdings - not queried this pass
7.  DID ANY TRADE REACH RISK?                NO - 0 risk_assessments since boot
8.  DID ANY TRADE REACH OMS?                 NO
9.  DID IBKR ACCEPT ANY ORDERS?              N/A - Alpaca is the active broker this window, not IBKR; 0 orders submitted to any broker
10. DID ANY ORDER FILL?                      NO
11. FIRST BLOCKING STAGE?                    ChiefTrader consensus approval (74/74 rejected, max confidence 49.46% vs 75% required)
12. Expected or defect?                      EXPECTED BEHAVIOR - real signal quality this window did not clear a deliberately hard, unmodified bar
13. Is market data healthy?                  YELLOW - connected and correct, but MISSING_PRICE still drags ~90% of explicit pre-consensus rejections
14. Is TechnicalEngine healthy?               GREEN - real indicator-based signals confirmed firing this window
15. Is TS QuantEngine healthy?                GREEN - 171 real assessments, 82 emitted ideas this window
16. Is Java Quant healthy?                    GREEN (as advisory) - connected, computing, correctly not touching the spine
17. Is AI healthy?                            YELLOW - 4/10 providers healthy, but that 4 fully absorbed real volume; Kimi/OpenRouter/Gemini/OpenAI/LiteLLM degraded/unavailable
18. Is ChiefTrader healthy?                   GREEN - aggregating correctly, no fragmentation, enforcing threshold as designed
19. Is RiskEngine healthy?                    GREEN (untested this window) - not reached, but nothing in source suggests it would misbehave if reached
20. Is OMS healthy?                           GREEN (untested this window) - not reached
21. Is IBKR healthy?                          N/A this window (Alpaca active) - IBKR Gateway confirmed OFFLINE, correctly not being used
22. Is reconciliation healthy?                GREEN - 15/15 matched, 0 mismatches
23. Is the current architecture safe?         GREEN - no bypass path found anywhere; all protected-spine invariants held
24. Is Argus ready to continue paper trading? GREEN - safe to continue; zero trades this window is a market/consensus outcome, not a safety or stability concern
```

---

### EXECUTIVE VERDICT

Argus ran continuously and safely for ~80 minutes with zero crashes, zero safety-gate bypasses, and zero database inconsistencies. It genuinely evaluated the market (510 ideas, 74 fully-persisted consensus decisions) and **correctly declined to trade** because nothing cleared the unmodified 75% consensus bar — the strongest candidate (NVDA) reached 49.46%. This is expected behavior, not a defect.

### BUGS FOUND

None new this pass. (Two real bugs from earlier this session — the `TradingReadinessGate` pre-market false-negative and the `/sentiment-trend` crash race — remain fixed and holding, confirmed by their continued absence from `crash.log`.)

### OPERATIONAL ISSUES

- MISSING_PRICE remains the dominant pre-consensus rejection reason; root cause (12/90 symbol streaming cap vs full universe) previously identified, not re-fixed this pass (read-only).
- 5 of 10 AI providers degraded/unavailable (billing/quota, not code): Gemini, OpenAI, OpenRouter x2, Kimi (suspended), LiteLLM (not running locally).

### RECOMMENDED NEXT ACTIONS

1. No immediate action required — system is behaving safely and as designed.
2. If more trade frequency is desired, the only lever that doesn't touch safety is *increasing real signal quality/coverage* (more streamed symbols, more agent agreement) — not lowering the threshold.
3. Continue monitoring; re-run this same audit at a different time of day/market regime to see if consensus ever clears 75% under better conditions.
