# 22 — Testing

- Runner: `npm test` → vitest. `npm run test:e2e` → Playwright (1 spec).
- File count: glob `*.test.ts`/`*.spec.ts` **257 hits** (Windows path duplicates possible). Prior inventory **~128** unique vitest files. Treat as **≥128 unit/integration files**.
- E2E: isolated DB, seeds wizard + tour. Does **not** cover OMS crash ingest.

## Classes present

Unit: RiskEngine, PositionSizing, OMS lifecycle/crash, Alpaca reliability, AIRouter timeout, BacktestRiskParity, strategies, news providers, brokers.  
Integration: marketDataToRisk, recon tradingBlock.  
E2E: module toggle parity.  
Backtest parity: partial (capital inequalities + exits).  
Chaos: chaosRoutes tests if present.  
Frontend: almost **no** App.tsx unit tests.  
AI: providers + parseResearchNote + output validator — not live accuracy.

## Untested / thin

App.tsx tabs, IBKR live 2FA session, Coinbase funded, OpenAlice real MCP, full 18-gate backtest, `/signals` still existing, production AUTH, look-ahead vs split-adjusted bars.
