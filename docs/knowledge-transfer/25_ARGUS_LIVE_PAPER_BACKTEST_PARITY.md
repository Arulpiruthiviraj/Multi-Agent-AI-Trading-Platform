# 25 — Live vs paper vs backtest vs walk-forward vs historical AI replay

| Component | Live | Paper | Backtest | Walk-forward | AI year replay |
|---|---|---|---|---|---|
| TechnicalAgent | Yes | Yes | Different `run()` rules | n/a | UNAVAILABLE |
| News/Fund/Macro | Yes | Yes | No | No | UNAVAILABLE |
| ChiefTrader | Yes | Yes | No | No | UNAVAILABLE |
| QuantEngine | Flag | Flag | findStrategy | Strategy mode | No |
| RiskEngine 18 | Yes | Yes | 4 inequalities only | Same as BT | No |
| PositionSizing | Yes | Yes | Yes | Yes | n/a |
| Broker OMS recon | Yes | Paper broker | No | No | No |
| Fees/slippage | Broker | Sim/paper | SEC/FINRA+slip | Same | n/a |
| Exits | PortfolioMonitor | Same | Settings TP/trail + stop | Same | n/a |
| AI | Router | Router | No | No | UNAVAILABLE |

Paper InternalPaper ≠ Alpaca paper market hours.
