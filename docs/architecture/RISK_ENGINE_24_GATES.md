# RiskEngine — 24-Gate Reference

**`CLAUDE.md` §2 is the authoritative version of this table** (dates, exact defaults, and the
"Older 18-gate lists" caveat live there). This file exists purely so the gate list has a
navigable home under `docs/architecture/` alongside the other architecture docs — it does not
supersede or duplicate-and-drift from `CLAUDE.md`.

## Ground rules

- Catalog order comes from `config/riskGateOrder.json`. Pass/fail must come from the real
  `RISK_GATE_EVALUATED` event / `risk_gate_results` table — **never** inferred from the JSON file
  alone.
- Every gate is recorded even after the first failure. The **first failure in evaluation order**
  is the reported rejection reason.
- No AI provider, debate outcome, or learned rule can override this ladder.
- All numeric thresholds live in `config/tradingSafety.json` (or `settings` for a few
  operator-tunable ones) — never hardcoded in TypeScript. Do not copy today's numbers into code;
  load config.

## The 24 gates (names only — see `CLAUDE.md` §2 for the fail-closed rule of each)

1. `emergency_stop`
2. `autobot_enabled`
3. `same_symbol_cooldown`
4. `post_loss_cooldown`
5. `daily_trade_limit`
6. `duplicate_signal`
7. `invalid_account_equity`
8. `daily_loss`
9. `consecutive_loss`
10. `portfolio_drawdown`
11. `order_rate_limit`
12. `market_hours`
13. `data_freshness`
14. `news_veto`
15. `price_validity`
16. `order_notional_cap`
17. `symbol_concentration`
18. `open_positions_cap`
19. `sector_concentration`
20. `correlation_exposure`
21. `sufficient_size`
22. `sell_position_exists` (SELL only)
23. `argus_capital_allocation`
24. `daily_buy_notional`

## Verifying gates are actually current (do this, don't trust this file's staleness)

```bash
# Real current thresholds:
cat config/tradingSafety.json
cat config/riskGateOrder.json
# Real current pass/fail behavior for a given trace:
curl -s http://127.0.0.1:3000/api/v2/traces/<traceId> | jq '.riskAssessment'
```

## Related, real code

| Concern | Where |
|---|---|
| Gate implementations | `src/server/engines/RiskEngine.ts` |
| Evaluation-queue serialization (DEF-09) | Same file — Promise-chain mutex |
| Position sizing math (shared with backtests) | `src/server/engines/PositionSizing.ts` |
| Capital allocation (gate 23) | `src/server/engines/CapitalAllocation.ts` |
| Daily buy notional (gate 24) | `src/server/engines/DailyBuyNotional.ts` |
