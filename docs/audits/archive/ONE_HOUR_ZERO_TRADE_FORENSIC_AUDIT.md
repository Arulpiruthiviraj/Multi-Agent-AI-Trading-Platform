# ARGUS — 60-Minute Zero-Trade Runtime Forensic Audit

**Date:** 2026-08-21  
**Window:** approximately last 60 minutes before probe (`since ≈ 2026-08-21T18:59:05Z` → probe ~`19:59Z`)  
**Mode:** Read-only (SQLite `data/argus.db`, `agent_workspace/live_status_now.json`, config, source). **No mutations, no orders.**  
**Broker context:** `settings.selected_broker = IBKR Gateway (Socket)`; paper; `PAPER` / `LIVE_NO_GO`  
**Runtime snapshot:** `tradingState = TRADING_ENABLED`, Autobot on, emergency stop off, forensic buy-lock unlocked  

**Global verdict:** The engine **was alive and generating ideas**, but **zero** ideas cleared ChiefTrader in the hour. Therefore **RiskEngine never ran**, **OMS never placed**, and **IB Gateway received no PLACE_ORDER**. The primary bottleneck is **consensus (0.75 / min-2 independent agents)**. A secondary capacity bottleneck keeps most of the 122-name universe **off the IBKR tick wire** because Discovery still plans against **`maxActiveSubscriptions = 12`**, not IBKR’s **90**-line hard cap.

---

## 1. Executive Pipeline Funnel (Past ~60m)

| Funnel Stage | Total Count (Past 60m) | Status | Primary Blocker |
|---|---:|---|---|
| Discovered Stocks (scan universe) | **122** scanned / **122** shortlisted | OK | REST/snapshot ranking works |
| Active Subscriptions (`reqMktData`) | **~12** (`already_subscribed: 12`, `watch_candidate: 110`) | BLOCKED CAPACITY | Discovery uses `continuousIntelligence.maxActiveSubscriptions=12`; IBKR allows **90** |
| `subscribeRequested` (last discovery cycle) | **0** | EXPECTED UNDER CAP | `emptySlots = 0` → hot-swap only if score edge ≥ 0.15; often no swap |
| Trade Ideas / Agent Predictions | **342** `agent_predictions` rows | ACTIVE | Ideas exist; many single-agent |
| Quant assessments | **36** (10 emitted idea, 26 no-emit) | PARTIAL | Often `GATED` / no EV edge |
| Consensus decisions recorded | **15** | ALL REJECTED | `approved=0` for all 15 |
| ChiefTrader Approvals (≥75%, ≥2 agents) | **0** | HARD STOP | Typical ~25.7% / 1 agent; some 2-agent but &lt;75% |
| RiskEngine Assessments | **0** | NEVER REACHED | No `CHIEF_APPROVED_IDEA` → no gates |
| RiskEngine Approvals (24 gates) | **0** | N/A | No assessments |
| Broker Orders / Fills (`trades` / `fills`) | **0** / **0** | NONE | OMS not invoked |
| IB Gateway PLACE_ORDER (msg 3) | **0** (inferred) | NONE | No OMS `placeOrder` without Risk approval |

**Persisted `event_traces` in window:** 0 rows (high-frequency ideas are better observed via `agent_predictions` / `consensus_decisions` for this hour).

---

## 2. Phase Findings

### Phase 1 — 100+ stock market data ingestion

#### Wire subscriptions

| Fact | Evidence |
|---|---|
| Config streaming planner cap | `config/continuousIntelligence.json` → **`maxActiveSubscriptions": 12`** |
| IBKR line capacity | `config/ibkrConnection.json` → **`maxMarketDataLines": 90`**; `MarketDataWorker.effectiveStreamingCap()` uses `hardCapOverride` when `ibkr_gateway` is active |
| Discovery planner bug/mismatch | `OpportunityDiscovery.ts` line ~238: `const cap = continuousIntelligence.maxActiveSubscriptions` — **does not** call `marketDataWorker.effectiveStreamingCap()` |
| Live shortlist reasons | `already_subscribed: **12**`, `watch_candidate: **110**` |
| `subscribeRequested: 0` | Full 12-slot set → `emptySlots = 0` → at most **1** hot-swap if top mover beats weakest dynamic by `snapshotMomentumScoreEdge` (**0.15**); otherwise **0** requests |

**Why `scanned: 122` / `shortlisted: 122` but `subscribeRequested: 0`:**  
Discovery **ranks** the full universe, then only **subscribes** into remaining slots under the **12** planner. With 12 already on the wire, expansion stops. 110 names stay REST/snapshot-only and do not feed Technical/Kronos tick loops.

#### Tick flow

