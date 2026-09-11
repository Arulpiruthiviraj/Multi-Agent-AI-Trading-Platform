# ARGUS Java Quant Core — Node↔Java Wiring Audit (2026-09-09)

Answers Section 7/8 of the audit brief. Cross-reference: `ARGUS_QUANT_OWNERSHIP_MATRIX_CURRENT.md`.

## `QuantCoreServer.java` — complete route table (read directly this session)

| Route | Handler | Purpose | Confirmed caller on TS side |
|---|---|---|---|
| `GET /health` | `handleHealth` | Process health, memory | `QuantCoreBridge`'s circuit breaker / health probes |
| `POST /api/v1/ticks` | (tick ingest) | Feeds `SymbolState`'s independently-accumulated ring buffer | `QuantCoreBridge.sendTick()` (fire-and-forget, no delivery guarantee — see parity-audit doc) |
| `GET /api/v1/indicators/{symbol}` | `handleIndicators` | Returns `IndicatorSnapshot` (RSI/MACD/BB/ATR/VWAP/regime) computed from Java's own tick buffer | `QuantCoreBridge.compareParity()` — shadow-only, logs divergence, never feeds a decision |
| `POST /api/v1/evaluate` | `handleEvaluate` | Runs a named CORE strategy (`StrategyRegistry.evaluate(strategyId, ctx)`) against a caller-supplied `StrategyContext` | **NONE** — zero callers found anywhere in `src/` (HIGH, VERIFIED: grep across the whole tree excluding stale worktree copies and the Java side itself) |
| `GET /api/v1/features/regime/{symbol}` | `handleFeaturesRegime` | Regime classification | `QuantCoreBridge.compareRegimeParity()` — shadow-only |
| `POST /api/v1/institutional/factors/{symbol}` | `handleInstitutionalFactors` | 5-factor composite (`FactorAlphaEngine`) | `fetchInstitutionalFactors()` → `JavaQuantAdvisoryService.ts` (advisory) + `ChiefTraderAgent.ts` debate-text |
| `POST /api/v1/institutional/pairs` | `handleInstitutionalPairs` | Stat-arb pair evaluation | `fetchInstitutionalCorrelation`-adjacent; registry marks `stat_arb` `liveConsumer: NONE` |
| `POST /api/v1/institutional/volatility/{symbol}` | `handleInstitutionalVolatility` | GARCH + realized-vol | `fetchInstitutionalVolatility()` → `JavaQuantAdvisoryService.ts` |
| `POST /api/v1/institutional/regime/{symbol}` | `handleInstitutionalRegime` | HMM regime | `fetchInstitutionalRegime()` → `JavaQuantAdvisoryService.ts` |
| `POST /api/v1/institutional/features/{symbol}` | `handleInstitutionalFeatures` | Feature pipeline + market-data-quality gate | `fetchInstitutionalFeatures()` → `JavaQuantAdvisoryService.ts` |
| `POST /api/v1/institutional/correlation` | `handleInstitutionalCorrelation` | EWMA covariance | `fetchInstitutionalCorrelation()` exists, **tested but unused** per registry |
| `POST /api/v1/institutional/ensemble` | `handleInstitutionalEnsemble` | `QuantEnsembleEngine` correlation-adjusted vote combination | `fetchInstitutionalEnsemble()` exists per registry as unused; **but** `internalQuantEnsemble.ts` (different call path, confirmed live via `QuantSignalAgent.ts:54`) uses the same underlying engine for the independence-count qualification check — see ownership matrix |
| `POST /api/v1/institutional/advisory` | `handleInstitutionalAdvisory` | `RegimeVolatilityOverlay` | `fetchInstitutionalAdvisory()` exists, tested but unused per registry |
| `POST /api/v1/institutional/strategy/{id}/{symbol}` | `handleInstitutionalStrategy` | Dispatches to one of ~10 newly-HTTP-exposed research engines by string id | **Confirmed live caller exists**: `internalQuantEnsemble.ts:113` calls `quantCoreBridge.fetchResearchStrategy(id, symbol, bars)` for each id in `JAVA_RESEARCH_STRATEGY_IDS` (a specific, named subset — not all 123 engines). The route's own code comment (dated 2026-09-09, i.e. added same day as this audit) says "nothing in `JavaQuantAdvisoryService.ts` or `QuantSignalAgent.ts` calls this route yet" — that comment is accurate for those two specific files but incomplete: `internalQuantEnsemble.ts` (itself imported by `QuantSignalAgent.ts`) does call it. Net effect: **some** research strategies reachable via this route are live-consumed (via the ensemble-qualification path), not zero as the code comment's phrasing might suggest in isolation |

