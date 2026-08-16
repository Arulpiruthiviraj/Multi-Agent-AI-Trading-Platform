# 24 — Canadian market support

`config/markets.json` documents TSX/TSXV, `.TO`, hours, CAD **metadata**. Automated routing **BLOCKED_IIROC_3200A_1_B_I**.

| Topic | Status |
|---|---|
| Tickers / exchange metadata | IMPLEMENTED documentation |
| Live CA routing IBKR/Questrade | **MISSING / BLOCKED** |
| IBKR isCanadianListing in placeOrder | **NOT called** (gotcha) |
| Questrade orders | throw |
| CAD FX conversion | NOT_SUPPORTED in Quant |
| CA news/fundamentals/holidays/tax | **MISSING** as first-class |
| Fractional | No |

Metadata ≠ permission to trade.