- Anchors `SPY` / `QQQ` / `GLD` are protected cores and remain subscribed.
- Consensus rejects in the hour include **SPY, GLD, NVDA, AMD, SOFI, HOOD, RIOT, COIN, MRVL** — so **some** non-anchor names *are* on the wire (within the 12), and ticks/ideas reached ChiefTrader for those.
- The other ~110 shortlisted names are **not** getting `reqMktData` under the 12-cap planner.

---

### Phase 2 — Idea generation & candidate screening

| Agent | 60m `agent_predictions` | Live health (status snapshot) | Role in funnel |
|---|---:|---|---|
| KronosEngine | SELL 168, BUY 36, HOLD 22 | `TICKING`, Chronos available | Strong idea volume |
| TechnicalAgent | BUY 61, SELL 7 | `TICKING` | Active |
| QuantEngine | BUY 10 | `GATED` (often) | Weak second vote; 26/36 assessments no emit |
| OpportunityScreener | BUY 9 | ideasEnabled **true** | One vote only when emitted |
| Fundamental / Macro | HOLD 16 / 13 | SUCCESS | Often HOLD, not entry agree |
| NewsAgent | — | Mode **`CATALYST_ONLY`**, `ideasEmitting: false` | **No** TRADE_IDEA votes |

**OpportunityDiscovery:** By contract **`ideasEmitted: 0` always** — subscribe-only; never `TRADE_IDEA_GENERATED`.  
**`ARGUS_OPPORTUNITY_IDEAS_ENABLED`:** Live status `ideasEnabled: true` (Screener can vote). Discovery still does not emit ideas.

---

### Phase 3 — ChiefTrader consensus (last 60m)

| Metric | Value |
|---|---:|
| Consensus rows | **15** |
| Approved | **0** |
| Rejected / NO_CONSENSUS | **15** |
| Risk assessments after consensus | **0** |

#### Representative rejection ledger

| Symbol | Weighted conf | Independent agents | Reason (abbrev.) |
|---|---:|---:|---|
| SOFI / HOOD / RIOT / SPY / GLD | **~25.7%** | **1** | Best side SELL at 25.7% (threshold 75%); window closed |
| NVDA | **80.0%** | **1** | Confidence cleared 75% but **min-2 failed** — window closed |
| MRVL | **28.8%** | **2** | Two agents agree BUY but **weighted &lt; 75%** |
| COIN | **7.0%–35.7%** | **1–2** | Below threshold |
| AMD | **48.8%** | (per row) | Below 75% |
| HOOD | **4.7%** | **1** | Far below threshold |

**Exact pattern (recurring):**  
`No consensus reached before the evaluation window closed. Best side: SELL at 25.7% (threshold 75%). Independent agreeing agents: 1.`

This matches the protected floors in `config/tradingSafety.json`:

- `consensusApprovalThreshold`: **0.75**
- `minIndependentAgreeingAgents`: **2**
- `ConsensusDebate` does **not** count as an independent entry agent

**Do not treat this as a RiskEngine or IBKR defect.** No approval → no order path.

---

### Phase 4 — Runtime locks & RiskEngine

| Check | Result |
|---|---|
| `tradingState` | **`TRADING_ENABLED`** (status snapshot + settings Autobot on) |
| SAFE_MODE / pause | **Not** the blocker in this window |
| Forensic checkpoint buy lock | **Unlocked** |
| Ideas reaching RiskEngine | **None** (`risk_assessments` count **0**) |
| 24-gate failures | **None evaluated** (no gate rows for approvals) |

---

### Phase 5 — Order dispatch & IB Gateway

| Check | Result |
|---|---|
| `trades` rows in window | **0** |
| `fills` rows in window | **0** |
| OMS → `IBGatewaySocketAdapter.placeOrder` | **Not reached** |
| Socket PLACE_ORDER / account `DUR959160` rejects | **No evidence** of any transmission; cannot audit reject codes for orders that were never sent |

IBKR socket path is therefore **idle for this hour**, not “rejecting” Argus orders.

---

## 3. Root Cause Analysis (ordered)

### RCA-1 (PRIMARY) — Consensus fail-closed at ChiefTrader

**Zero** of 15 consensus attempts met **both** ≥ **0.75** weighted confidence **and** ≥ **2** independent same-side agents.  
Typical failure: **one** agent (often Kronos SELL) → weighted ~**25.7%**.  
Even when confidence is high (**NVDA 80%**), **one** independent voice is insufficient.  
Even when **two** agents agree (**MRVL**), weighted confidence can stay **&lt; 75%**.

→ No `CHIEF_APPROVED_IDEA` → RiskEngine/OMS/IBKR never run.

