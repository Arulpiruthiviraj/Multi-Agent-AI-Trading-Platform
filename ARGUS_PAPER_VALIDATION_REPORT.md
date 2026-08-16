# ARGUS_PAPER_VALIDATION_REPORT

Organic paper requires: `executionEnvironment=PAPER` + `FILLED` + `SELL` + numeric P&L.  
Excludes: BACKTEST, REPLAY, TEST traces, REJECTED, EXTERNAL_MANUAL, UNKNOWN.

**Closed organic sample: NOT ESTABLISHED.**

Need (config): `minPaperTrades` and `minPaperSessions` from `researchSafety.json` **plus** positive expectancy / drawdown gates — numbers alone are not automatic PASS.

Research vs paper reconciliation: **UNAVAILABLE** until both sides exist.

Do not count Vitest OMS stub fills as organic paper.
