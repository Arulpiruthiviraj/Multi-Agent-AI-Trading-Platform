# Argus mobile Settings (operator how-to)

Frontend-only touch panel. **Does not arm LIVE.** Does not write `.env`. Does not bypass RiskEngine / OMS / BrokerManager. Adding this UI does not raise LIVE scores.

**Chrome DevTools 320/390/412 viewport testing was not completed** (login form sits in front of the panel). Do not claim phone-layout QA is done.

---

## How to open it

1. Sign in (`AUTH_PASSWORD` session if set). Login is **before** the mobile shell (`App.tsx`).
2. Mobile Mission Control is the layout when viewport width is **< 768px** (`MOBILE_BREAKPOINT_PX`) **or** when you tap **Mobile** on the desktop header.
3. Bottom nav, 6th tab: **Settings** (`MOBILE_TABS`: `cockpit | positions | brain | risk | terminal | settings`).
4. Desktop Settings → **Dual configuration** (`EnvRuntimeSettingsPanel`) is the same overlay API, not a second config system.

Code: `src/components/mobile/MobileSettingsView.tsx`, `mobileSettingsModel.ts`, `mobileTabs.ts`. Rendered from `MobileMissionControl.tsx`.

---

## APIs (real)

There is **no** `POST /api/v2/settings` body dump and **no** `/api/v2/settings/reset-env`.

| Use | Method / path |
|---|---|
| Effective catalog (redacts secrets) | `GET /api/v2/settings/effective` |
| Set one overlay | `POST /api/v2/settings/overrides` `{ key, value }` |
| Reset one overlay | `POST /api/v2/settings/overrides/:key/reset` |
| Reset all overlays | `POST /api/v2/settings/overrides/reset-all` `{ confirm }` — phrase from catalog (`RESET_ALL_TO_ENV`) |
| Operator knobs | `GET`/`POST /api/v1/settings` (same `configRouter` as `/api/v1/config/settings`) |
| Secret status / write | `GET /api/v1/config/provider-status`, `POST /api/v1/config/providers`, `GET`/`POST /api/v1/config/brokers` |

Raw secrets are never displayed. Status is **Configured ✓** / **Missing ✗**. Previous values are not shown on Update key.

Precedence for catalog flags: DB `config_overrides` **&gt;** `.env` **&gt;** catalog default. Boolean true is still exactly `'true'`.

---

## Writable vs read-only

**Writable overlays** (ON/OFF → `config_overrides`):

- `ARGUS_OPPORTUNITY_LOOP_ENABLED`
- `ARGUS_PORTFOLIO_INTEL_ENABLED`
- `ARGUS_MULTI_ASSET_ENABLED`
- `ARGUS_PENNY_STOCK_ENABLED`
- `QUANT_ENGINE_ENABLED` (applyMode `RESTART_REQUIRED`)

**Writable `settings` row** (not overlays):

- Take-profit stepper → `settings.takeProfitPct` (5 / 10 / 15 / 20 / 25, bounded by `tradingSafety.json`)
- Cost-basis stop stepper → `settings.trailingStopPct` vs **average cost**. Not a peak trail. **There is no ATR trailing multiplier in the live engine.**
- Broker picker → `settings.selectedBroker`: Argus Internal Simulator, Alpaca, Interactive Brokers. Applies on BrokerManager initialize / **restart**. Does not arm LIVE. Coinbase / Questrade are not on this picker.
- LLM picker → `settings.selectedAiProvider` is a **UI preselect only**. `AIRouter` still uses per-agent routes. Extra Claude `.env` keys do not imply a dedicated provider class.

**Read-only / locked:**

| Knob | Source | Note |
|---|---|---|
| `PAPER_TRADING_ONLY` | env safety lock | Padlock. Settings POST overlay is 403. LIVE remains **NO-GO**. |
| Scan interval | `config/continuousIntelligence.json` `opportunityScanMs` | **120000 ms = 120s**. Not a 15/30/60s stepper. |
| Max watchlist | `maxActiveSubscriptions` | **30**. Alpaca IEX bounded feed; worker prunes least-active non-protected symbols at the cap. |
| Penny spread | `config/multiAsset.json` `safety.pennyMaxSpreadBps` | **150**, **UNCALIBRATED**. |
| Consensus quorum | `config/tradingSafety.json` | **0.75** / **2** independent agents. |

---

## Provenance / reset

Badges: Effective ON/OFF; source **DB Override** (`SETTINGS`) vs **.env Default** (`ENV`) vs **Safe default**; `.env` fallback text; **Restart required** when `restartRequired` and overlay is SETTINGS.

Per-key **RotateCcw** reset is shown **only** when `source === SETTINGS`. **Reset all to .env** deletes `config_overrides` only (not trades, fills, portfolio, risk, or broker credentials). Type the confirm phrase from `GET /api/v2/settings/effective`.

Toggling a flag does not by itself enable Autobot or LIVE.