### RCA-2 (CAPACITY) — Discovery still plans against 12-slot cap

IBKR Gateway can stream ~**90** lines, but OpportunityDiscovery computes:

```text
emptySlots = maxActiveSubscriptions(12) - active.size
```

With **12** already subscribed → **`subscribeRequested: 0`** most cycles → **110** shortlisted names never get ticks → Technical/Kronos cannot co-vote on them.

### RCA-3 (VOTER DEPTH) — Thin independent entry bench

- News: **`CATALYST_ONLY`** (no entry votes).
- Quant: often **`GATED`** / no live EV emit (10 ideas vs 26 quiet assessments).
- OpportunityDiscovery: **never** emits ideas.
- Screener: sparse second votes (9 BUYs).

So the system frequently has **exactly one** loud idea agent per symbol.

### Non-causes (this window)

- Not `TRADING_PAUSED` / emergency stop.
- Not RiskEngine gate failures (never invoked).
- Not IB Gateway order rejects (no orders).
- Not “discovery broken” — scan/shortlist **122** works; subscription planner is undersized vs IBKR.

---

## 4. Targeted Code & Config Patch (execution path)

**Invariant:** Do **not** lower `consensusApprovalThreshold` or `minIndependentAgreeingAgents`. Do **not** bypass RiskEngine/OMS.

### Patch A — Align Discovery cap with IBKR streaming capacity (highest leverage)

**File:** `src/server/continuous/OpportunityDiscovery.ts`

Replace planner cap:

```ts
// BEFORE
const cap = continuousIntelligence.maxActiveSubscriptions;

// AFTER (prefer live MDW hardCap when IBKR active)
const cap = marketDataWorker.effectiveStreamingCapPublic?.()
  ?? continuousIntelligence.maxActiveSubscriptions;
```

Or expose `MarketDataWorker.effectiveStreamingCap()` as a public method and use it.

**Config (reviewed):** When active broker is IBKR, raise planner toward gateway lines without exceeding them:

```json
// config/continuousIntelligence.json (example reviewed change)
"maxActiveSubscriptions": 90
```

Keep anchors protected; let hot-swap fill empty slots up to IBKR `maxMarketDataLines` (90).

**Verify after restart:**

```bash
# continuous status should show already_subscribed climbing >> 12
# subscribeRequested > 0 while emptySlots remain
npx tsx scripts/argus-cli.ts status
```

### Patch B — Keep Quant as a real second voter on IBKR

Already implemented historically: `HistoricalDataGateway` + `historicalBarProvider` for `ibkr_gateway`.  

**Operator actions:**

1. Confirm `QUANT_ENGINE_ENABLED=true` in `.env`.  
2. **Restart** Argus so BrokerManager registers the IBKR bar provider.  
3. Confirm Quant health leaves `GATED`/`FAILED` for Alpaca 429 when IBKR hist works.  
4. Watch `quant_assessments.emitted_trade_idea` and same-symbol Technical/Kronos agreement.

### Patch C — Optional News entry votes (config only)

If you want News as a second independent voter:

```bash
# .env
NEWS_AGENT_MODE=ACTIVE_VOTE
```

Default desk file may stay `CATALYST_ONLY`; env override must be set and process restarted. Still subject to 0.75 / min-2.

### Patch D — Do **not** “fix” RiskEngine or IBKR for this outage

No Risk/OMS/IBKR patch will create fills until ChiefTrader approvals &gt; 0.

### Acceptance criteria (paper)

1. Discovery: `active` IBKR streams **≫ 12** (toward 90), `subscribeRequested` fills empty slots.  
2. Same symbol shows **≥2** independent same-side ideas within the aggregation window.  
3. `consensus_decisions.approved = 1` appears.  
4. Then `risk_assessments` rows appear; only then expect `trades` / IB Gateway order activity.

---

## 5. Evidence Index

| Source | Role |
|---|---|
| `data/argus.db` | `agent_predictions`, `consensus_decisions`, `quant_assessments`, `trades`, `fills`, `risk_assessments` (60m) |
| `agent_workspace/live_status_now.json` | Discovery 122/0, agent health, tradingState, News mode |
| `agent_workspace/zero_trade_60m_db.json` | Probe dump |
| `config/continuousIntelligence.json` | `maxActiveSubscriptions: 12` |
| `config/ibkrConnection.json` | `maxMarketDataLines: 90` |
| `config/tradingSafety.json` | 0.75 / min-2 floors |
| `src/server/continuous/OpportunityDiscovery.ts` | Cap / `subscribeRequested` logic |

---

*This audit documents observed behavior. It does not authorize LIVE trading, consensus floor reductions, or OMS/RiskEngine bypasses.*
