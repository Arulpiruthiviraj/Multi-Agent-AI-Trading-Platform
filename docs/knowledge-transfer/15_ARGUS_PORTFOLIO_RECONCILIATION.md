# 15 — Portfolio reconciliation

File: `PortfolioReconciliation.ts`. Period ~5 min.

Compares local `portfolio` vs broker positions; open orders vs local non-terminal `trades`; cash check when supported.

On mismatch: persist `reconciliation_events` + snapshots; EventBus `RECONCILIATION_MISMATCH`. If worst $ impact ≥ 100 **and** `TRADING_ENABLED` → `setTradingState('TRADING_PAUSED')`. RiskEngine `emergency_stop` **fails** (verified by `PortfolioReconciliation.tradingBlock.test.ts`).

**Does not:** auto-repair quantities, flatten, or set a second kill switch. Open orders left (pause-only by design).

Manual: operator reviews, resumes trading state, investigates broker vs DB.

Section 30.12 (“only emergencyStopActive”) is **obsolete**.
