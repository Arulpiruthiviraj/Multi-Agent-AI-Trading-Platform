# IBKR Gateway Setup

Real, current connection mechanics — pulled from `src/server/config/ibkrConnection.ts`,
`scripts/devWithOpenAlice.ts`, and `CLAUDE.md`'s Brokers table. `CLAUDE.md` is still ground truth
if this drifts.

## Two connection modes (config, not a UI knob)

| Mode | Transport | Default port(s) | Login |
|---|---|---|---|
| `socket` (default) | IB Gateway Desktop / TWS raw TCP socket | Paper **4002** / live 4001 (Gateway), 7497 / 7496 (TWS) | None from Argus — 2FA happens in the Gateway app itself, ~24h session |
| `web_api` (opt-in, `IBKR_CONNECTION_MODE=web_api`) | Client Portal Web API (HTTPS) | `:5000` by default | Browser login, session managed by the Gateway process |

Argus **never** places a Canadian-exchange equity order via IBKR — automated TSX/TSXV routing is
blocked (IIROC 3200A.1(b)(i)), a policy decision plus `canadianEquities: false`, not a runtime
`isCanadianListing()` check.

## Socket mode (the default — recommended path)

1. Launch **IB Gateway Desktop** (not TWS, unless you specifically want TWS) in **Paper** mode.
2. In Gateway settings: enable **ActiveX and Socket Clients**, and **uncheck** Read-Only API (Argus
   needs to place orders in paper mode).
3. Leave `IBKR_CONNECTION_MODE` unset (defaults to `socket`).
4. Start Argus (`npm run dev` / `./argus start`). `scripts/devWithOpenAlice.ts`'s
   `probeIbkrDesktopGateway()` checks `127.0.0.1:4002`/`7497` and logs whether it found a live
   Gateway — it does **not** open a browser and does **not** spawn Client Portal in this mode.
5. Verify: `./argus.sh status` (checks the real TCP socket, not just that *some* process is
   listening) or `GET /api/v2/runtime/health`'s `ibkrPaths`/`activeBroker.connection` fields.

## Client Portal Web API mode (opt-in only)

Set `IBKR_CONNECTION_MODE=web_api` and `IBKR_GATEWAY_PATH` to your Client Portal Gateway checkout
(needs `bin/run.bat` + `root/conf.yaml`). `npm run dev` will start it and wait up to 45s for its
port to open; browser login is **not** opened automatically unless `IBKR_OPEN_BROWSER=true`. This
mode requires real human login + 2FA in that browser tab (`requiresManualReauth: true`,
~24h session).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Gateway not detected on 4002/7497 | Gateway not running, or ActiveX/Socket Clients disabled | Launch Gateway, enable the setting, restart Argus |
| `P0.2` classification mismatch / fail-closed | Account prefix (`U*` live / `DU*` paper) didn't match expected mode | Check `config/ibkrAccountClassification.json`; Argus trusts the Gateway's own session but fails closed on mismatch |
| Canadian symbol rejected | Automated TSX/TSXV routing is blocked by policy | Expected — not a bug, see IIROC note above |
| Client Portal 2FA "expired" | ~24h session window elapsed (web_api mode only) | Re-login in the browser tab |

## Related

- `CLAUDE.md` §1 "Brokers" table (all brokers, not just IBKR)
- `docs/operations/DEVOPS_LIFECYCLE.md` — how `npm run dev`/`argus.sh` sequence this probe
