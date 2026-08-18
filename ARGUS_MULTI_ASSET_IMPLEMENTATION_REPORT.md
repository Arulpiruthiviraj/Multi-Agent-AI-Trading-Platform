# ARGUS multi-asset implementation report

Date: 2026-08-18. LIVE remains **NO-GO**. No strategy is declared profitable. Organic paper edge is not established.

## What changed

Additive overlay behind `ARGUS_MULTI_ASSET_ENABLED` and `ARGUS_PENNY_STOCK_ENABLED` (both default **false** / not `'true'`).

| Area | Files |
|---|---|
| Config | `config/multiAsset.json`, `config/eventNames.json`, `config/noTradeReasons.json`, `.env.example` |
| Loader | `src/server/config/multiAsset.ts` |
| Classifier / profiles / router / filter / scanner / costs | `src/server/multiAsset/*` |
| Idea choke | `src/server/core/EventBus.ts` (`TRADE_IDEA_GENERATED` after existing `gateTradeIdea`) |
| Optional strategy filter | `StrategyContext.assetClass` + `evaluateAll()` intersection |
| Subordinate sizing | `RiskEngine` `Math.min(global, profile.maxPositionNotional)` — never loosens |
| Quant context | `QuantSignalAgent` sets `assetClass` only when multi-asset flag is on |
| API | `GET /api/v2/multi-asset/status`, `/universe`, `/classify/:symbol` |
| UI | Strategy Scanner honesty panel |
| Tests | `src/server/multiAsset/multiAsset.test.ts` |

## What was intentionally NOT changed

- ChiefTrader quorum, HOLD veto, weights
- 24 RiskEngine gates / `riskGateOrder.json` catalog length
- OMS `type: 'MARKET'` payload and sole `placeOrder` path
- BrokerManager, LIVE_ARM, `PAPER_TRADING_ONLY`
- CORE strategy `evaluate()` math
- Organic-paper classification
- `strategiesEngine/` isolation
- Default Quant off (`QUANT_ENGINE_ENABLED` still false)

No LIMIT order path was added. That would be a separately audited OMS change.

## Architecture

### BEFORE (unchanged spine)

```
Strategy / agent idea
  → ChiefTrader
  → RiskAgent
  → RiskEngine (24 gates)
  → OMS
  → BrokerManager
  → Broker
```

### AFTER (same spine; overlay only extends discovery + eligibility)

```
Asset classification (config, UNKNOWN if incomplete)
  + Strategy eligibility (null allowlist = existing live set)
  + Asset-specific safety filter (penny/micro BUY only, flags on)
  + Opportunity scanner (HTTP, not an order)
        ↓
TRADE_IDEA_GENERATED   ← still gateTradeIdea + optional overlay BLOCK
  → ChiefTrader        ← unchanged
  → RiskAgent
  → RiskEngine (still 24 gates; optional tighter notional, never looser)
  → OMS (still MARKET)
  → BrokerManager
  → Broker
```

Scanner, classifier, and profiles **cannot** call `placeOrder`.

## New asset classes

`LARGE_CAP`, `MID_CAP`, `SMALL_CAP`, `MICRO_CAP`, `PENNY_STOCK`, `ETF`, `UNKNOWN`.

- ETF: allowlist (SPY, QQQ, IWM, DIA, VOO, VTI, GLD, TLT).
- Explicit overrides: AAPL, MSFT, NVDA, AMZN, TSLA → LARGE_CAP.
- Market cap buckets only when a snapshot actually provides market cap (live quotes do not).
- Price &lt; `pennyMaxPrice` (5, UNCALIBRATED) → PENNY_STOCK heuristic.
- Otherwise **UNKNOWN** (passthrough). Do not guess.

## Strategy profiles

JSON `profiles.*`. `permittedStrategyIds: null` = unrestricted (existing live Quant set). Penny/micro default **`[]`**: no live Quant strategy auto-enabled for those classes until a validated allowlist is written in config. Experimental VWAP/ORB/etc. modules already exist; they stay UNVALIDATED and still require their own env flags.

## Penny-stock support

When **both** flags are `'true'`:

- Penny/micro **BUY** ideas are BLOCKED if spread unknown, spread too wide, dollar volume unknown/low, volatility extreme, **or** OMS MARKET is unfit (default).
- **SELL / exits passthrough** (still 24 gates). Autobot-off SELL behavior is not replaced.
- Flags off: a $0.80 ticker behaves as today (existing Argus).

This is a risk filter, not a manipulation detector.

## Risk controls

- Global 24 gates remain first.
- Extra BLOCK is **upstream** of ChiefTrader so a blocked penny never becomes an executable idea.
- If something still reaches RiskEngine, notional is `min(global maxTradeSize, profile cap)`. AAPL/ETF profile caps are null → identity.

## Feature flags

| Env | Default | Effect |
|---|---|---|
| `ARGUS_MULTI_ASSET_ENABLED` | false | Classifier + API + attach `assetClass` on ideas |
| `ARGUS_PENNY_STOCK_ENABLED` | false | Requires multi-asset on. Penny/micro BUY filter + empty strategy allowlist + subordinate notional |

Do not set these to `'true'` “to see if it works.” They do not arm LIVE and do not enable Quant.

## Database

No migration. Overlay uses EventBus (`ASSET_CANDIDATE_BLOCKED` persisted) and computed GET responses.

## UI

Strategy Scanner: overlay panel. When flags off, states that existing RSI scan is unchanged. When on, shows class + SAFE/WATCH/BLOCK and that BLOCK is not an order.

## Tests / regression

- `npx tsc --noEmit` — pass
- `npx vitest run` — **1601 passed**, 252 files, **zero failures**
- `npm run build` — pass (Vite SPA + `dist/server.cjs`)
- Adversarial: multiAsset tree has no production `placeOrder` / OMS / BrokerManager / RiskEngine imports
- `evaluateAll()` remains 5 CORE strategies when `assetClass` is omitted or LARGE_CAP/ETF
- LIVE_NO_GO unchanged with flags on

`npm run build` was started as part of this pass; trust the command result in the session log.

## Remaining limitations (honest)

| Limitation | Consequence |
|---|---|
| Alpaca IEX stores bid, not ask | Live spread unknown → penny BUY BLOCK when penny flag on |
| No market cap / halt / shortability feed | Cap buckets unused unless caller supplies marketCap |
| OMS MARKET-only | Pennies are not executed via LIMIT; MARKET marked unfit |
| News heuristic is mega-cap | Catalyst+momentum is not a live penny edge |
| ChiefTrader still needs 2 agents @ 0.75 | Overlay does not lower quorum; pennies may never approve |
| Empty penny strategy allowlist | No live Quant penny strategy is enabled |
| Research costs overlay | Available via `loadCanonicalCostsForAsset`; default canonical engine callers unchanged. Zero-cost still cannot promote |
| Uncalibrated thresholds | Documented in JSON `calibration: UNCALIBRATED` |

## Paper-trading requirements

Keep `PAPER_TRADING_ONLY=true`. Do not set `tradingMode: LIVE`. If the overlay is enabled, blocked pennies will not inflate organic paper stats because they never become ideas. Surviving ideas (AAPL/ETF) still classify `execution_environment` through existing OMS rules.

## Performance claims

**None.** CORE and experimental strategies remain UNVALIDATED on penny/micro data. Walk-forward OOS for previously checked quant combos already failed. This overlay does not create an edge.
