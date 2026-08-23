# ARGUS — Trade Execution Inactivity Forensic Audit

**Date:** 2026-08-21  
**Scope:** End-to-end discovery → stream → idea agents → ChiefTrader → RiskEngine/OMS  
**Broker (live):** `ibkr_gateway` · TCP `:4002` · account `DUR959160` · `streamingCapacity: 90`  
**Mode:** `PAPER_TRADING_ONLY=true` · `LIVE_NO_GO` (unchanged)  
**Evidence:** `npm run argus-cli -- status|health`, EventBus logs, `config/continuousIntelligence.json`, `MarketDataWorker` / `OpportunityDiscovery` / `ChiefTraderAgent` source  

**Verdict:** Argus is **scanning** a 100+ name universe and **ranking** movers, but it is **not** streaming ~100 IBKR market-data lines. Execution is blocked primarily by (1) discovery still planning against the Alpaca **12**-slot streaming cap, (2) **single-agent** consensus failures at **0.75 / min-2**, and (3) degraded / non-voting idea agents. Runtime pause is **not** the current blocker (live phase `RUNNING` / `TRADING_ENABLED`).

---

## 1. Root Cause Hierarchy

| Component | Current State (2026-08-21 live) | Impact on Trading | Unblock Action |
|---|---|---|---|
| **Universe scan (SnapshotScanner / OpportunityDiscovery)** | `scanned: 122`, `shortlisted: 122`, `momentumRanked: 8`, RTH true | REST ranking works; **does not** equal wire subscriptions | Keep scanning; fix subscribe planner (below) |
| **Streaming subscription planner** | Uses `continuousIntelligence.maxActiveSubscriptions = **12**` for `emptySlots` | Caps live ticks at ~12 names even when IBKR allows 90 | Raise reviewed `maxActiveSubscriptions` toward IBKR cap **or** make Discovery use `MarketDataWorker.effectiveStreamingCap()` |
| **MarketDataWorker hardCap** | On `ibkr_gateway`, `hardCapOverride = maxMarketDataLines` (**90**) | Capacity **exists** but Discovery never fills it | Align Discovery empty-slot math with `effectiveStreamingCap()` |
| **`subscribeRequested: 0` (common)** | At full 12-slot cap, hot-swap emits **0–1** symbols only when score edge ≥ `0.15` | Most cycles request nothing new; 110+ shortlist names stay REST-only | Fill empty slots up to IBKR cap; then hot-swap remains 1/cycle by design |
| **OpportunityDiscovery `ideasEmitted`** | Always **0** (by contract) | Discovery is **watchlist subscribe only** — not an idea source | Use `OpportunityScreener` + tick agents for ideas |
| **`ARGUS_OPPORTUNITY_IDEAS_ENABLED`** | **true** in `.env`; status `ideasEnabled: true` | Screener *may* emit one vote; still needs a second independent agent for quorum | Confirm screener emissions in traces; pair with Technical/Kronos |
| **QuantEngine** | Earlier: `FAILED` (Alpaca bars 429); live: `GATED` / rate-limit fail-closed | Removes a high-value independent voter; still hits **Alpaca REST** even with IBKR order broker | Back off Quant fan-out; wait out 429; long-term: IBKR historical bars (additive) |
| **NewsAgent** | `CATALYST_ONLY`, `ideasEmitting: false` | No News entry votes (ingest/veto may still run) | Only change desk mode if operator explicitly wants News votes (reviewed config) |
| **TechnicalAgent / KronosEngine** | Ticking / emitting; often **disagree** or sole BUY/SELL | Typical path: **1** independent agree → NO TRADE | Need **≥2** same-side independent ideas on the same symbol |
| **ChiefTrader consensus** | Floor **0.75** + **min 2** independent agents; `ConsensusDebate` **does not** count | PLTR/META/MSFT/etc. rejected at ~25.7% / 1 agent — **by design** | Do **not** lower floors; restore multi-agent agreement |
| **Runtime phase / tradingState** | Live: `phase: RUNNING`, `tradingState: TRADING_ENABLED`, Autobot on | **Not** blocking orders right now | If you see `SAFE_MODE` / `TRADING_PAUSED`, operator must re-enable (below) |
| **RiskEngine / OMS** | Reachable after `CHIEF_APPROVED_IDEA` only | Few/no approvals → few/no gate evaluations | Fix upstream consensus first; then review gate fails if any |

