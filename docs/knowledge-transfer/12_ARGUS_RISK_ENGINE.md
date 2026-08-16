# 12 — Risk engine

File: `src/server/engines/RiskEngine.ts`. Serialized evaluate. **AI cannot override. Strategy cannot bypass. Broker cannot skip this on the live path.** `/signals` **can** bypass.

Thresholds: `config/tradingSafety.json` + settings. Restricted LIVE: `RestrictedLiveMode.ts` file ceilings ($5k order, 3 positions, $1k daily loss) — not a UI knob.

## Gates in evaluation order (18 recorded)

| Gate | Purpose | Config | Hardcoded bits | Paper | Live | Backtest |
|---|---|---|---|---|---|---|
| emergency_stop | tradingState must be TRADING_ENABLED | state | Also blocks TRADING_PAUSED | Yes | Yes | No (parity slice uses other preds) |
| daily_loss | 0.8 × daily limit; LIVE min $1000 restricted | JSON + settings | fraction 0.8 | Yes | Yes | Inequality |
| consecutive_loss | N losses | maxConsecutiveLosses 3 | | Yes | Yes | Inequality |
| portfolio_drawdown | vs peak | settings default 15% | | Yes | Yes | Inequality |
| order_rate_limit | /min | settings default 5 | 60s window | Yes | Yes | Sim time |
| market_hours | Alpaca clock | skip if no keys | **fail-closed** if keys and clock HTTP fails | Skip unconfigured | Fail-closed | No |
| data_freshness | tick age | 300000 ms | | Yes | Yes | No |
| news_veto | impact >80, 4h, **direction-blind** | clusters | 80/4h in engine | Yes | Yes | No |
| price_validity | finite price | | | Yes | Yes | N/A |
| order_notional_cap | PositionSizing | maxTradeSize | | Yes | +$5k LIVE | Shared sizing |
| symbol_concentration | 20% | JSON | | Yes | Yes | No |
| open_positions_cap | | settings / LIVE 3 | | Yes | Yes | No |
| sector_concentration | 40% | JSON | GICS map | Yes | Yes | No |
| correlation_exposure | 0.7 corr, 50% | JSON | 90d lookback | Yes | Yes | No |
| sufficient_size | whole share | | | Yes | Yes | Shared |
| sell_position_exists | SELL | portfolio | | Yes | Yes | Long-only different |
| argus_capital_allocation | budget ≠ broker equity | settings.budget | | Yes | Yes | No |
| daily_buy_notional | session BUY $ | paper 0=off; LIVE 15000 | | Optional | Always restricted cap | No |

Tests: `RiskEngine.test.ts`, concurrency, restrictedLive, DailyBuyNotional, PositionSizing, recon tradingBlock.

**Example:** broker $2000, Argus budget $100 → $101 BUY fails allocation. Weakness: equity fallback `|| 10000` in some paths (see RiskEngine) — **KNOWN**.
