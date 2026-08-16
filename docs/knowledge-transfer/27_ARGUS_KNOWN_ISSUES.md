# 27 — Known issues and path toward tradable autonomy

Do **not** read “high win rate” as a coding milestone.

## P0 Critical

| Problem | Evidence | Impact | Live? | Direction (not implemented here) |
|---|---|---|---|---|
| No OOS edge | WF failed; News 44.6% | Cannot claim profit | Yes if enabled | Research + paper book; do not add strategies |
| `/api/v1/signals` bypass | `server.ts` | Fake book | If called | Remove or wrap RiskEngine |
| Autobot-off TechnicalAgent | MarketDataWorker always + Technical on ticks | Unattended ideas | Yes | Gate on TRADING_ENABLED/Autobot |
| Remaining fabricated UI | FINAL_ANALYSIS 15.20/31/32 | Operator error | Indirect | Delete/label validation/audit/dashboard shells |
| LIVE validation missing | zero organic closed paper last pass | NO-GO | Yes | Months of fills in trades table |

## P1 High

IBKR 2FA; Coinbase paper refuse; dual quote feeds; backtest missing most live gates; recon pause no flatten; OpenAlice tsc; SQLite single writer; `PORT` unused; `npm run db:migrate` missing.

## P2 Medium

Alpaca status=all pagination; canceled spelling; App.tsx hook login leak; equity `|| 10000` fallback.

## P3 Low

Ichimoku missing; taxonomy 760 confusion; AGENTS.md ATR vs 0.05.

## P4 Enhancement

Fractional shares **after** broker+risk; Canadian **legal** venue; unattended IBKR likely impossible.

## “100% tradable autonomous high win rate”

**Impossible as a patch list.** Software gates (32.5–32.6 in FINAL_ANALYSIS) get you to *safer paper*. Win rate requires pre-registered OOS **pass**, PIT AI logs, costed fills, and calibrated probabilities. Enabling Quant flags does not create edge.