---

## 2. Four Key Bottlenecks (Detailed)

### 2.1 Market Data Subscription Cap (12 vs 90–100)

**What works**

- Snapshot / momentum universe lists **122** symbols (`momentumScanUniverseSymbols` ~122 names).
- Live discovery telemetry: `scanned: 122`, `shortlisted: 122`.
- With `ibkr_gateway` active, health reports `streamingCapacity: 90` and session account `DUR959160` on port **4002**.
- `BrokerManager.applyMarketDataBinding` sets `MarketDataWorker` `hardCapOverride` to `config/ibkrConnection.json` → `maxMarketDataLines` (**90**) and wires `reqMktData` via `ibkrBridge`.

**What fails**

```238:268:src/server/continuous/OpportunityDiscovery.ts
    const cap = continuousIntelligence.maxActiveSubscriptions;
    const emptySlots = Math.max(0, cap - active.size);
    ...
    if (continuousIntelligence.momentumRotationEnabled) {
      ...
      const maxSwaps = emptySlots > 0
        ? Math.min(continuousIntelligence.momentumHotSwapSlotsPerCycle, emptySlots)
        : Math.min(1, continuousIntelligence.momentumHotSwapSlotsPerCycle);
```

- Reviewed config still has **`"maxActiveSubscriptions": 12`** (Alpaca IEX-safe default) in `config/continuousIntelligence.json`.
- Discovery computes `emptySlots` from that **12**, **not** from `marketDataWorker.effectiveStreamingCap()` (90 under IBKR).
- Live shortlist shows exactly **12** rows with `reason: "already_subscribed"` → wire set is full under the **config** cap.
- When `emptySlots === 0`, hot-swap is capped at **1** replacement per cycle and only if a top mover beats the weakest dynamic by `snapshotMomentumScoreEdge` (**0.15**). That explains intermittent `subscribeRequested: 0` despite 122 shortlisted names.
- Honesty string in status still documents the Alpaca **12** cap — accurate for Discovery planning, misleading vs IBKR MD capacity.

**IB Gateway ticks beyond SPY/QQQ/GLD**

- Anchors remain protected; seed + hot-swap dynamics (e.g. NVDA, AAPL, MSFT, TSLA, AMD, META, occasional NET/SOFI/RIOT) appear in `WATCHLIST_SUBSCRIBE_REQUESTED` logs.
- That is **~9 dynamic + 3 anchors ≈ 12**, not 90+. Technical/Kronos only tick symbols that actually stream.

---

### 2.2 Agent Generation Deficit

| Agent | Live / recent state | Emits `TRADE_IDEA_GENERATED`? |
|---|---|---|
| TechnicalAgent | Ticking | Yes (primary tick path) |
| KronosEngine | Ticking (Chronos up) | Yes when idea gate allows |
| QuantEngine | FAILED (Alpaca 429) → GATED | No while fail-closed / gated |
| NewsAgent | RUNNING, `CATALYST_ONLY` | **No** (`ideasEmitting: false`) |
| FundamentalAgent / MacroAgent | RUNNING (ideas when timers fire) | Yes, but often HOLD / low confidence |
| OpportunityDiscovery | Loop on | **Never** (`ideasEmitted` always 0) |
| OpportunityScreener | Flag **on** | Yes, one vote when return threshold met |

**Opportunity ideas flag**

- `.env`: `ARGUS_OPPORTUNITY_IDEAS_ENABLED=true` (and loop enabled).
- Status: `ideasEnabled: true`.
- Telemetry `ideasEmitted: 0` on the **Discovery** object is **expected** — Discovery is subscribe-only. Screener emissions are separate EventBus ideas, not that counter.

