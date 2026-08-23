# ARGUS — Dual IBKR Adapter Architecture (2026-08-21)

**Mode:** Implementation + verification (unit tests). Live `:4002` handshake script is optional operator verify.

## Verdict

| Item | Status |
|---|---|
| Dual adapters | **DONE** — `ibkr_gateway` (TCP `@stoqey/ib`) + `ibkr_web` (Client Portal REST) |
| Alias `ibkr` | **DONE** — auto-selects gateway if :4002/:7497 open, else web |
| Browser on startup | **REMOVED** by default — only `IBKR_OPEN_BROWSER=true` + `web_api` |
| OMS / RiskEngine spine | **UNCHANGED** — sole `placeOrder` via OMS |
| `PAPER_TRADING_ONLY` | **ENFORCED** on switch |
| MDW rebind | **DONE** — cap → `maxMarketDataLines` + `reqMktData` bridge when `ibkr_gateway` |

## Broker IDs

| id | Class | Transport |
|---|---|---|
| `ibkr_gateway` | `IBGatewaySocketAdapter` | TCP 4002 / 7497 (paper); 4001 / 7496 live if allowed |
| `ibkr_web` | `InteractiveBrokersWebApiAdapter` | HTTPS `:5000` Client Portal |
| `ibkr` | alias | `resolveIbkrAlias()` |

## Switch

```http
POST /api/v1/brokers/active
{ "id": "ibkr_gateway" }
```

Also: `ibkr_web`, `alpaca`, `ibkr` (auto).

## Health

`GET /api/v2/runtime/health` includes:

- `activeBroker` (+ `connection` snapshot when available)
- `ibkrPaths.gatewaySocket` / `ibkrPaths.webApi` (`CONNECTED` / `OFFLINE` / `401_AUTH_REQUIRED`)

## Tests

`npx vitest run src/brokers/` (+ MDW / v2Runtime): **112 passed** in last verification run.

## Operator note

Keep IB Gateway Desktop Paper open with **Enable ActiveX and Socket Clients** and **Read-Only API unchecked**. Do not expect browser login for `ibkr_gateway`.
