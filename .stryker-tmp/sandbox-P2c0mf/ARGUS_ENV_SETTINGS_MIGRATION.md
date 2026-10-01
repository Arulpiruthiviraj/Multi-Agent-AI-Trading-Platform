# ARGUS .env ↔ Settings migration notes

This is an **additive** overlay. No cutover that disables `.env` was performed.

## What operators should do

1. Keep using `.env` for secrets, `PAPER_TRADING_ONLY`, bind/auth, and first-boot flags.
2. Open Settings → **Dual configuration** (desktop) or the phone **Settings** tab (viewport <768 or Mobile toggle). Values are prepopulated from `.env` (`source: ENV`). Same overlay APIs; see `docs/ARGUS_MOBILE_SETTINGS.md`.
3. Change a flag (example: Quant Engine ON). That writes `config_overrides` only.
4. Restart if the row says **Restart required** (`QUANT_ENGINE_ENABLED`, interval).
5. `.env` on disk is unchanged. To make env match again, either edit `.env` yourself or click **Reset to .env** / per-key RotateCcw (overlay removed; effective follows current env).

## What was not migrated

- Broker API keys — still env and/or encrypted `brokerConnections`.
- `PAPER_TRADING_ONLY` — cannot be flipped in this UI.
- Consensus 0.75 / min 2 agents — still `config/tradingSafety.json` only.
- RiskEngine gate numbers — still `tradingSafety.json` / existing `settings` row.
- Take-profit / trailing % — still the existing `settings` columns (PortfolioMonitor). Mobile steppers write `takeProfitPct` / `trailingStopPct`. Trailing is **cost-basis vs average**, not ATR or a peak trail.

## Fresh install

Copy `.env.example` → `.env`, start the app, overlays table is empty, UI shows env.

## Existing install (this change)

On first boot after upgrade, migration `0040_config_overrides` creates empty overlay tables. Effective flags equal current `.env` (same as yesterday). Nothing is auto-enabled.

## Recovery

If SQLite is lost but `.env` remains, behavior returns to env/defaults. If `.env` is lost but overlays remain, overridable flags still apply after hydrate; secrets/safety locks will be missing/locked as before.
