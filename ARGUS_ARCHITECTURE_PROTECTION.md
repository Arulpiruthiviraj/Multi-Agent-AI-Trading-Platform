# Argus Architecture Protection

This document defines what in Argus is **protected** (extend only through documented interfaces, never bypass/replace/weaken) and what is the **extension zone** (safe to build in). It is the reference `CLAUDE.md`'s "ARGUS CORE ARCHITECTURE — DO NOT MODIFY" section points to. Written 2026-08-18 against the live repository; this codebase is under active, fast-moving development (multiple concurrent work streams observed while writing this document — see the note at the bottom), so treat this as the current contract, not a historical snapshot.

## The immutable execution spine

```
MARKET DATA (MarketDataWorker / Alpaca WS)
    ↓
IDEA GENERATION (TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent, KronosForecastAgent, QuantSignalAgent, PortfolioMonitor risk-exits)
    ↓  TRADE_IDEA_GENERATED (via EventBus.emitTradeIdea)
ChiefTraderAgent
    ↓  reviewIdea() → (optional ConsensusDebate) → evaluateConsensus()
RiskEngine (all 24 gates, config/riskGateOrder.json)
    ↓  RISK_ASSESSMENT_COMPLETED
OrderManagementService (OMS)
    ↓  authorizeProductionOrder (P0.1) → placeOrder
BrokerManager → Broker adapter (Alpaca / IBKR / Coinbase / Questrade)
    ↓
trades + fills → Portfolio → Reconciliation
```

No new component may skip a stage this spine requires. Concretely:

- **No scanner, agent, discovery service, or portfolio monitor may call `BrokerManager.placeOrder()`, `OrderManagementService`, or any broker adapter directly.** `OMS` is the sole production `.placeOrder(` caller — enforced today by `phase21.invariants.test.ts`.
- **No new idea source may emit anything other than `TRADE_IDEA_GENERATED`** via `eventBus.emitTradeIdea(...)`. That is the one door into the spine.
- **No new component may bypass `ChiefTraderAgent`'s consensus math** (`consensusApprovalThreshold`, `minIndependentAgreeingAgents`) except the existing, narrow `PortfolioManager` risk-exit bypass (`isRiskExit()` in `ChiefTraderAgent.ts`), which skips debate/quorum but never skips RiskEngine — that exception is capital preservation, not a template for new bypasses.
- **No new component may weaken, reorder, or skip any of RiskEngine's 24 gates** (`config/riskGateOrder.json` is catalog order only; pass/fail is always read from `risk_gate_results`, never assumed).
- **No new component may auto-resume trading after a kill-switch or reconciliation pause.** `TRADING_PAUSED` / `EMERGENCY_STOP` require an operator action; `autoFlattenOnReconciliationMismatch` stays `false`.
- **No new component may change `consensusApprovalThreshold`, `minIndependentAgreeingAgents`, or any RiskEngine numeric gate to increase trade frequency.** Numbers live in `config/tradingSafety.json`, reviewed changes only, never a runtime/UI knob for this purpose.
- **No new component may arm LIVE, flip `PAPER_TRADING_ONLY`, or add an env-var shortcut around the 5-layer LIVE arming sequence.**

### Protected components (extend via documented interface; never replace, duplicate, or bypass)

| Component | File(s) | Documented extension point |
|---|---|---|
| ChiefTraderAgent | `src/server/services/ChiefTraderAgent.ts` | Emit `TRADE_IDEA_GENERATED`; it already listens |
| RiskEngine | `src/server/engines/RiskEngine.ts` | None for new gates without an explicit reviewed config change; existing gates read `config/tradingSafety.json` |
| OrderManagementService | `src/server/services/OrderManagement.ts` | None — sole order path |
| BrokerManager | `src/server/core/BrokerManager.ts` (+ adapters) | None from application code |
| Reconciliation | `src/server/services/PortfolioReconciliation.ts` + `portfolioReconcileCompare.ts` | Read-only consumption of `reconciliation_events` |
| Kill switch / trading-state machine | `TradingEngine.ts`, `kill_switch_events` | Read `tradingState`; never write it except through the existing toggle/emergency-stop/resume routes |
| Portfolio accounting | `portfolio`, `trades`, `fills` tables | Read-only from anything outside OMS/reconciliation |
| Order lifecycle / fill processing | `fillLedger.ts`, `OrderManagement.ts` | None |
| Position reconciliation | `PortfolioReconciliation.ts` | None |
| Paper/live safety controls | `liveOrderAuthorization.ts`, `RestrictedLiveMode.ts`, 5-layer arming in `TradingEngine.toggle()` | None |

### Extension zone (safe to build in, already the pattern this codebase uses)

Everything upstream of `TRADE_IDEA_GENERATED`: idea agents, discovery/scanning, asset classification, strategy research, ranking, candidate lifecycle, observability. The existing, live examples of this pattern (all additive, all flag-gated OFF by default, all fail back to unchanged behavior when their flag is off):

- `src/server/multiAsset/` — asset classification, penny/micro safety filter, strategy eligibility. Hooks into the spine at exactly two points: `EventBus.emit()` (gates a `TRADE_IDEA_GENERATED` payload before ChiefTrader ever sees it) and `RiskEngine`'s position-sizing call (can only *lower* a notional cap, never raise one). Both are no-ops when `ARGUS_MULTI_ASSET_ENABLED`/`ARGUS_PENNY_STOCK_ENABLED` are false.
- `src/server/continuous/` — `OpportunityDiscovery.ts` (watchlist-expansion loop; never emits `TRADE_IDEA_GENERATED`, only `WATCHLIST_SUBSCRIBE_REQUESTED`) and `portfolioIntel.ts` (already wired into `PortfolioMonitor.ts` for auto-subscribing held positions and exit-idea telemetry/cooldown; still emits SELL through the same `emitTradeIdea` → ChiefTrader → RiskEngine → OMS path PortfolioMonitor always used).
- `src/server/core/pipelineAgentHealth.ts`, `ideaUniverse.ts`, `consensusExplanation.ts` — observability/heartbeat and plain-language "why no trade" helpers. Pure read/report layers; they do not touch order flow.

New autonomous-engine work (discovery ranking, candidate lifecycle, broader universe support) belongs in this zone, following the same shape: additive module → emits `TRADE_IDEA_GENERATED` or a watchlist-subscribe request → flag-gated OFF by default → existing spine does the rest.

## If a request seems to require touching the protected zone

Stop. State the conflict plainly instead of implementing a bypass. In practice this has already come up once in this codebase: penny/micro stocks are currently **hard-blocked from ever executing** by `config/multiAsset.json`'s `execution.marketOrdersFitPennyAndMicro: false`, because OMS only submits MARKET orders and a MARKET order on a thin, wide-spread penny stock is unsafe. Making penny stocks actually tradable requires OMS to gain LIMIT-order support — a real, reviewed, protected-zone change, not something an idea-generation or discovery feature can route around. That is the correct behavior: the safety filter refuses rather than finding a workaround, and this document is why.

## Note on repository state

While writing this document, files this document describes (`tradingSafety.json`, `EvidenceAggregator.ts`, `ChiefTraderAgent.ts`, plus new files `pipelineAgentHealth.ts`/`ideaUniverse.ts`/`consensusExplanation.ts`) changed on disk from a source other than this session — consistent with another active Claude Code session or background agent working on this same repository concurrently. Everything documented above was verified against the repository state as of that concurrent activity, and the changes observed were additive/compatible with what's described here, not conflicting. If you're reading this later, re-verify against current code before treating any specific file/line reference as still accurate — the *shape* of the spine and the extension-zone pattern are the durable parts of this document.
