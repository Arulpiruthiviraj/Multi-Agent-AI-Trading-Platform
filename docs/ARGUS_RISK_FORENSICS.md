# Argus RiskEngine forensics

24 gates. Catalog order: `config/riskGateOrder.json` (**UI catalog only**). Pass/fail from `risk_gate_results` / `RISK_GATE_EVALUATED`.

**CODE-VERIFIED** — `src/server/engines/RiskEngine.ts`, CLAUDE.md §2, `tradingSafety.json`, settings defaults.

All gates are **recorded** even after the first failure. The **first failure in evaluation order** is `risk_assessments.rejection_gate`. AI cannot override.

Persist-then-emit: if insert fails, `RISK_BLOCK` and **no** `RISK_ASSESSMENT_COMPLETED` → OMS never runs (P0.3).

Serialized: `evaluationQueue` mutex (DEF-09).

LIVE unknown sizing inputs fail-closed. Zero-quantity CLAMPED is **FAIL**, never silent pass.

---

## How to answer “Why did RiskEngine reject?”

```sql
SELECT approved, rejection_gate, max_quantity, reasoning, account_equity
FROM risk_assessments WHERE trace_id = '…';

SELECT sequence, gate_name, passed, detail
FROM risk_gate_results WHERE trace_id = '…' ORDER BY sequence;
```

HTTP: `GET /api/v2/diagnostics/why/:transactionId`.

---

## Gate list

Numbers in parentheses are production defaults from config/settings as of consolidation. Do not copy into TypeScript; load config.

| # | Gate | Pass | Fail | Blocks? | Persisted |
|---|---|---|---|---|---|
| 1 | emergency_stop | `tradingState === TRADING_ENABLED` | PAUSED or EMERGENCY_STOP | Yes | detail + rejection if first |
| 2 | autobot_enabled | SELL always; BUY requires Autobot on | New BUY while Autobot off | BUY only | yes |
| 3 | same_symbol_cooldown | No FILLED same-symbol trade within `sameSymbolCooldownMs` 300000 | Recent fill | BUY | yes |
| 4 | post_loss_cooldown | No losing fill within `postLossCooldownMs` 900000 | After loss | BUY | yes |
| 5 | daily_trade_limit | BUY count < `maxDailyTrades`; **0 = skipped** | At cap | BUY | yes |
| 6 | duplicate_signal | No same symbol/side assessment within `duplicateSignalWindowMs` 60000 | Duplicate | Yes | replay skipped |
| 7 | invalid_account_equity | Broker equity finite > 0 | Missing/non-positive. **No $10000 placeholder** | Yes; later gates SKIPPED_INVALID_ACCOUNT_EQUITY | yes |
| 8 | daily_loss | dailyLoss < limit × `dailyLossKillSwitchFraction` 0.8; NY calendar | Breach. LIVE min cap $1000 restricted-live | Yes | yes |
| 9 | consecutive_loss | Last `maxConsecutiveLosses` 3 FILLED not all losers | 3 losing streak | Yes | yes |
| 10 | portfolio_drawdown | (peak−equity)/peak < `maxPortfolioDrawdownPct` default 0.15 | Drawdown | Yes | yes |
| 11 | order_rate_limit | risk_assessments in 60s < `maxOrdersPerMinute` default 5 | Too fast | Yes | replay skipped |
| 12 | market_hours | Alpaca clock open | Closed. HTTP fail **fail-closed**. Unconfigured keys **skip/pass** | Yes if keys | yes |
| 13 | data_freshness | Tick age ≤ 300000 | Stale **or null age** (DEF-08) | Yes | yes |
| 14 | news_veto | No cluster in 4h with impact > 80 covering symbol | Direction-blind veto | Yes | yes |
| 15 | price_validity | listed ticker AND finite price > 0 | INVALID_SYMBOL / MISSING_PRICE / … | Yes | yes |
| 16 | order_notional_cap | PositionSizing notional ≤ maxTradeSize / LIVE $5000 | Too large | Yes | yes |
| 17 | symbol_concentration | Position ≤ 20% equity | Concentration | Yes | yes |
| 18 | open_positions_cap | Names ≤ settings / LIVE 3 | Too many | Yes | yes |
| 19 | sector_concentration | Sector ≤ 40% | Sector cap | Yes | yes |
| 20 | correlation_exposure | If overlap≥20 and corr≥0.7, exposure ≤ 50% | Correlated book | Yes | yes |
| 21 | sufficient_size | Whole shares ≥ 1 after stops/BP. Stop/share = `stopLossAssumptionPct` 0.05 **not ATR** | Zero size | Yes | yes |
| 22 | sell_position_exists | SELL qty > 0 locally | SELL with no position | SELL only; BUY omits row | yes on SELL |
| 23 | argus_capital_allocation | BUY notional ≤ remaining `settings.budget` allocation | Over Argus budget (not broker equity) | BUY | yes |
| 24 | daily_buy_notional | Session BUY $ vs paper `maxDailyBuyNotionalDollars` / LIVE restricted cap | Cap | BUY | yes |

Replay research clock forces ENABLED for some gates — not live.

---

## Logs

`[Risk Engine] Failed to persist risk assessment`. Diagnostic `RSK-001`. Event `RISK_GATE_EVALUATED` may **not** be in EventStore persist[] — trust the table.

Position sizing module: `src/server/engines/PositionSizing.ts` (FIXED_DOLLAR default $3000). Shared with BacktestEngine.