**Quant + Alpaca**

- `QuantSignalAgent` still pulls **Alpaca** historical bars; IBKR as order/quote broker does not stop Quant from 429’ing Alpaca REST. Fail-closed → no fabricated bars → no Quant votes.

**Net entry generators under current conditions**

- Effectively **Technical + Kronos** (± occasional Fundamental/Macro/Screener).
- That is **insufficient** when they disagree or only one votes BUY/SELL.

---

### 2.3 Consensus Hurdle (0.75 / 2 independent agents)

From `config/tradingSafety.json` (must not be weakened for frequency):

- `consensusApprovalThreshold`: **0.75**
- `minIndependentAgreeingAgents`: **2**

From `ChiefTraderAgent`:

- `ConsensusDebate` is a challenge layer and **does not** count toward the independent-agent floor.
- Live rejections match the contract, e.g.:
  - PLTR / META / MSFT pattern: *Confidence ~25.7% did not clear 75%. Independent agreeing agents: 1. Required: 2.*
  - NET: *Only 1 independent agent agreed on BUY (need 2).*
  - Sample vote set (TSLA): Fundamental HOLD, Kronos SELL, Technical BUY, Debate HOLD → **no** same-side pair.

**Can Kronos or Technical alone clear consensus?**

- **No.** One independent agent can never satisfy min-2, regardless of confidence.
- Even two agents agreeing at modest confidence often fail the **0.75** weighted bar (default weights: Technical 0.25, Kronos 0.20, OpportunityScreener 0.10, Quant 0.15, …).

**Combinations that can clear (current market / degraded Quant/News)**

| Pair (same side) | Viable? | Notes |
|---|---|---|
| Technical + Kronos | Yes (best available) | Both must agree BUY or SELL with enough weighted confidence |
| Technical + OpportunityScreener | Yes | Screener is a weak weight (0.10); need high conf / more voters |
| Technical + Quant | Yes when Quant healthy | Currently rate-limited / gated |
| Technical + News | Only if News mode leaves CATALYST_ONLY | Not current desk policy |
| Kronos alone / Technical alone | **Never** | Min-2 hard fail |
| ConsensusDebate + any single agent | **Never** | Debate excluded from floor |

Risk-exit `PortfolioManager` SELLs can skip entry quorum but **still** require RiskEngine/OMS — they do not unlock BUY frequency.

---

### 2.4 Runtime Pause / Safe Mode

`ArgusRuntime.derivePhase()` maps `tradingState !== TRADING_ENABLED` (or emergency stop) → **`SAFE_MODE`**.

| Snapshot | Phase | tradingState | Autobot |
|---|---|---|---|
| Operator report (earlier) | SAFE_MODE | TRADING_PAUSED | (varies) |
| **This audit live CLI** | **RUNNING** | **TRADING_ENABLED** | **true** |

**Interpretation**

- When paused, RiskEngine gate `emergency_stop` fails closed for **all** new BUYs and SELLs — approvals never reach OMS.
- **Right now**, pause is **not** the reason for inactivity; consensus / stream depth / agent deficit dominate.
- If SAFE_MODE returns: operator must explicitly restore `TRADING_ENABLED` (UI trading toggle / `npm run argus-cli -- enable` / documented trading-state API). Autobot-on alone does **not** clear `TRADING_PAUSED`.

**RiskEngine 24 gates (post-approval)**

- Not the primary inactivity cause while ChiefTrader emits NO TRADE.
- Once approvals resume, expect normal fail-closed behavior: `data_freshness` (need ticks on that symbol), `market_hours`, `autobot_enabled` (BUY), `sell_position_exists` (SELL), capital/notional gates, etc.
- There is **no** `gate_buying_power` / `gate_spread_check` name in the 24-gate catalog; those concerns map to sizing / price validity / broker auth, not separate gate IDs.

---

## 3. Step-by-Step Resolution Action Plan

> Do **not** lower `consensusApprovalThreshold` or `minIndependentAgreeingAgents`. Do **not** bypass RiskEngine/OMS. Paper only.

