# ARGUS controlled paper soak audit — 2026-10-12

Supervised PAPER only. Not LIVE. Not an edge claim.

## First-fill forensic checkpoint

- Result: **PASSED**
- At: 2026-10-12T16:11:25.624Z
- Order: `3636ebd9-5dca-4961-81b0-d2fd2614e360` BUY DDOG
- Trace: `trace_DDOG_1791821481_8c80`
- Failures: (none)
- JSON: `C:\WorkProjects\Multi-Agent-AI-Trading-Platform\data\logs\first_fill_forensic_2026-10-12.json`

| Check | OK | Detail |
|---|---|---|
| order_persisted | PASS | trades row 3636ebd9-5dca-4961-81b0-d2fd2614e360 status=FILLED symbol=DDOG qty=10 price=289.01 |
| fill_ledger | PASS | fills=1 qtySum=10 |
| portfolio_broker_match | PASS | localQty=10 brokerQty=10 tol=0.001 |
| recon_clean | PASS | latest id=7027 matches=true mismatches=0 missingRemotely=false |
| sell_pnl_non_null | PASS | N/A for BUY (P&L required on closing SELL only) |
| trace_completeness | PASS | traceId=trace_DDOG_1791821481_8c80 risk_assessments=1 trades=1 |

## First-fill forensic checkpoint

- Result: **PASSED**
- At: 2026-10-12T19:01:14.481Z
- Order: `c42aede2-33ca-49cc-a7c7-456199bde199` BUY S
- Trace: `trace_S_1791831673_894c`
- Failures: (none)
- JSON: `C:\WorkProjects\Multi-Agent-AI-Trading-Platform\data\logs\first_fill_forensic_2026-10-12.json`

| Check | OK | Detail |
|---|---|---|
| order_persisted | PASS | trades row c42aede2-33ca-49cc-a7c7-456199bde199 status=FILLED symbol=S qty=38 price=25.82 |
| fill_ledger | PASS | fills=1 qtySum=38 |
| portfolio_broker_match | PASS | localQty=38 brokerQty=38 tol=0.001 |
| recon_clean | PASS | latest id=7062 matches=true mismatches=0 missingRemotely=false |
| sell_pnl_non_null | PASS | N/A for BUY (P&L required on closing SELL only) |
| trace_completeness | PASS | traceId=trace_S_1791831673_894c risk_assessments=1 trades=1 |
