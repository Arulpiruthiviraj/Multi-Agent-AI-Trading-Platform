# Daily Goal Campaign — Operations Summary

Full contract: **[`ARGUS_CAMPAIGN_TRACKER.md`](../../ARGUS_CAMPAIGN_TRACKER.md)** (repo root —
the real, detailed spec). This file is a short operations-focused pointer, not a duplicate.

## What it is, in one paragraph

An optional, additive, `settings.campaign_enabled`-gated (default **off**) tracker that watches
daily realized+unrealized P&L against a target (`settings.daily_target_amount`,
`DOLLAR` or `PERCENT`) and, when reached, applies one of three operator-chosen policies:
`CONTINUE` (track only), `LOCK_AND_IDLE` (soft-block new BUY ideas for the rest of the NY trading
day), or `TRAIL_STOPS_ONLY` (same soft-lock, plus `PortfolioMonitor` tightens the trailing stop on
still-open positions toward `tradingSafety.campaignTrailStopsOnlyPct`).

## What it is explicitly not

- **Not** a trade-forcing mechanism. It never lowers ChiefTrader's consensus threshold or minimum
  independent-agent count, never invents a parallel position-sizing path (budget still flows
  `settings.budget` → `CapitalAllocation` → gate 23 `argus_capital_allocation`), and never calls
  `placeOrder`/`OrderManagementService` directly.
- **Not** a second kill switch. The BUY soft-lock only blocks *new entry* ideas — SELL/exit ideas
  are unaffected and still require `TRADING_ENABLED`.
- **Not** proof of trading edge. Daily target progress is telemetry — organic paper-soak
  floors (`config/researchSafety.json`) are a completely separate, unrelated bar.

## Operator commands

```bash
./argus campaign                              # formatted status (progress, P&L, lock state, policy)
curl -s :3000/api/v2/campaign/status          # same, raw JSON
curl -X PATCH :3000/api/v2/campaign/settings \
  -d '{"campaignEnabled": true, "dailyTargetAmount": 100, "dailyTargetType": "DOLLAR", "targetAchievedAction": "LOCK_AND_IDLE"}'
```

## Capital-deployment observability (added 2026-08, non-sizing)

`GET /api/v2/campaign/status` also reports `deployedCapital` / `idleCapital` /
`capitalUtilizationPct` — computed by reusing the **same** `CapitalAllocation.snapshotCapital()`
math gate 23 itself uses, purely for display. This does **not** feed back into sizing, consensus,
or entry decisions — it exists so an operator can see utilization without it becoming a second
sizing input.

## Related

- `ARGUS_CAMPAIGN_TRACKER.md` — full contract, settings fields, badges, effort telemetry
- `src/components/dashboard/GoalCampaignCard.tsx` — the dashboard UI
- `docs/architecture/ARGUS_ARCHITECTURE.md (Risk Engine Gates section)` — gate 23 (`argus_capital_allocation`)
