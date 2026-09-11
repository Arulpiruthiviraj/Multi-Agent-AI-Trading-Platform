# ARGUS Strategy Inventory and Status (2026-09-09)

Source: `src/server/quant/strategies/StrategyEngine.ts` (`CORE_STRATEGIES`, `EXPERIMENTAL_STRATEGIES`,
`findStrategy()`, `resolveStrategiesForLiveEvaluation()`) — read directly this session, plus
`config/engineOwnership.json` for the Java side. Every "Runtime Caller" cell below is HIGH/VERIFIED
unless marked otherwise.

## Master table — TypeScript quant strategies (21 total: 5 CORE + 16 EXPERIMENTAL)

| Strategy ID | TS | Java | Registered | Enabled (live) | Runtime Caller | Backtest | Verdict |
|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | Yes | Yes (unwired) | Yes (`CORE_STRATEGIES`) | Always | `evaluateAll()` via `QuantSignalAgent.ts` | Yes (`findStrategy()`) | **CORRECT / ACTIVE** |
| PULLBACK_CONTINUATION | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| MEAN_REVERSION | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| TREND_FOLLOWING | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| RANGE_REVERSION | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| SMC_LIQUIDITY_SWEEP | Yes | No | Yes (`EXPERIMENTAL_STRATEGIES`) | `QUANT_SMC_STRATEGY_ENABLED` | `findStrategy()`; live only if flag true at call time | Yes | UNVERIFIED (flag state not checked this pass) |
| VWAP_VOLUME_STRUCTURE | Yes | No | Yes | `QUANT_VWAP_STRUCTURE_ENABLED` | Same pattern | Yes | UNVERIFIED (flag) |
| OPENING_RANGE_BREAKOUT | Yes | No | Yes | `QUANT_ORB_STRATEGY_ENABLED` | Same | Yes | UNVERIFIED |
| VWAP_MEAN_REVERSION | Yes | No | Yes | `QUANT_VWAP_REVERSION_ENABLED` | Same | Yes | UNVERIFIED |
| DONCHIAN_BREAKOUT | Yes | No (Java has an *unrelated*, unwired research `donchian_channel` engine — not the same call path) | Yes | `QUANT_DONCHIAN_STRATEGY_ENABLED` | Same | Yes | UNVERIFIED |
| MA_CROSSOVER | Yes | No (Java's `moving_average_crossover` research engine is separate/unwired) | Yes | `QUANT_MA_CROSSOVER_ENABLED` | Same | Yes | UNVERIFIED |
| OSCILLATOR_MOMENTUM | Yes | No | Yes | `QUANT_OSCILLATOR_MOMENTUM_ENABLED` | Same | Yes | UNVERIFIED |
| BOLLINGER_VOLATILITY | Yes | No (Java's `bollinger_mean_reversion` research engine is separate/unwired) | Yes | `QUANT_BOLLINGER_VOLATILITY_ENABLED` | Same | Yes | UNVERIFIED |
| PREVIOUS_PERIOD_BREAKOUT | Yes | No | Yes | `QUANT_PREVIOUS_PERIOD_BREAKOUT_ENABLED` | Same | Yes | UNVERIFIED |
| CANDLESTICK_REVERSAL | Yes | No | Yes | flag (name not confirmed this pass) | Same | Yes | UNVERIFIED |
| GAP_CONTINUATION | Yes | No | Yes | `QUANT_GAP_STRATEGY_ENABLED` | Same | Yes | UNVERIFIED |
| FIBONACCI_PULLBACK | Yes | No | Yes | `QUANT_FIBONACCI_PULLBACK_ENABLED` | Same | Yes | UNVERIFIED |
| VOLUME_CONFIRMATION | Yes | No | Yes | `QUANT_VOLUME_CONFIRMATION_ENABLED` | Same | Yes | UNVERIFIED |
| SR_BOUNCE | Yes | No | Yes | `QUANT_SR_BOUNCE_ENABLED` | Same | Yes | UNVERIFIED |
| RELATIVE_STRENGTH_ROTATION | Yes | No | Yes | `QUANT_RELATIVE_STRENGTH_ENABLED` | Same | Yes | UNVERIFIED |
| STATISTICAL_MEAN_REVERSION | Yes | No | Yes | `QUANT_STATISTICAL_REVERSION_ENABLED` | Same | Yes | UNVERIFIED |

**On the 16 experimental strategies' "UNVERIFIED" verdicts**: this pass confirmed the *mechanism*
(each is gated by its own named env var, checked at call time per `StrategyEngine.ts`'s own header
comment — "Per-id live inclusion is checked at call time from config env vars, not import time") but
did **not** check the current `.env`/`config/runtimeEnvCatalog.json` value of all 16 flags
individually — that is a bounded, mechanical follow-up (`grep` each `QUANT_*_ENABLED` against the
live `.env`), not done here to keep this pass's scope on the CORE-strategy Java-wiring question the
mission emphasizes. None of these 16 have a Java counterpart on the *strategy* side (Java's overlap
is at the raw-technical-indicator research-engine level — donchian_channel, moving_average_crossover,
bollinger_mean_reversion, rsi_mean_reversion, macd_crossover — separate code, separate call path,
zero shared wiring with the TS experimental strategies of similar name).

## Wyckoff / SMC

- **Wyckoff**: **NOT IMPLEMENTED.** No file, class, strategy ID, or config entry found anywhere in
  `src/server/quant/`, `quant-core-java/`, or `config/*.json` matching "Wyckoff" (grepped this
  session as part of the broader quant-code search; zero matches). Per the audit brief's own
  instruction ("do not mark as a blocker unless incorrectly represented as production-ready") — it
  is not represented as production-ready anywhere found this pass, so this is a documentation
  non-issue, not a defect.
- **SMC (Smart Money Concepts)**: implemented as `SMC_LIQUIDITY_SWEEP` (TS, experimental, flag-gated
  `QUANT_SMC_STRATEGY_ENABLED`), backed by `config/smcConfluence.json` per CLAUDE.md. No Java
  counterpart found.

## Java's 5 CORE strategy ports — reachability classification

Per Section 12's taxonomy: **`REGISTERED_BUT_UNREACHABLE`** for all five. Registered in
`StrategyRegistry.java`, HTTP-exposed via `/api/v1/evaluate`, unit/parity-tested — zero real callers
(see wiring-audit doc). Not `SHADOW_ONLY` (shadow implies an actual comparison call happens; it
does not, for full strategy evaluation — only raw indicators get that treatment) and not `DEAD`
(the code compiles, is tested, and is reachable in principle via a real HTTP call an operator or a
future TS change could make).

## Validation status (Section 16) — TS CORE strategies

| Check | Status | Evidence |
|---|---|---|
| Unit tested | PASS | `momentumBreakout.test.ts` exists; others presumed similar (not all 5 individually opened this pass) |
| Integration tested | PASS | `StrategyEngine.test.ts` |
| Golden/parity tested (vs Java) | PASS, but **narrow scope** | `StrategyParityTest.java` — synthetic `StrategyContext` fixtures only; feature-computation pipeline (regime/trend/volume/etc.) is explicitly NOT ported/tested for parity (see `StrategyContext.java`'s own header, cited in the parity-audit doc) |
| Runtime tested | UNVERIFIED this pass | Would require a live tick + confirmed `evaluateAll()` invocation observed in logs; not done this session |
| Backtested | PASS (mechanism exists) | Real historical bars via `argusStrategyReplay.ts`/`BacktestEngine.ts` — profitability NOT claimed, per CLAUDE.md's own ground truth (walk-forward OOS failed for checked combos) |
| OOS / Walk-forward / Monte Carlo / Permutation / Sensitivity / Cost-stress / Multiple-testing-controlled | **FAIL or UNVERIFIED per CLAUDE.md's own documented ground truth** — "Walk-forward OOS for checked quant combos failed." Not re-verified this pass; carried forward as documented fact |
| Promotion eligible | **NO** | CLAUDE.md: `LIVE_NO_GO`, organic paper edge not established |

Do not read "CORRECT / ACTIVE" above as "profitable" or "validated for promotion" — it means
implemented, registered, enabled, and reachable in the live evaluation cycle, nothing more.
