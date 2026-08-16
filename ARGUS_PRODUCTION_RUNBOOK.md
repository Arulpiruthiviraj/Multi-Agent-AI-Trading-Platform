# ARGUS_PRODUCTION_RUNBOOK

**LIVE is NO-GO.** This runbook is for paper/dev operation and incident awareness. It is not authorization to trade real money.

## Start (paper)

1. Copy `.env.example` → `.env`. Do not commit secrets.
2. Set `AUTH_PASSWORD` for any shared/networked process.
3. `npm run dev` or `npm run dev:server-only` (port **3000** hardcoded).
4. Confirm Autobot **OFF** until you intend paper ideas.
5. `GET /api/v2/live-readiness` must show `LIVE_NO_GO`.

## Do not

- Set `tradingMode: LIVE` without the confirmation phrase **and** without this matrix being LIVE_READY (it is not).
- Flip `canadianEquities` or paperMode to “unlock” Canada.
- Treat VectorBT/Research Lab green as fills.
- Use `QUANT_ENGINE_ENABLED=true` as validation.

## Stop

- Kill switch / `TRADING_PAUSED` / `EMERGENCY_STOP` via existing endpoints.
- Autobot OFF blocks new BUY; SELL/exits may still run while TRADING_ENABLED.

## After restart

Reconcile broker vs local **before** enabling Autobot. Do not resend orders blindly. OMS crash recovery polls existing rows.
