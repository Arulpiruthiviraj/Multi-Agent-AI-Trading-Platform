# ARGUS controlled paper soak audit — 2026-10-07

Supervised PAPER only. Not LIVE. Not an edge claim.

## First-fill forensic checkpoint

- Result: **FAILED**
- At: 2026-10-07T14:55:46.455Z
- Order: `828aaf09-d2d1-438d-9a3c-3c7101945c6d` BUY OKTA
- Trace: `pipeline-buy-cb97962f-628b-41ab-b53a-b93dd01c7d64`
- Failures: recon_clean: latest id=6510 matches=false mismatches=1 missingRemotely=false
- JSON: `C:\WorkProjects\Multi-Agent-AI-Trading-Platform\data\logs\first_fill_forensic_2026-10-07.json`

| Check | OK | Detail |
|---|---|---|
| order_persisted | PASS | trades row 828aaf09-d2d1-438d-9a3c-3c7101945c6d status=FILLED symbol=OKTA qty=13 price=216.94 |
| fill_ledger | PASS | fills=1 qtySum=13 |
| portfolio_broker_match | PASS | localQty=-1 brokerQty=-1 tol=0.001 |
| recon_clean | FAIL | latest id=6510 matches=false mismatches=1 missingRemotely=false |
| sell_pnl_non_null | PASS | N/A for BUY (P&L required on closing SELL only) |
| trace_completeness | PASS | traceId=pipeline-buy-cb97962f-628b-41ab-b53a-b93dd01c7d64 risk_assessments=1 trades=1 |

## First-fill forensic checkpoint

- Result: **PASSED**
- At: 2026-10-07T15:32:40.436Z
- Order: `283f6e76-2d06-45a3-87c4-270ab9402993` BUY OKTA
- Trace: `pipeline-buy-151323c4-2ed8-41db-890b-e834df903c20`
- Failures: (none)
- JSON: `C:\WorkProjects\Multi-Agent-AI-Trading-Platform\data\logs\first_fill_forensic_2026-10-07.json`

| Check | OK | Detail |
|---|---|---|
| order_persisted | PASS | trades row 283f6e76-2d06-45a3-87c4-270ab9402993 status=FILLED symbol=OKTA qty=1 price=218.17 |
| fill_ledger | PASS | fills=1 qtySum=1 |
| portfolio_broker_match | PASS | localQty=0 brokerQty=0 tol=0.001 |
| recon_clean | PASS | latest id=6519 matches=true mismatches=0 missingRemotely=false |
| sell_pnl_non_null | PASS | N/A for BUY (P&L required on closing SELL only) |
| trace_completeness | PASS | traceId=pipeline-buy-151323c4-2ed8-41db-890b-e834df903c20 risk_assessments=1 trades=1 |
