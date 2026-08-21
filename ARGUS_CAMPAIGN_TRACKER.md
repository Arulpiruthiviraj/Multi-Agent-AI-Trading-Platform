# ARGUS Campaign Tracker

Goal-oriented daily campaign & strategy attribution. **Additive, flag-gated** (`settings.campaign_enabled`, default off).

## Architecture (non-negotiable)

- Does **not** bypass RiskEngine, ChiefTrader consensus, PositionSizing, or OMS.
- Does **not** create a second `placeOrder` path or second kill switch.
- Does **not** lower consensus `0.75` / `minIndependentAgreeingAgents` 2.
- Does **not** force trades when there is no consensus.
- Campaign budget is `settings.budget` → CapitalAllocation → gate `argus_capital_allocation` (no parallel sizing).
- Targets live in **settings** (`daily_target_amount`, `daily_target_type`, `target_achieved_action`), not `tradingSafety.json`.

## BUY soft-lock (`LOCK_AND_IDLE` / `TRAIL_STOPS_ONLY`)

When daily progress ≥ 1.0:

| Action | Behavior |
|---|---|
| `LOCK_AND_IDLE` | Emit `CAMPAIGN_TARGET_REACHED`; set in-memory BUY soft-lock for the NY session date |
| `TRAIL_STOPS_ONLY` | Same BUY soft-lock + event; trail exits remain PortfolioMonitor `trailingStopPct` (no new trail math here) |
| `CONTINUE` | Track/attribute only; no BUY lock |

Gate wiring (`ideaGenerationGate.ts`):

```
isLiveIdeaGenerationEnabled() ===
  isAutobotTradingEnabled() && allowsNewEntryIdeas() && !isCampaignBuyLocked()
```

- Soft-lock blocks **NEW BUY / entry idea generation** only (same Autobot-style entry gate).
- PortfolioMonitor risk-exit **SELL** ideas are **not** gated here; ChiefTrader still allows `isRiskExit` when idea generation is off.
- Lock clears at America/New_York day boundary (and when campaign is disabled).
- This is **not** `EMERGENCY_STOP` / `TRADING_PAUSED`.

## Attribution

- Listens to `ORDER_EXECUTED` (FILLED) + light interval refresh.
- Realized P&L from organic FILLED SELLs matched to opening BUY `quant_strategy_id` (else `UNATTRIBUTED`).
- Upserts `daily_strategy_performance` unique on `(trading_date, quant_strategy_id)`.

## API

- `GET /api/v2/campaign/status`
- `PATCH|POST /api/v2/campaign/settings` — `campaignEnabled`, `dailyTargetAmount`, `dailyTargetType`, `targetAchievedAction`, optional `budget`

## UI

`GoalCampaignCard` on the Dashboard (`AutonomousDashboard`). Badges: `PURSUING GOAL` | `TARGET LOCKED` | `CAPITAL PRESERVED`.
