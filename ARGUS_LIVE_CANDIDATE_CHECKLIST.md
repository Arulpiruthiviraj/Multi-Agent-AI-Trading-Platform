# ARGUS live-candidate checklist

Status is **computed from evidence**. There is no API to set `status = VALIDATED`.

A strategy is **LIVE_CANDIDATE** only if all of the following are true:

## Data
- [ ] Provenance = `REAL_MARKET_DATA` (UNIT_FIXTURE / synthetic cannot pass)
- [ ] DATA_QUALITY_PASS (GREEN)

## Backtest / OOS
- [ ] BACKTEST_PASS
- [ ] OOS_PASS (untouched test)
- [ ] WALK_FORWARD_PASS (optimize train, select validation, freeze, evaluate test only)

## Robustness
- [ ] MONTE_CARLO_PASS (scenario analysis, not a profit claim)
- [ ] PERMUTATION_PASS
- [ ] SENSITIVITY_PASS (not FRAGILE_PARAMETERIZATION)
- [ ] COST_STRESS_PASS (not COST_FRAGILE)

## Paper
- [ ] MIN_PAPER_TRADES (`researchSafety.minPaperTrades`, ≥ `tradingSafety.minTradesForPaperValidation`)
- [ ] MIN_PAPER_SESSIONS
- [ ] PAPER_EXPECTANCY_POSITIVE
- [ ] PAPER_DRAWDOWN_WITHIN_LIMIT
- [ ] Organic FILLED SELL P&L only (`executionEnvironment=PAPER`)

## Risk / ops
- [ ] RISK_GATE_PASS
- [ ] BROKER_HEALTH_PASS
- [ ] MARKET_DATA_HEALTH_PASS
- [ ] STARTUP_HEALTH_PASS

## Market
- [ ] Canadian security ⇒ CANADIAN_EXECUTION_APPROVED (currently **blocked**)

## Approval
- [ ] MANUAL_APPROVAL still required for LIVE_APPROVED
- [ ] LIVE ≠ automatic

**Current CORE five and SMC:** all gates failed / UNTESTED / UNVALIDATED. **LIVE: NO-GO.**
