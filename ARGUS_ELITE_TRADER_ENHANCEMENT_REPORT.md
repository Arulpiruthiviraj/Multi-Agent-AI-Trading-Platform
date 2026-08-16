# Argus Elite Trader Enhancement Report

Date: 2026-08-16  
Constraint honored: **no rewrite of EventBus → ChiefTrader → RiskEngine → OMS**. LIVE autonomous trading remains **off**. QUANT live remains **off** unless the operator already set `QUANT_ENGINE_ENABLED=true`.

---

## Phase A — Repository audit (what already existed)

| Capability | Status before this pass | Where |
|---|---|---|
| Multi-agent ideas → ChiefTrader → RiskEngine → OMS | Implemented | `ChiefTraderAgent.ts`, `RiskAgent.ts`, `RiskEngine.ts`, `OrderManagement.ts` |
| Capital allocation vs broker equity | Implemented | `CapitalAllocation.ts`, `settings.budget` |
| Position sizing ceilings | Implemented | `PositionSizing.ts` |
| Regime classifier (trend/range + vol) | Implemented | `quant/RegimeEngine.ts` (`BULLISH_TREND` / `BEARISH_TREND` / `SIDEWAYS_RANGE`) |
| SPY/QQQ/IWM + sector RS | Implemented | `quant/MarketContext.ts` (breadth honestly `available: false`) |
| Strategy ensemble (five CORE) | Implemented | `StrategyEngine.evaluateAll` + experimental modules behind env flags |
| Regime mismatch discount | Implemented | `regimeMismatchConfidenceMultiplier` |
| Structured TradeThesis + NO_TRADE catalog | Partial | `assembleTradeThesis.ts`, `config/noTradeReasons.json` (Quant path only) |
| EV / R:R / Kelly (quant, not RiskEngine sizing) | Implemented | `quant/risk/ExpectedValue.ts`; QuantSignalAgent refuses non-positive EV |
| Bull/Bear debate | Partial | ChiefTrader debate + optional `QUANT_BULL_BEAR_ENABLED` |
| LLM numeric hallucination guard | Implemented | `parseResearchNote.ts` nulls invented entry/stop/EV |
| Thesis invalidation / portfolio watcher | Implemented | `ThesisInvalidation.ts`, `PortfolioMonitor.ts` |
| News as BUY/SELL voter | **Wrong for a desk** | `NewsEngine.ts` emitted `TRADE_IDEA_GENERATED` |
| Autobot off = no new BUY | **Broken** | `RiskEngine` ignored `enabled`; timer agents ungated |
| Data-quality GREEN/YELLOW/RED | Partial | `data_freshness` gate only |
| PIT backtest / walk-forward harness | Implemented | `backtest/`, `MonteCarlo.ts` OVERFIT_REJECTED |
| Canadian live routing | Blocked (correct) | IBKR/Questrade adapters; `markets.json` does not unlock IIROC |
| UI honesty | Partial | Many `AwaitingSignal`; event-memory still theatrical |

Unused / do not treat as live voters: `MarketRegimeAgent.ts` (LLM), `AdvancedQuantEngines.ts` (telemetry).

---

## Phase B — Where enhancements fit (no second pipeline)

```
MARKET DATA (MarketDataWorker, ungated ingest)
    → tick agents gated by isLiveIdeaGenerationEnabled (Technical, Kronos)
    → timer agents now gated the same way (Fundamental, Macro)
    → NewsEngine: NEWS_CATALYST (not TRADE_IDEA by default)
    → QuantSignalAgent: still opt-in QUANT_ENGINE_ENABLED; now also Autobot + desk ranking
SPECIALIST IDEAS
    → ChiefTrader (unchanged consensus math + debate)
    → DESK_NO_TRADE / TRADE_LIFECYCLE events (additive)
    → RiskEngine (NEW recorded gate autobot_enabled on BUY only)
    → OMS / BrokerManager
POSITIONS
    → PortfolioMonitor SELL ideas (exits) still allowed with Autobot off if TRADING_ENABLED
RECON
    → flatten BEFORE pause so pipeline SELLs can pass emergency_stop
```

Config overlay: `config/deskIntelligence.json` (reviewed file, not a UI knob).

---

## Phase C — Changes made

### Reused (not duplicated)

- `RegimeEngine`, `MarketContext`, `StrategyEngine`, `ExpectedValue`, `assembleTradeThesis`, `noTradeReasons.json`, `ideaGenerationGate`, `CapitalAllocation`, `RiskEngine` gate ladder, `PipelineFlatten`, `PortfolioMonitor`, `parseResearchNote`, PIT ledger.

### New / modified

1. **`autobot_enabled` RiskEngine gate** (`RiskEngine.ts`)  
   BUY requires `tradingEngine.state.enabled === true`. SELL/exits are not blocked by Autobot-off. Not a second kill switch: `emergency_stop` still owns pause/halt.

2. **Timer idea leak**  
   `FundamentalAgent` / `MacroAgent` return immediately unless `isLiveIdeaGenerationEnabled()`. Quant emit is gated the same way. Assessments can still persist when Autobot is off.

