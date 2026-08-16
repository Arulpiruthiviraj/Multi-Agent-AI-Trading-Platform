# ARGUS real-money readiness — Phase 16

**Date:** 2026-08-16  
**LIVE:** **NO-GO**  
**PAPER (restricted):** **CONDITIONAL GO** — Autobot-off blocks new BUY; SELL/exits still require `TRADING_ENABLED`; no validated edge.

Scores only move when evidence closes a gap. Adding files does not raise a score.

## Scorecard

| Area | Score | Evidence |
|---|---|---|
| Software readiness | 78 | `npx tsc --noEmit` exit 0. Vitest **909/909** with `fileParallelism: false` plus Chronos/OpenAlice isolation in `vitest.setup.ts`. UI still largely untested. |
| Execution readiness | 55 | Single path EventBus → ChiefTrader → RiskEngine → OMS unchanged. Legacy `/api/v1/signals` remains 410. InternalPaperBroker is the default. LIVE routing and Canadian execution remain blocked. |
| Risk readiness | 72 | `autobot_enabled` still blocks BUY. New configurable gates: `same_symbol_cooldown`, `post_loss_cooldown`, `daily_trade_limit` (0 = unlimited), `duplicate_signal`. Capital allocation still distinct from broker equity. Not a second kill switch. |
| AI readiness | 40 | AIRouter failover exists. OpenAlice/Chronos remain optional. Debate is not a calibrated probability. PIT empty ledger no longer counts as AI-approved BUY. |
| Quant readiness | 48 | Core five strategies + UNVALIDATED SMC. Live Quant emit requires strategy EV + min R:R; **regime-only fallback no longer emits**. QUANT_ENGINE_ENABLED still default off. Walk-forward OOS still failed in prior scored passes. |
| Paper validation readiness | 28 | Paper report + lifecycle table exist. Sample of organic closed paper trades in this environment is still **insufficient** for statistical claims (`minTradesForPaperValidation` = 30 from `tradingSafety.json`). |
| Trading-edge readiness | **8** | No empirically validated live edge. News accuracy and OOS quant results from the last honest pass were not re-run as a new edge study in this phase. |
| Canadian-market readiness | 35 | Metadata now includes TSX/TSXV/**CSE**, CAD, Toronto TZ. Banner: **CANADIAN LIVE EXECUTION: NOT AVAILABLE**. IBKR/Questrade `canadianEquities` remains false. |
| Observability readiness | 58 | StartupHealthRegistry, desk lifecycle API, capital snapshot `available:false` on broker throw. Event-memory canned 82% Trade War path is **410**. Digital Twin still event-driven; no new fake animation layer. |

**Overall (not an average of marketing):** software can compile and test; **money-risk LIVE remains blocked**.

## Verdicts

### RESTRICTED PAPER
Allowed when Autobot is on, `tradingMode` is PAPER, RiskEngine gates pass, and Argus `settings.budget` is the allocation ceiling.

### CONDITIONAL PAPER
Default boot: Autobot **off** → no new BUY. Optional services (Chronos, Ollama, OpenAlice, Quant) may be DISABLED/FAILED; the app must stay usable.

### RESTRICTED LIVE
**BLOCKED.** Restricted-live caps exist in config but LIVE enablement is still NO-GO.

### FULL LIVE
**BLOCKED.**

## Critical blockers (LIVE)

1. No statistically validated strategy (UNTESTED / INSUFFICIENT_SAMPLE).
2. Empty organic closed-trade sample for EV/Kelly in this environment.
3. Canadian automated routing legally/technically blocked.
4. Broker 2FA (IBKR) and Questrade placeOrder refusal.
5. PIT AI debate is still `debateReplayed: false`.
6. Quant live ideas suppressed without closed-trade EV (honest, but not an edge).
7. Safety-gate bundle in the Phase 16 spec (crash recovery + paper sample + permutation + Canadian routing) is not a green LIVE checklist.

## What this phase did **not** pretend to do

- Did not enable LIVE or `QUANT_ENGINE_ENABLED`.
- Did not invent win rate, Sharpe, or “elite trader” performance.
- Did not implement a second OMS or bypass RiskEngine for SELL.
- Did not wire 1m–daily multi-timeframe execution as a new live path.
- Did not claim ORB/gap/HOD detectors that have no bar-level detector (`DATA UNAVAILABLE` in SetupEngine).
