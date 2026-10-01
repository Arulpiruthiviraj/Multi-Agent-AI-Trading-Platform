# ARGUS Campaign Tracker

Goal-oriented daily campaign & strategy attribution. **Additive, flag-gated** (`settings.campaign_enabled`, default **off**).

**Honesty:** Enabling a campaign does **not** lower ChiefTrader consensus (`0.75` / min **2** independent agents), does **not** bypass RiskEngine / PositionSizing / OMS, and does **not** invent organic edge. Organic PAPER FILLED SELL P&L remains soak-counted separately (`LIVE_NO_GO` until floors pass).

## Architecture (non-negotiable)

- Does **not** call `placeOrder` or invent a second kill switch.
- Campaign allocation is `settings.budget` → `CapitalAllocation.snapshotCapital` → gate **`argus_capital_allocation`** (Gate 23). No parallel sizing ledger.
- When `campaign_enabled`, RiskEngine additionally applies **capital velocity** clamps from `config/tradingSafety.json` (`campaignMaxConcurrentPositions`, `campaignPositionBudgetFraction`) so single-order notional ≤ remaining allocation / slot budget — still fail-closed at Gate 23.
- Targets live in **settings** (`daily_target_amount`, `daily_target_type`, `target_achieved_action`, optional `close_positions_before_market_close`), not hardcoded TypeScript literals.

## Settings (SQLite `settings` row)

| Field | Role |
|---|---|
| `budget` | Argus allocated fund (Gate 23 ceiling) |
| `campaign_enabled` | Master switch |
| `daily_target_amount` / `daily_target_type` | `DOLLAR` or `PERCENT` of budget |
| `target_achieved_action` | `LOCK_AND_IDLE` \| `TRAIL_STOPS_ONLY` \| `CONTINUE` |
| `close_positions_before_market_close` | Optional EOD flatten (~15:55 ET risk-exit SELL ideas) |

## Progress & target actions

`progress = (dailyRealized + dailyUnrealized) / targetDollars`.

When progress ≥ 1.0:

| Action | Behavior |
|---|---|
| `LOCK_AND_IDLE` | Emit `CAMPAIGN_TARGET_REACHED`; BUY soft-lock for NY date; badge **TARGET LOCKED**; PortfolioMonitor **tightens** trailing stop (`campaignTrailStopsOnlyPct`) |
| `TRAIL_STOPS_ONLY` | Same BUY soft-lock; badge **CAPITAL PRESERVED**; same trail tighten |
| `CONTINUE` | Emit `CAMPAIGN_TARGET_REACHED` (logged); **no** BUY lock; evaluation continues |

Gate wiring (`ideaGenerationGate.ts`): soft-lock blocks **NEW BUY / entry ideas** only. PortfolioMonitor risk-exit **SELL** ideas are not gated. Lock clears at America/New_York day boundary (and when campaign disabled). Not `EMERGENCY_STOP` / `TRADING_PAUSED`.

## Attribution

- Opening BUY `quant_strategy_id` preferred; else `quant_invalidation_json` / reasoning CORE ids; else `agent_predictions` → `AGENT:<name>`; else `UNATTRIBUTED`.
- Upserts `daily_strategy_performance` unique on `(trading_date, quant_strategy_id)`.
- Refresh on `ORDER_EXECUTED` (FILLED) + portfolio-cadence interval.

## Campaign effort telemetry (observability only)

In-memory NY-day counters (scans, strategy evals/rejects, near-miss consensus 0.65–threshold, confluence nudges, watchlist subscribes) on `GET /api/v2/campaign/status` → `effort` and `GoalCampaignCard`. Never sizes or forces trades.

## Intraday day-trader helpers (campaign_enabled only)

| Piece | Behavior |
|---|---|
| `CampaignOpeningSurge` | Once per NY date in **09:30–09:40 ET**: RVOL + ORB (+ optional high catalyst). Watchlist + `CAMPAIGN_CONFLUENCE_NUDGE` only — **never** `emitTradeIdea` / `placeOrder`. Optional Quant re-eval only if `QUANT_ENGINE_ENABLED` already true |
| `CampaignWatchlistBoost` | Liquid universe subscribe requests while campaign on |
| PortfolioMonitor ATR scalp | Today’s campaign opens: Target-1 ≈ entry + `campaignIntradayAtrTargetMultiple` × ATR; then BE + `campaignIntradayBreakevenPadPct` stop |
| EOD flatten | If `close_positions_before_market_close`: risk-exit SELL ideas in window before 16:00 ET (still ChiefTrader → RiskEngine → OMS) |

## API

- `GET /api/v2/campaign/status`
- `PATCH|POST /api/v2/campaign/settings` — `campaignEnabled`, `dailyTargetAmount`, `dailyTargetType`, `targetAchievedAction`, `closePositionsBeforeMarketClose`, optional `budget`

## UI

`GoalCampaignCard` on the Dashboard. Badges: `PURSUING GOAL` | `TARGET LOCKED` | `CAPITAL PRESERVED` | `DISABLED`.

## Code map

- `src/server/services/CampaignTracker.ts`
- `src/server/services/campaignStrategyAttribution.ts`
- `src/server/services/campaignEffortTelemetry.ts`
- `src/server/services/CampaignWatchlistBoost.ts`
- `src/server/services/CampaignOpeningSurge.ts`
- `src/server/services/campaignIntraday.ts`
- `src/server/core/campaignBuyLock.ts` / `ideaGenerationGate.ts`
