# ARGUS Configuration Architecture

**Date:** 2026-08-18 (living; re-verify catalog against `config/runtimeEnvCatalog.json` when adding flags)  
**Rule:** `.env` is always supported. Settings is an **override** layer. Database settings do **not** replace `.env`. Safety wins. **LIVE_NO_GO** is unchanged by overlays.

## Roles

| Layer | Role |
|---|---|
| `.env` | Bootstrap / deployment / recovery / fresh install. Always read. Never silently rewritten by the UI. |
| `config_overrides` SQLite table | Explicit operator overlays for catalogued, non-secret, non-safety-locked keys |
| `config/runtimeEnvCatalog.json` | Classification matrix (type, default, overridable, secret, applyMode) |
| Existing `settings` row | Unrelated operator knobs already in DB (take-profit %, Autobot, budget, pipeline agent map, **campaign** fields, …). Unchanged layering: campaign targets are settings, not `tradingSafety` literals. |
| Encrypted `brokerConnections` | Broker secrets entered in the Setup Wizard. Unchanged. |
| `config/*.json` | Reviewed numbers (e.g. `tradingSafety.json`, `continuousIntelligence.json` `maxActiveSubscriptions=12`, Alpaca default; 90 under `ibkr_gateway`). Missing required keys fail boot. |
| `config/runtimeEnvCatalog.json` | Includes flags such as `QUANT_ENGINE_ENABLED`, `ARGUS_OPPORTUNITY_LOOP_ENABLED`, `ARGUS_OPPORTUNITY_IDEAS_ENABLED` — check catalog for exact defaults / `applyMode`. |
| `config/tradingSafety.json` | Hard safety numbers (consensus, cooldowns, `kronosEvaluationHorizonMs`, campaign velocity / trail / ATR multiples). Env *names* for some flags live here as `*EnabledEnvVar` strings (e.g. `QUANT_COLD_START_BOOTSTRAP_ENABLED`) even when not duplicated in the runtime catalog. |

## Precedence (overridable flags)

```
explicit config_overrides row
        ↓
process.env (including empty-but-set)
        ↓
catalog safe default
```

Boolean true remains **exactly** the string `'true'` (same as before).

## First boot

1. Process reads `.env`.
2. `hydrateRuntimeConfigFromDb()` loads overlay rows (none on a fresh DB).
3. Settings UI (`GET /api/v2/settings/effective`) shows `.env` values with `source: ENV` (or `DEFAULT` if unset). Desktop: Settings → Dual configuration (`EnvRuntimeSettingsPanel`). Phone: 6th mobile tab Settings (`MobileSettingsView`) — same overlay APIs; see `docs/ARGUS_MOBILE_SETTINGS.md`.
4. **No overlay row is written** until the operator clicks Set ON/OFF/Save. That is what keeps restart from treating bootstrap as an override.

## Restart

Overlays persist. `.env` is not overwritten. If `.env` later changes, a stored overlay still wins until **Reset to .env**.

## Reset

- One key: `POST /api/v2/settings/overrides/:key/reset` deletes that row.
- All: `POST /api/v2/settings/overrides/reset-all` with body `{ "confirm": "RESET_ALL_TO_ENV" }`.
- Deletes **only** `config_overrides` (plus a non-secret audit row). Not trades, fills, portfolio, risk, broker credentials.

## Export

`GET /api/v2/settings/effective/export` returns redacted JSON. It does **not** write the `.env` file. Optional operator download only.

## Hot reload

| applyMode | Meaning |
|---|---|
| HOT_RELOAD | Flag readers call `isRuntimeFlagEnabled` at evaluation time (penny, experimental Quant modules, opportunity loop, bull/bear). |
| RESTART_REQUIRED | Quant engine start/interval captured when `QuantSignalAgent.start()` runs (Autobot / process). UI says restart required. |
| RECONNECT_REQUIRED / BOOT_ONLY | Displayed; not overridable (or launcher-only). |
| SAFETY_CRITICAL | `PAPER_TRADING_ONLY` and similar. Settings POST returns 403. |

Do not assume a setting is hot unless `applyMode` is `HOT_RELOAD`.

## Safety (unchanged)

- `PAPER_TRADING_ONLY` stays `process.env` via `isPaperTradingOnlyEnforced()`.
- LIVE_ARM / confirmation phrase / `authorizeProductionOrder` / 24 RiskEngine gates / OMS-only `placeOrder` are not Settings keys.
- Choosing LIVE in the existing Settings `tradingMode` field still cannot execute LIVE while the env lock and arming sequence refuse it.

## Runtime API

Trading flag readers should use `isRuntimeFlagEnabled(key)` / `resolveRuntimeNumber` from `src/server/config/effectiveRuntimeConfig.ts`.

Secrets and boot paths (`ARGUS_DB_PATH`, `AUTH_*`, Alpaca keys, `ENCRYPTION_SECRET`) remain `process.env` (and the encrypted broker store). They are classified in the catalog as non-overridable secrets.