3. **News as catalyst**  
   Default `deskIntelligence.newsEmitsTradeIdeas: false`. `NewsEngine` records `NewsCatalystStore` + `NEWS_CATALYST`. Clusters / `news_veto` unchanged.

4. **Regime-aware ensemble ranking**  
   `rankEvaluationsForRegime` uses JSON family weights. Does not look at future bars. Does not change `evaluateAll` confidence math (tests that pin 0.5 mismatch still hold). QuantSignalAgent picks via ranked list; HIGH vol applies `highVolatilityConfidenceMultiplier` at pick time only.

5. **Min R:R** from `deskIntelligence.minRiskRewardRatio` on Quant strategy ideas (in addition to existing EV gate).

6. **Thesis “why NOT”** additive fields on `TradeThesis`.

7. **Data quality snapshot** `assessDataQuality` — RED stale ticks can suppress Quant emit.

8. **Recon flatten order** — `submitPipelineSells` while still `TRADING_ENABLED`, then pause.

9. **Observability**  
   `GET /api/v2/desk/intelligence`, `EliteDeskPanel` on Scanner tab, `DESK_NO_TRADE` / `TRADE_LIFECYCLE` events.

10. **Diagnostics** `GATE_FIX.autobot_enabled`.

### Not implemented in this pass (honest)

- Full 18-state persisted lifecycle machine (partial events only).
- Chronos calibration scorecard UI (forecast agent already exists).
- Canadian execution unlock.
- Promoting experimental strategies to CORE / enabling QUANT live.
- Replacing ChiefTrader majority math with a new governor.
- Guaranteed OOS edge, CAGR, or “$10/day”.
- Event-memory 82% theater (`server.ts` GET `/api/v1/event-memory`) — still dishonest; not expanded.
- LIVE capital.

---

## Strategies / calculations

- **Live `evaluateAll`:** still five CORE unless experimental env flags are true (unchanged).
- **Ranking overlay:** family relevance in `deskIntelligence.json` (momentum/trend/mean_reversion/…).
- **EV:** still `ExpectedValue.ts`; still labeled by sample size in Quant (insufficient sample = no live strategy idea). Probability quality strings live in JSON (`EMPIRICALLY_VALIDATED` / `MODEL_ESTIMATE` / `UNAVAILABLE`) for UI; Quant still **refuses** to emit when sample is empty.

---

## AI models / agents

Unchanged router: Gemini / OpenAI / DeepSeek / Nvidia / Ollama-compatible via `AIRouter`. Bull/Bear still opt-in. News LLM is for catalyst text, not an automatic order. OpenAlice remains non-blocking.

---

## Tests added / updated

- `deskIntelligence.test.ts`
- `NewsCatalystStore.test.ts`
- `assembleTradeThesis.desk.test.ts`
- RiskEngine unit + gates: Autobot BUY block / SELL not blocked
- Fundamental/Macro: mock idea gate open
- QuantSignalAgent: Autobot on for emit assertion
- Override + recon + restricted-live + transaction-lifecycle: `enabled = true` so BUY tests still exercise downstream gates

**Verification (this pass):** `npx tsc --noEmit` exit 0. `npx vitest run` — **892 passed** (138 files).

---

## Bugs discovered (fixed here)

- Autobot off did not stop BUY at RiskEngine (`enabled` unused).
- NewsAgent voted BUY/SELL independently of technical confirmation.
- Auto-flatten after pause could not pass `emergency_stop`.

---

## Remaining weaknesses / limitations

- Autobot-off **does not** stop MarketDataWorker ingest (by design: quotes still needed).
- Regime-only Quant fallback (`deriveIdeaFromRegime`) can still emit without strategy EV if Autobot+QUANT are on.
- Empty PIT ledger still allows technical-only backtest BUYs.
- Walk-forward OOS for checked combos previously failed; nothing in this pass claims they now pass.
- One prior vitest timeout on `/api/v2/quant/strategies` when OpenAlice is enabled in `.env` may still exist (environment hang, not desk overlay).

---

## Real-money readiness

**Unchanged: NO-GO for live capital.**  
Paper: **conditional** — Autobot **on**, paper/internal broker, flatten flag default false, operator accepts no validated edge.

**Blockers for LIVE (unchanged plus honesty):** no proven OOS edge; IBKR 2FA; Canadian routing blocked; QUANT experimental UNVALIDATED; restricted-live caps are ceilings not an edge.

---

## Recommended next phase

1. Persist trade-lifecycle rows (not only EventBus).  
2. Attach catalysts into ChiefTrader evidence **without** restoring News BUY votes.  
3. Remove or quarantine `GET /api/v1/event-memory` theater.  
4. Fill PIT ledger in paper, then run walk-forward **without** inventing LLM debate.  
5. Do not enable `QUANT_ENGINE_ENABLED` or LIVE to “see if it works.”

---

*Default question remains: is there a sufficiently strong, evidence-backed asymmetric opportunity, with a defined invalidation, before risking capital? If not: **NO TRADE**.*
