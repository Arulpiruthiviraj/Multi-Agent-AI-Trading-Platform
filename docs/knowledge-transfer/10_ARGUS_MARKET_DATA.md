# 10 — Market data and historical bars

## Providers

| Provider | API | Purpose | Realtime | History | Auth | Fallback |
|---|---|---|---|---|---|---|
| Alpaca IEX | WS + REST | Live ticks + bars | Top-of-book **not L2** | Daily/raw into `ohlcv_bars` | ALPACA_* | Worker idles if no keys |
| AlphaVantage | REST | Fund/macro/news | No | Limited | ALPHAVANTAGE_API_KEY | Agents DATA_UNAVAILABLE |
| Polygon | REST | News (and marketdata adapter) | Adapter **PARTIAL** vs worker | | POLYGON_API_KEY | |
| Finnhub | REST | News | | | FINNHUB_API_KEY | |
| FMP | REST | News | | | FMP_API_KEY | |
| FRED | REST | Macro series | | | FRED_API_KEY | |
| Questrade | OAuth | Read-only quotes/positions | | | OAuth | Not order broker |
| Yahoo | marketdata adapter | | | | | **UNKNOWN** if live path uses it |

Pre/after hours: Alpaca clock gate. Corporate actions: **not a first-class adjuster** — Alpaca bars used **raw** (look-ahead/adjust **UNKNOWN** vs split-adjusted). Canadian listings: metadata only.

## How a tick enters

Alpaca WS → `MarketDataWorker` → EventBus. Separate `liveQuotes` → InternalPaper `tick`. **TechnicalAgent uses EventBus only** — dual-feed divergence.

## HistoricalDataGateway

Caches `ohlcv_bars`. Missing bars: strategy returns honest fail conditions. Duplicates: gateway/DB constraints **UNKNOWN — NOT FULLY AUDITED this pass**. Timezone: NY session key used in backtest daily-loss reset (`nySessionKey`). `ReplayClock` **hard-fails future timestamps** (look-ahead **PASS** for replay clock).

Universe/delistings: **not** a survivorship-free engine — **FAIL / UNKNOWN** for academic backtests.
