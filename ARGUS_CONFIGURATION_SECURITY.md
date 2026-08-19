# ARGUS Configuration Security

## Secrets

- Overlay table stores **only** catalogued non-secret flags.
- `POST /api/v2/settings/overrides` returns **403** for `secret` or `safetyLocked` keys.
- `GET /api/v2/settings/effective` returns `configured: true|false` for secrets, never the value.
- Phone Settings (`MobileSettingsView`) and desktop Dual configuration use those same routes. There is no `POST /api/v2/settings` dump and no `/api/v2/settings/reset-env`.
- Export download redacts the same way. The server **does not** write `.env`.
- Broker credentials remain in the encrypted `brokerConnections` store / `.env`. Do not copy them into `config_overrides`.

## Safety locks

| Control | Settings overlay |
|---|---|
| PAPER_TRADING_ONLY | Cannot override. `isPaperTradingOnlyEnforced()` still reads env. |
| LIVE_ARM / ENABLE LIVE TRADING phrase | Not a catalog key. Unchanged. |
| authorizeProductionOrder / LIVE_NO_GO | Unchanged. |
| RiskEngine 24 gates | Unchanged. Not Settings-overridable here. |
| OMS sole placeOrder | Unchanged. Dual-config routes do not import OMS/BrokerManager. |
| ARGUS_DB_PATH / AUTH_* / ENCRYPTION_SECRET | Catalogued as locked. |

If Settings `tradingMode` is LIVE while `PAPER_TRADING_ONLY=true`, execution stays paper-locked — same as before this feature.

## Audit

`config_change_events` records setting key, old effective string, new overlay string (or null on reset), source (`SETTINGS` \| `RESET_ENV` \| `RESET_ALL`), operator label, restartRequired, timestamp. Secret keys are never written there because they cannot be set.

## Auth

These endpoints live under `/api/v2` and use the same session gate as other `/api/*` routes when `AUTH_PASSWORD` is set.

## Convenience vs safety

If an overlay would weaken a safety lock, the write is refused. The lock wins.