## End-to-end trace: an actual `/api/v1/evaluate` request (constructed, not fired live)

```text
TS caller:            NONE EXISTS — this trace is hypothetical, showing what WOULD happen if
                       something called it, since no real caller does today.
 ↓ (would be)
QuantCoreBridge:       no method named evaluate/callEvaluate exists on QuantCoreBridge.ts —
                       a new method would need to be written; none of the 10 existing fetch*/
                       compare* methods target this route.
 ↓
POST /api/v1/evaluate  (Java, handleEvaluate)
 ↓
StrategyRegistry.evaluate(strategyId, ctx) → MomentumBreakout.evaluate(ctx) etc.
 ↓
StrategyEvaluation      returned as JSON
 ↓
TS response handling:   NONE — nothing parses this response today.
```

**Conclusion for Section 8: the 5 CORE strategies' Node→Java bridge path does not exist in
practice.** The endpoint, registry, and strategy classes are real and unit-tested; the wire has
never been connected on the TS side. This is `IMPLEMENTED_BUT_UNREGISTERED`-adjacent in Section 12's
reachability taxonomy — more precisely **`REGISTERED_BUT_UNREACHABLE`** (registered in
`StrategyRegistry.java`, reachable in principle via HTTP, but no caller exists).

## End-to-end trace: an actual live institutional-engine request (real, confirmed path)

```text
QuantSignalAgent.ts (real live agent, QUANT_ENGINE_ENABLED gated)
 ↓ imports computeInternalEnsembleQualification (line 54)
internalQuantEnsemble.ts
 ↓ for each id in JAVA_RESEARCH_STRATEGY_IDS:
 quantCoreBridge.fetchResearchStrategy(id, symbol, bars)
 ↓ POST /api/v1/institutional/strategy/{id}/{symbol}  (real HTTP call, real circuit breaker)
Java: handleInstitutionalStrategy → dispatches by id to the matching RESEARCH engine
 ↓ JSON response
internalQuantEnsemble.ts: sends the combined vote list through
 QuantEnsembleEngine.java's effectiveIndependentCount() math (via handleInstitutionalEnsemble,
 or an equivalent direct call — not independently re-traced this pass at the Java-internal level)
 ↓
qualifiesAsIndependent: boolean  — real, live, fails closed on any bridge error
 ↓
QuantSignalAgent.ts consumes this to determine independence-count eligibility for consensus
```

This path is **real and live**, distinct from every other institutional-engine wiring, and is the
one place in this whole audit where a Java research engine's output has a genuine (if narrow —
independence-count qualification, not a vote) effect on what reaches ChiefTrader's consensus math.
Fail-closed behavior confirmed via the module's own header comment (cited in the ownership matrix).

## Circuit breaker / fail-closed behavior

`QuantCoreBridge`'s own breaker (`this.breaker`, referenced across every `fetch*`/`compareParity`
method) — `isOpen()` checked before every real call, `recordFailure()`/`recordSuccess()` after every
attempt. Every method returns `null` (or, for the parity comparators, simply skips) on:
- `isQuantJavaCoreEnabled()` false
- breaker open
- non-2xx HTTP response
- any thrown error (network, timeout, malformed JSON)

No method was found that treats a malformed/stale Java response as anything other than "no data" —
i.e., **fail-closed, never fail-open**, confirmed across all 10 `fetch*`/`compare*` methods read
this session. Staleness (an old-but-well-formed response) is not independently checked at the
bridge layer — each institutional engine embeds no timestamp/freshness field in its own response
that the bridge validates; this is **UNVERIFIED** as a real gap vs. a non-issue (would need each
engine's response schema individually reviewed, not done this pass).
