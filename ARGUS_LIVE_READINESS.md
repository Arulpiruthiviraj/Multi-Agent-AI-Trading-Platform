# ARGUS live readiness (living)

Generated: 2026-08-16. Code + `evaluateLiveReadiness()` + this session's Alpaca ingest. Not a profitability certificate. **LIVE was not enabled. The phrase ENABLE LIVE TRADING was not typed.**

## Verdict

| Item | Status |
|---|---|
| Engineering | **73 / 100** |
| Trading edge | **8 / 100** |
| LIVE_READY | **LIVE_NO_GO** |
| Organic paper closed FILLED SELL | **0** trades / **0** NY sessions (need ≥30 / ≥10) |
| GREEN REAL_MARKET_DATA | **YES** — SPY 1Day, 519 bars, quality GREEN (Node bars.json). Parquet job blocked: pyarrow missing |
| Canonical OOS/WFO/robustness | **Ran on that dataset with non-zero costs. No CORE strategy passed WFO or robustness.** |
| Human LIVE | **Not done. Must remain a human typing ENABLE LIVE TRADING on a tiny account after paper+research gates actually pass.** |

## Honest CORE NEXT_BAR results (SPY 1Day, costs 0.005/share + 2 bps spread + 5 bps slippage)

| Strategy | backtestPass (full sample) | OOS trades | WFO | Robustness |
|---|---|---|---|---|
| MOMENTUM_BREAKOUT | false (INSUFFICIENT_TRADES) | 1 | FRAGILE (21 folds) | FAILED |
| PULLBACK_CONTINUATION | true | 42 | FRAGILE | FAILED |
| MEAN_REVERSION | false (INSUFFICIENT_TRADES) | 2 | FRAGILE | FAILED |
| TREND_FOLLOWING | false (INSUFFICIENT_TRADES) | 2 | FRAGILE | INSUFFICIENT_SAMPLE |
| RANGE_REVERSION | true | 148 | FRAGILE | FAILED (negative expectancy) |

WFO fold count is now structurally possible (fixed windows). FRAGILE means ≤1 fold with positive test expectancy. That is **not** a pass.

## Paper / LIVE

Today is **Sunday**. US cash session is closed. Organic paper cannot be completed in this session without fabricating fills. Autobot was **not** enabled. LIVE confirmation was **not** sent.

## Next

1. Supervised PAPER on a NY session via real OMS (Alpaca paper or Internal Paper + live ticks) until ≥30 organic closed SELL P&L over ≥10 sessions.
2. Do not promote CORE until WFO is not FRAGILE and robustness is ROBUST on GREEN data.
3. Only then a **human** types `ENABLE LIVE TRADING` on a tiny account.
