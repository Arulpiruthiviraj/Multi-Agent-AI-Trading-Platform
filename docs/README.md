# Argus documentation

Canonical **live-path** rules live in root [`CLAUDE.md`](../CLAUDE.md) (agents: [`AGENTS.md`](../AGENTS.md)). This folder is the rest of the markdown that used to clutter the repo root.

**LIVE real-money trading is NO-GO.** Readiness scores do not rise because files were moved or added. NewsAgent last scored pass: ~44.6% on 242 predictions. Quant walk-forward OOS for checked combos failed.

## Layout

| Folder | Contents |
|---|---|
| [architecture/](architecture/) | Wiring, EventBus, agents, brokers, Kronos, current architecture map |
| [specs/](specs/) | Capability matrices, position/thesis/data specs, missing-capabilities, frontend reality |
| [plans/](plans/) | Implementation / Canadian / remediation roadmaps |
| [reports/](reports/) | Historical audits, baselines, phase reports (`FINAL_ANALYSIS.md` §30 is still the scored readiness audit) |
| [LOCAL_AI_SETUP.md](LOCAL_AI_SETUP.md) | Ollama / Chronos / `npm run setup:ai` |

## Ground truth (do not inflate)

| Document | Use for |
|---|---|
| [`reports/ARGUS_REAL_MONEY_READINESS.md`](reports/ARGUS_REAL_MONEY_READINESS.md) | Readiness scores. LIVE **NO-GO**. |
| [`reports/FINAL_ANALYSIS.md`](reports/FINAL_ANALYSIS.md) | Tab matrix + §30 audit + §31 2026-08-15 honesty pass |
| [`architecture/ARGUS_CURRENT_ARCHITECTURE_MAP.md`](architecture/ARGUS_CURRENT_ARCHITECTURE_MAP.md) | Current wiring snapshot |
| [`plans/QUANT_LAYER_ANALYSIS.md`](plans/QUANT_LAYER_ANALYSIS.md) | Original additive quant design |
| [`specs/ARGUS_MISSING_CAPABILITIES.md`](specs/ARGUS_MISSING_CAPABILITIES.md) | Absent vs unused vs flag-gated |
| [`specs/FRONTEND_REALITY_MATRIX.md`](specs/FRONTEND_REALITY_MATRIX.md) | Per-widget REAL/MOCKED/BROKEN (see §31 for later widget fixes) |

## Checklist: implemented vs still open (2026-08-15)

Cross-checked against `src/`, `scripts/`, `config/`, and the plans/reports in this tree. **Do not “complete” a row by enabling Quant/SMC/LIVE.**

### Done (do not re-build)

- EventBus → agents → ChiefTrader → RiskEngine → OMS → BrokerManager live path
- Config-driven safety numbers (`config/tradingSafety.json`, no strategy-id literals in TS)
- Daily BUY notional gate; restricted-live file ceilings; Argus allocation vs broker equity
- Portfolio recon mismatch sets `TRADING_PAUSED` (RiskEngine `emergency_stop` actually reads it)
- Order cancel API + Arena cancel UI; filled-order recon `FILLED_ORDER_MISSING_LOCALLY`
- Alpaca request timeout / retry / circuit breaker
- Additive quant layer **off** unless `QUANT_ENGINE_ENABLED`; SMC/Bull-Bear and experimental day-trade modules (VWAP structure, ORB, VWAP reversion, Donchian) off by default (`findStrategy` backtests without the flags)
- TradeThesis / `noTradeReasons.json` / thesis invalidation from JSON
- Agent Network win-rate alert from `agent_performance_stats` (not `mockWinRateData`)
- `npm run dev` starts Chronos/Kronos, Ollama, OpenAlice (if checkout), IBKR (if path)
- **This pass:** `POST /api/v1/portfolio/liquidate` emits pipeline SELLs (no `broker.closePosition`); rebalance returns **501**; secrets/test no longer always `{success:true}`; Arena broker list has no Robinhood/Schwab

### Must not fabricate / must not turn on

- Market breadth, options greeks, L2 book, cointegration, TSI, volume profile, CAD FX, historical AI replay
- Canadian automated routing (IIROC) — `markets.json` documents; does not unlock IBKR/Questrade
- SentimentAgent / OrderFlowAgent as live voters
- Second kill switch
- Quant/SMC/Bull-Bear enabled for LIVE “to see if it works”

### Still open (not implemented this pass)

| Item | Why it stays open |
|---|---|
| G–L model tournament / AI lab / paper campaign / restricted-live **product** | `ARGUS_IMPLEMENTATION_PLAN.md` — no edge; LIVE NO-GO |
| Observability & Tracing tab (`audit`) still fabricated | Observatory is the real trace UI; do not duplicate fake traces |
| Mission Control granular module toggles | HIGH RISK; Change Plan awaits explicit approval |
| Many Arena/Intelligence/Learning widgets still mocked | See frontend reality matrix; honesty > fake wiring |
| Settings Secrets Manager “test” for non-Alpaca providers | Honest `implemented: false` only |
| Target-allocation rebalance | 501; not a silent flatten-all |
| Validated trading edge / OOS Quant / NewsAgent calibration | Evidence is against, not missing a file |
| `GET /api/v1/signals` legacy path | Still not the live pipeline; some UI may still call it |

Historical baselines (`ARGUS_HARDENING_BASELINE.md`, etc.) describe **Phase 0**. Later changelogs already closed those P0/P1 items. Do not treat the baseline as the current bug list.