### A. Confirm operator runtime (today)

1. `npm run argus-cli -- status` → expect `phase: RUNNING`, `tradingState: TRADING_ENABLED`, Autobot on.  
2. If `SAFE_MODE` / `TRADING_PAUSED`: re-enable trading state via UI or CLI (`enable`), then re-check.  
3. `npm run argus-cli -- health` → `activeBroker.id: ibkr_gateway`, port 4002, account verified.

### B. Unlock 90-line IBKR streaming (config / code alignment)

1. **Reviewed config change (preferred product knob):** raise `config/continuousIntelligence.json` `maxActiveSubscriptions` toward IBKR paper capacity (e.g. **90**, ≤ `ibkrConnection.maxMarketDataLines`), and update honesty text. Keep `coreStreamingSymbols` ≤ cap.  
2. **Code hardening (recommended):** `OpportunityDiscovery` should compute `emptySlots` from `marketDataWorker`’s **effective** streaming cap when backend is `ibkr_gateway`, not only from the Alpaca-oriented JSON 12.  
3. Restart Argus after config change; confirm continuous status `activeSymbols.length` climbs well above 12 and `subscribeRequested` fills empty slots.  
4. Leave `momentumHotSwapSlotsPerCycle: 1` unless you accept more churn (architecture already limits thrash at full cap).

### C. Restore multi-agent ideas (without weakening quorum)

1. **Quant:** wait out Alpaca 429 window; reduce concurrent bar fan-out if needed; keep `QUANT_ENGINE_ENABLED=true` only if bars succeed. Confirm agent leaves `FAILED`/`GATED`.  
2. **Keep** `ARGUS_OPPORTUNITY_IDEAS_ENABLED=true` so Screener can supply a second vote on streamed names.  
3. Leave News at `CATALYST_ONLY` unless you deliberately want News entry votes (deskIntelligence reviewed change).  
4. Verify Technical + Kronos both see the **same** dynamic symbols once stream depth increases.

### D. Expect honest consensus outcomes

1. Watch `whyNoTrade` / lastConsensus: need **≥2** independent same-side agents **and** weighted confidence ≥ **0.75**.  
2. Treat single-agent ~25% NO TRADEs as **correct** fail-closed behavior, not a defect.  
3. Export a few `traceId`s that reach `CHIEF_APPROVED_IDEA` → RiskEngine → OMS for paper soak evidence.

### E. Post-approval RiskEngine checklist

1. Ensure subscribed symbols are ticking (`data_freshness`).  
2. RTH open for `market_hours` (Alpaca clock when keys present).  
3. Autobot on for new BUYs; SELLs not blocked by Autobot-off.  
4. Reconcile clean; do not auto-resume from mismatches.

### F. Success criteria (paper)

| Metric | Target |
|---|---|
| Active stream count under IBKR | ≫ 12 and ≤ 90 |
| Discovery `emptySlots` math | Matches MDW effective cap |
| Quant / Technical / Kronos (or Screener) | ≥2 independent same-side votes on some names |
| Approvals | Some `CHIEF_APPROVED_IDEA` under 0.75/2 |
| Orders | OMS `placeOrder` on IB Gateway paper only |
| LIVE | Remains `LIVE_NO_GO` |

---

## 4. Evidence Appendix (this session)

- Discovery: `scanned=122`, `shortlisted=122`, `subscribeRequested=0`, `momentumRanked=8`, `already_subscribed` count **= 12**.  
- Health: `brokerId: ibkr_gateway`, `port: 4002`, `accountId: DUR959160`, `streamingCapacity: 90`.  
- Consensus example: Macro HOLD + Kronos BUY → independent agree **1**, weighted **25.7%** vs **75%**.  
- Config: `maxActiveSubscriptions: 12`; env opportunity loop/ideas **true**; Quant still Alpaca-bar dependent.

---

*Audit only. No consensus floors lowered. Organic paper edge remains unproven until soak counts closed FILLED SELL P&L.*
