# ARGUS_CANADIAN_MARKET_READINESS.md

**Date:** 2026-08-15.

```
Canadian software readiness:          ~15%  (listing registry + docs; no CA session/FX/bars path)
Canadian strategy readiness:           0%  (no CA OOS; US OOS already failed)
Canadian data readiness:               5%  (suffix map only; no TSX bar vendor proven here)
Canadian AI readiness:                 0%  (no CA news PIT corpus)
Canadian backtest readiness:           0%  (not run on TSX)
Canadian paper-trading readiness:      0%
Canadian real-money readiness:         0%  NO-GO
```

| Label | Status |
|-------|--------|
| IMPLEMENTED | Listing parse `SHOP.TO` → TSX/CAD (`MarketRegistry`) |
| TESTED | Unit tests for suffix/currency; **not** broker CA orders |
| BACKTESTED | No |
| OUT-OF-SAMPLE VALIDATED | No |
| PAPER VALIDATED | No |
| REAL-MONEY VALIDATED | No — IIROC blocks IBKR Canada retail API routing of TSX/TSXV |

US autonomous readiness remains the Phase 16 scorecard (**~71% software-ish / 15% trading-validation / NO-GO**). Canadian work did **not** raise that number.

Automated Canadian-listed execution is **not** a missing `placeOrder` call. See `ARGUS_CANADIAN_MARKET_GAP_ANALYSIS.md`.
