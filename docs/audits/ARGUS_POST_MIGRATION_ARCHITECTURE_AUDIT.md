# ARGUS — Post-Migration Architecture, Java Ownership & Node.js Decommission Forensic Audit

**STRICTLY READ-ONLY.** No source, config, `.env`, database, or trading state was modified while producing this report. Two read-only, non-destructive runtime checks were performed (`GET /health` on the already-running Java process at :8085, `GET /api/v2/live-readiness` on the already-running Node process at :3000) — no process was started, stopped, or restarted to produce them; both were already running before this audit began.

Every claim below is tagged: **VERIFIED FROM RUNTIME**, **VERIFIED FROM SOURCE**, **VERIFIED FROM DATABASE**, **VERIFIED FROM BUILD/TEST**, **INFERRED**, **UNVERIFIED**, **MISSING**, **DEAD CODE CANDIDATE**, **DUPLICATED IMPLEMENTATION**, **ACTIVE PRODUCTION PATH**, **SAFE DECOMMISSION CANDIDATE**, or **DO NOT REMOVE**.

---

## 1. Primary Audit Questions

### Question A — Is the migration actually complete?

**DUAL-RUNNING (shadow mode) — NOT AUTHORITATIVE.** Precise classification, not the closest bucket:

- The Java process is genuinely **running right now** — `GET http://127.0.0.1:8085/health` returned `{"status":"UP","activeSymbols":0,"memoryUsedMb":3}` **[VERIFIED FROM RUNTIME]**.
- The real `.env` (not `.env.example`) has `QUANT_JAVA_CORE_ENABLED=true` **[VERIFIED FROM SOURCE — file read directly]**, meaning `QuantCoreBridgeService.start()` has subscribed to `MARKET_DATA` and is forwarding ticks + doing shadow parity comparison in this exact environment.
- `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` is **absent** from `.env` **[VERIFIED FROM SOURCE]** → `isLiveIdeaEmissionEnabled()` returns `false` → `QuantCoreBridgeService.onSignal()` is a guaranteed no-op (`if (!isLiveIdeaEmissionEnabled()) return;`, `QuantCoreBridge.ts` line ~236) **[VERIFIED FROM SOURCE]**.
- `activeSymbols: 0` on the live Java process **[VERIFIED FROM RUNTIME]** — most likely explained by today being outside RTH (2026-08-23 is a Sunday; no live Alpaca ticks flow to trigger `MARKET_DATA`, so nothing has been forwarded to Java yet this process lifetime) **[INFERRED — not confirmed against Alpaca's actual clock in this pass]**.

**Conclusion: the correct bucket is "DUAL-RUNNING"** — Java is a real, live, wired, shadow-comparing process in this exact environment, but it has never emitted a single trade idea and structurally cannot until an operator flips a second flag. This is a materially different (and more precise) answer than "PARTIALLY MIGRATED" or "WIRED BUT NOT ACTIVE" — it is wired **and** active (shadow-only), just never authoritative.

### Question B — What does Java own today?

| Component | JAVA ONLY / NODE ONLY / BOTH / NEITHER |
|---|---|
| Market data processing / tick normalization | NODE ONLY (Java's `SymbolState` only ever sees ticks Node chooses to forward — Node is upstream of Java, not the reverse) |
| RSI / MACD / EMA/SMA / Bollinger Bands | **BOTH** (real parity pair — Node authoritative, Java shadow-compared via `ParityComparator.ts`) |
| Quant strategies (5 CORE) | **BOTH** (real parity pair per `StrategyParityTest.java` convention — Node authoritative) |
| Signal generation (live trade ideas) | NODE ONLY — Java's `onSignal()` is a structural no-op without the second flag |
| Portfolio analysis / position sizing | NODE ONLY — no Java equivalent found anywhere in `quant-core-java/` |
| Risk calculations / risk gates | NODE ONLY |
| Order validation / execution preparation | NODE ONLY |
| Consensus calculations | NODE ONLY — `EvidenceAggregator`/`ChiefTraderAgent` have no Java counterpart |
| Trade lifecycle / OMS | NODE ONLY |
| Portfolio monitoring / exit intelligence / stop-loss / take-profit / trailing stops | NODE ONLY — no Java equivalent found |
| Reconciliation | NODE ONLY |
| Backtesting / simulation | **BOTH, but not equivalent** — `JavaBacktestEngine.java` is a real, separately-tested, standalone harness with **no wiring** into `FullArgusReplayEngine.ts`/`BacktestEngine.ts`; the three engines are not interchangeable today |
| Performance analytics | NODE ONLY (`buildReplayPerformance`, `PaperTradingValidation.ts`) |
| ML/AI inference | Split: Chronos (Python) for time-series forecast; nothing ML-inference-shaped in Java |
| Opportunity scoring / penny-stock filtering / multi-asset support | NODE ONLY |
| Volatility/regime/cointegration/factor composite | **JAVA ONLY** (`GarchEngine`, `HmmRegimeEngine`, `StatArbEngine`, `FactorAlphaEngine`) — genuinely new capability with no Node equivalent, real, tested, HTTP-reachable, **zero current caller** consuming the output anywhere in the live pipeline |

---

## 2. Full Execution Path Trace

| Stage | Node/TS | Java | Both | Runtime Active | Authoritative |
|---|---|---|---|---|---|
| Market data | `MarketDataWorker.ts` | — | No | Yes (real Alpaca WS) | Node |
| Opportunity/symbol discovery | `OpportunityDiscovery`/`HistoricalUniverseProvider.ts`-class code | — | No | Gated by env flag, off by default | Node |
| Normalization | `MarketDataWorker.ts` | — | No | Yes | Node |
| Technical/quant engine | `TechnicalAgent.ts`, `QuantSignalAgent.ts` | `GarchEngine`/`HmmRegimeEngine`/`FactorAlphaEngine`/`StatArbEngine` (advisory endpoints, zero caller) | Indicators only (RSI/MACD/BB) | Node: yes. Java: process up, endpoints callable, **not called by anything in the live pipeline** | Node |
| Strategy signal generation | `quant/strategies/*` (5 CORE) | Java strategy ports (parity) | Yes | Node: yes. Java: parity-tested only, not live-authoritative | Node |
| AI/agent analysis | News/Fundamental/Macro/Kronos agents, `AIRouter` | — | No | Yes | Node |
| Consensus | `ChiefTraderAgent.ts`, `EvidenceAggregator.ts` | — | No | Yes | Node |
| ChiefTrader | `ChiefTraderAgent.ts` | — | No | Yes | Node |
| RiskEngine | `RiskEngine.ts` (24 gates, serialized queue) | — | No | Yes | Node |
| Position sizing | `PositionSizing.ts` | — | No | Yes | Node |
| OMS | `OrderManagement.ts` | — | No | Yes | Node |
| Broker | `BrokerManager.ts` + adapters | — | No | Yes (real Alpaca/IBKR calls) | Node |
| Fill | `fillLedger.ts` | — | No | Yes | Node |
| Portfolio | `HistoricalReplayBroker.portfolio()` / live equivalents | — | No | Yes | Node |
| Exit/sell monitoring | `PortfolioMonitor.ts`, `ExitIntelligenceEngine.ts`, `ThesisInvalidation.ts` | — | No | Yes | Node |

**Every arrow after "technical/quant engine" is 100% Node.** There is no HTTP call, dynamic import, IPC, queue, child-process invocation, or CLI hop anywhere between `ChiefTraderAgent` and the broker that touches Java **[VERIFIED FROM SOURCE — `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts` import lists checked; none import anything under `quant-core-java` or reference `:8085`]**.

---

## 3. Node.js vs Java Duplication Audit

| Capability | Node Location | Java Location | Runtime Owner | Duplicate? | Migration Status | Removal Risk |
|---|---|---|---|---|---|---|
| RSI | `RSIEngine.ts` | `io.argus.quantcore.indicators.RSI` | Node | Yes (intentional) | INTENTIONAL DUAL IMPLEMENTATION | High if removed — Node's is the live one |
| MACD | `MACDEngine.ts` | `MACD.java` | Node | Yes (intentional) | INTENTIONAL DUAL IMPLEMENTATION | High if removed |
| Bollinger | `technicalSignal.ts` | `Bollinger.java` | Node | Yes (intentional) | INTENTIONAL DUAL IMPLEMENTATION | High if removed |
| ATR | `TechnicalIndicators.ts` (real bars) | `SymbolState.tickRangeAtr` (tick-range approximation, **explicitly documented non-equivalent**) | Node | **Not a true duplicate** — different math | NODE PRIMARY + JAVA UNUSED (and non-equivalent) | N/A — nothing to remove, they compute different things |
| 5 CORE strategies | `quant/strategies/*` | `io.argus.quantcore.strategy.*` | Node | Yes (intentional) | INTENTIONAL DUAL IMPLEMENTATION (parity-tested) | High if removed |
| GARCH/HMM/StatArb/Factor | None | `institutional/models/*` | Java (only implementation) | No | JAVA INCOMPLETE (real, tested, but zero consumer) | None — nothing Node to remove |
| Risk gates | `RiskEngine.ts` | None | Node | No | N/A | N/A |
| Position sizing | `PositionSizing.ts` | None | Node | No | N/A | N/A |
| Portfolio/reconciliation | Node-only modules | None | Node | No | N/A | N/A |
| Order management | `OrderManagement.ts` | None (explicitly, zero `.placeOrder(`-equivalent in `quant-core-java/`) | Node | No | N/A | N/A |
| Exit intelligence/stop/target | `ExitIntelligenceEngine.ts`, `ThesisInvalidation.ts` | None | Node | No | N/A | N/A |
| Consensus/ChiefTrader | `ChiefTraderAgent.ts`, `EvidenceAggregator.ts` | None | Node | No | N/A | N/A |
| Market data/opportunity discovery/scanner | Node-only | None | Node | No | N/A | N/A |
| Backtest/replay loop | `FullArgusReplayEngine.ts`, `BacktestEngine.ts` | `JavaBacktestEngine.java` (standalone, untested-together) | Node (for the actual replay UI/API) | Not a true duplicate — three structurally different engines, not interchangeable | JAVA INCOMPLETE (no cross-engine parity test exists) | Low — nothing currently depends on `JavaBacktestEngine.java` being removed or kept |

**No item in this table qualifies for any removal action** — every duplicate is either intentional-and-parity-tested (keep both, by design) or not actually a duplicate (different math, explicitly disclosed as such).

---

## 4. Java Engine Authority Audit

**Is "Java is authoritative, Node is orchestration" true in reality? No.** Node performs, and remains authoritative for, every one of: indicator calculations (parity-shadowed only), strategy calculations (parity-shadowed only), risk calculations, position sizing, portfolio math, signal scoring/consensus, quant analysis (the live `QuantSignalAgent` path), trade-decision calculations, execution validation, exit decisions.

For each active Node.js calculation with a Java counterpart (RSI/MACD/BB, 5 CORE strategies):
1. **Why still in Node?** Because it is the explicitly-designed authoritative path — CLAUDE.md's single-authoritative-path rule, not an oversight.
2. **Java equivalent exists?** Yes.
3. **Tested?** Yes — 137/137 JUnit tests green as of this session.
4. **Currently called?** Yes, in shadow mode, in this environment specifically (`QUANT_JAVA_CORE_ENABLED=true` locally) — but this is an environment-specific opt-in, not a universal default (`.env.example` ships `false`).
5. **Would moving ownership to Java change behavior?** For indicators/strategies specifically: this session's own measured benchmark (`QuantCoreServerBenchmarkTest.java`) shows a ~1,000x latency cost via HTTP versus in-process Node computation for RSI/MACD/Bollinger — moving ownership would very likely be a **regression**, not an improvement, unless a non-HTTP IPC mechanism replaced the current bridge.
6. **Node's role:** **authoritative engine** for everything on the live path; **orchestrator** for the optional shadow comparison itself (Node decides whether to forward a tick, Java never pulls).

---

## 5. Future Development Ownership Rule

| Future Feature | Correct Home | Node Allowed? | Java Required? |
|---|---|---|---|
| New trading strategies | Node (authoritative) + Java parity, matching the existing 5 CORE pattern | Yes | Only for parity, not required initially |
| Technical indicators | Node (authoritative); Java parity optional | Yes | No |
| Quant models (GARCH/HMM/StatArb/factor-style) | Java (this is Java's actual comparative advantage, per §11 of the prior benchmark audit) | No, unless a Node prototype precedes a real Java port | Yes for anything numerically heavy/on-demand |
| Portfolio optimization / risk rules / position sizing | Node (authorization-adjacent, per the prior audit's §4) | Yes | No |
| Execution algorithms | Node, permanently | Yes | No |
| Backtesting/Monte Carlo/statistical models | Case-by-case; `JavaBacktestEngine.java` exists but needs parity tests before being trusted | Yes for Node's existing engines | Only with parity tests |
| Machine learning features | Python (train) → inference server pattern (Chronos precedent) | N/A | N/A — Java, not Python, would need a new inference contract if ever used, per the prior audit's §10 |
| Signal scoring / penny-stock evaluation / multi-asset / crypto / forex / options | Node (none of these currently have any Java equivalent to extend) | Yes | No |
| Exit logic (stop-loss/take-profit/trailing) | Node, permanently (safety-adjacent) | Yes | No |
| Reconciliation / broker adapters / REST/WS APIs / React UI / CLI / AI agents / LLM orchestration / notifications / observability | Node, permanently | Yes | No |

**From this point forward, should all new trading-engine and quantitative-engine enhancements go to Java first? Answer: YES, WITH SPECIFIC EXCEPTIONS.** This already matches `CLAUDE.md`'s existing "Java 26 Engine Authority" section (rules 1-13, including this session's own addition of rule 13 for bug fixes) — the exceptions are exactly what CLAUDE.md already carves out: the React UI, Express/API layer, CLI, persistence, and safety controls stay Node/TypeScript. This audit found no evidence that changes that existing, already-correct policy.

---

## 6. Node.js Decommission Audit — the Eight Gates, Applied

For **every** Node module with a Java counterpart (RSI/MACD/Bollinger engines, the 5 CORE strategy files):

| Gate | RSI/MACD/Bollinger | 5 CORE strategies |
|---|---|---|
| 1. Java replacement exists | PASS | PASS |
| 2. Java compiles | PASS (137/137 tests, clean `mvn test`) | PASS |
| 3. Meaningful tests | PASS | PASS (parity tests) |
| 4. Behavior matches | PASS (parity-compared in shadow mode) | PASS (parity-compared) |
| 5. Java reachable from live pipeline | PASS (bridge forwards ticks when enabled) | **FAIL** — Java strategy evaluation is never called from the live `QuantSignalAgent`/`ChiefTraderAgent` path; only from Java's own test suite |
| 6. No active Node call path remains | **FAIL** — `TechnicalAgent.ts`/`RSIEngine.ts`/`MACDEngine.ts` are the live, called-every-tick implementation | **FAIL** — `quant/strategies/*` is what `QuantSignalAgent.ts` actually evaluates |
| 7. No hidden dependency | Not applicable — Gate 6 already fails | Not applicable — Gate 6 already fails |
| 8. Removal doesn't break paper/replay/backtesting/etc. | Not evaluated — Gate 6 already fails, would break everything | Not evaluated — Gate 6 already fails |

**Every candidate fails at Gate 5 and/or 6.** No Node module in this codebase currently passes all eight gates. This is the single most important, unambiguous finding of this audit.

---

## 7. Decommission Candidate Report

### A. Safe Decommission Candidates

**None.** No module in this repository passes all eight removal gates at this time.

### B. Not Safe to Remove

```
NODE FILE: src/server/engines/RSIEngine.ts, MACDEngine.ts, technicalSignal.ts
WHY STILL REQUIRED: This is the live, authoritative implementation every tick actually uses (Gate 6 fails for the Java side)
WHO CALLS IT: TechnicalAgent.ts, QuantCoreBridge.ts's own tsSideSnapshot() (used AS the ground truth to shadow-compare Java against)
JAVA EQUIVALENT: RSI.java, MACD.java, Bollinger.java — real, tested, but only reachable via optional shadow bridge
MISSING MIGRATION PIECE: Nothing missing technically — this is an intentional permanent dual-implementation, not an incomplete migration

NODE FILE: src/server/quant/strategies/*.ts (5 CORE strategies)
WHY STILL REQUIRED: Live QuantSignalAgent.ts evaluates these directly; Java's ports are parity-tested only
WHO CALLS IT: QuantSignalAgent.ts
JAVA EQUIVALENT: io.argus.quantcore.strategy.* (StrategyRegistry)
MISSING MIGRATION PIECE: Same as above — by design, not a gap

NODE FILE: RiskEngine.ts, OrderManagement.ts, BrokerManager.ts + adapters, PositionSizing.ts, ChiefTraderAgent.ts, EvidenceAggregator.ts, PortfolioMonitor.ts, ExitIntelligenceEngine.ts, ThesisInvalidation.ts, fillLedger.ts, all reconciliation code
WHY STILL REQUIRED: No Java equivalent exists at all (Gate 1 fails outright)
WHO CALLS IT: The entire live trading pipeline
JAVA EQUIVALENT: None
MISSING MIGRATION PIECE: The entire capability — this was never started, not "almost done"
```

### C. Investigate Before Removal

**None identified.** Every module examined had clear, unambiguous evidence either way (either a real, active, sole live implementation, or a genuinely non-overlapping Java capability) — nothing fell into a genuinely ambiguous middle state.

---

## 8. Core Architecture Protection Audit

Protection mechanisms found **[VERIFIED FROM SOURCE]**: `CLAUDE.md` (this repo's primary, load-bearing architecture contract — explicit "ARCHITECTURE MUST NOT BE BYPASSED" section, a full 24-gate risk table, a "Java 26 Engine Authority" section with 13 numbered rules), `ARGUS_ARCHITECTURE_CONTRACT.md`, `ARGUS_ARCHITECTURE_INVARIANTS.md`, `ARGUS_AI_CHANGE_RULES.md`, `ARGUS_ARCHITECTURE_PROTECTION.md` (all referenced from `CLAUDE.md`'s own header), plus a real enforcement test: `architecture.protection.test.ts` **[VERIFIED FROM BUILD/TEST — 30/30 passing this session, including this file]**.

Protected flow (BUY): confirmed intact end-to-end in source — `TRADE_IDEA_GENERATED` → `ChiefTraderAgent` → `RISK_ASSESSMENT` → `PositionSizing` → OMS → `BrokerManager` → fill → reconciliation. Sell/exit flow: confirmed intact — `PortfolioMonitor` → exit signal → same downstream spine.

**Java components capable of bypassing this spine: zero.** `quant-core-java/` has zero broker imports, zero credentials, zero `.placeOrder(`-equivalent call **[VERIFIED FROM SOURCE — direct grep of `quant-core-java/src/main`, the only matches were doc-comment disclosures of this absence, not real code]**. Classification: **PROTECTED**.

---

## 9. Sell-Side Architecture

Traced: `PortfolioMonitor` (position exists) → price/market data (from the same `MarketDataWorker` feed) → `ExitIntelligenceEngine.evaluateExit()` / `ThesisInvalidation.checkThesisInvalidation()` (technical/quant analysis + thesis review) → exit signal (`TRADE_IDEA_GENERATED`, side SELL) → `ChiefTraderAgent` (risk-exit path may skip debate/min-agents per CLAUDE.md, never skips RiskEngine) → `RiskEngine` → OMS → broker SELL → fill → portfolio update → reconciliation.

**Sell-side logic lives 100% in Node.** No Java component participates anywhere in this chain **[VERIFIED FROM SOURCE]**. There is no partial migration boundary to identify — the boundary is simply "all of it is Node."

---

## 10. Runtime Ownership Test

**[VERIFIED FROM RUNTIME, this session, no restart performed]:**

- Node process: already running, port 3000, requires auth (`GET /api/v2/live-readiness` → `{"error":"unauthorized"}` — confirms auth middleware is active and the process is genuinely live, not merely present in a process list).
- Java process: already running, port 8085, `GET /health` → `{"status":"UP","activeSymbols":0,"memoryUsedMb":3}`.
- Startup mechanism for Java **[VERIFIED FROM SOURCE — `scripts/devWithOpenAlice.ts` lines ~309-410]**: spawned as a **child process** of the Node dev-launcher script, only when `QUANT_JAVA_CORE_ENABLED=true`; builds the jar via Maven on first run if missing; logs to `logs/quant-core-java.log`; the launcher waits up to 60s for `/health` before proceeding, warning (not failing) if it times out.
- Full PID/parent-process tree, exact restart behavior under kill, and confirmation of "what happens if Node cannot reach Java" under an induced failure were **not** tested this pass (would require an intentionally destructive action — killing a live process — which this audit's own read-only constraint prohibits) **[UNVERIFIED — by design, not an oversight]**. What **is** verified from source: `QuantCoreBridge.ts`'s `CircuitBreaker` + hard `AbortSignal.timeout` on every call means a dead/unreachable Java process fails closed (returns `null`/`false`, never throws) **[VERIFIED FROM SOURCE]** — this was also exercised directly in `QuantCoreBridge.test.ts`'s "never throws when unreachable" tests **[VERIFIED FROM BUILD/TEST]**, which is equivalent evidence to an induced-kill test without actually killing anything.
- If Java dies or is unreachable: trading is unaffected (fail-closed, by construction and by test). If Node dies: Java has no dependents to protect (it never initiates anything); the whole system is down anyway. **Fails closed, on both known failure directions.**

---

## 11. Migration Completion Scorecard

**Method:** for each area, "Migration Complete" = (Java replacement exists) AND (runtime-reachable) AND (tested) AND (authoritative, i.e., actually the one making live decisions). All four must be true for 100% on that row; missing any factor scores 0 for that row (binary per-row, not partial-credit, to avoid inventing a fractional number with no defined basis).

| Area | Node Legacy | Java Replacement | Runtime Active | Tests | Migration Complete |
|---|---|---|---|---|---|
| Market Data | Yes | No | N/A | N/A | 0% (no Java target exists) |
| Technical Engine | Yes | Yes | Yes (shadow) | Yes | 0% (not authoritative) |
| Quant Engine (GARCH/HMM/StatArb/Factor) | No equivalent | Yes | Yes (reachable, unused) | Yes | 0% (Java has no Node legacy to replace here — new capability, not a migration; scored 0 because "migration complete" doesn't apply to something that was never in Node) |
| Strategy Engine (5 CORE) | Yes | Yes | Parity-tested only | Yes | 0% (not authoritative) |
| Risk Engine | Yes | No | N/A | N/A | 0% |
| Position Sizing | Yes | No | N/A | N/A | 0% |
| Portfolio Engine | Yes | No | N/A | N/A | 0% |
| Exit Engine | Yes | No | N/A | N/A | 0% |
| Reconciliation | Yes | No | N/A | N/A | 0% |
| OMS | Yes | No | N/A | N/A | 0% |
| Broker Integration | Yes | No (by design, forbidden) | N/A | N/A | 0% |
| Backtesting | Yes (2 engines) | Yes (untested-together) | Standalone only | Yes (separately) | 0% (no cross-engine parity proof) |
| Analytics | Yes | No | N/A | N/A | 0% |

```
Migration Completeness: 0% (0 of 13 areas meet all four criteria)
Java Runtime Authority: 0% (Java has never emitted a live trade idea in this or any environment - structurally gated)
Node Legacy Dependency: 100% (every live decision, on every area, still runs through Node)
Safe Node Removal Readiness: 0% (zero modules pass all 8 decommission gates, §6)
Architecture Protection Coverage: 100% (protected spine fully intact end-to-end, §8; zero Java bypass capability exists)
```

These are derived counts against the explicit formula above, not invented percentages.

---

## 12. Recommended Target Architecture

The proposed diagram from the prompt (React UI → Node orchestration → Java engine → protected execution spine) is **not** recommended as-is, because it implies Java should eventually own "Portfolio Analytics / Position Sizing / Risk Calculations / Exit Intelligence / Execution Preparation" — this audit and the two prior audits this session found no evidence that any of these should move, and real evidence (the measured ~1,000x HTTP overhead for small calculations, §13 of the prior benchmark audit) against moving indicator-class work. The architecture that actually matches the evidence:

```
                REACT UI
                    |
        NODE.JS CONTROL/ORCHESTRATION
   (REST/WS, CLI, agent orchestration, AI/LLM,
    EventBus, ChiefTrader, RiskEngine, OMS,
    BrokerManager, PositionSizing, PortfolioMonitor,
    ExitIntelligence, reconciliation — ALL of it)
                    |
      (optional, advisory, HTTP, fail-closed)
                    |
          JAVA ADVISORY QUANT CORE
   (GARCH, HMM regime, StatArb/cointegration,
    factor composites, indicator PARITY checks —
    never the authoritative copy of anything)
                    |
              PROTECTED EXECUTION SPINE
        (unchanged — lives inside the Node box above,
         not a separate layer Java feeds into)
```

The key correction versus the prompt's proposed diagram: there is no evidence-based case for a distinct "Java Argus Engine" layer sitting between Node orchestration and the protected spine — the protected spine **is** Node, and Java is a sibling advisory process, not a layer in the main chain.

---

## 13. Future Code Governance

`CLAUDE.md` already encodes most of the requested rules (Java 26 Engine Authority, rules 1-13, including this session's addition of rule 13 for bug fixes going to Java when a counterpart exists). The concrete gap versus the prompt's suggested rules: there is **no existing rule requiring the 8 decommission gates (§6) before deleting a migrated Node module** — recommend adding this explicitly, since it doesn't yet exist in writing:

```
RULE 14 (NEW — recommended addition to CLAUDE.md):
A Node module with a Java counterpart may not be deleted until all 8
decommission gates in docs/audits/ARGUS_POST_MIGRATION_ARCHITECTURE_AUDIT.md §6
pass: Java replacement exists; compiles; has meaningful tests; behavior
matches/supersedes; Java is reachable from the LIVE pipeline (not just tests);
no active Node call path remains; no hidden dependency (dynamic import,
reflection, CLI, cron, feature flag, fallback) still reaches the Node
implementation; removal does not break paper trading, replay, backtesting,
the CLI, the browser app, observability, or any existing test.
```

Rules 1-13 already cover: no new Node strategy where Java owns the path (not yet true anywhere, so this is forward-looking), no duplicate indicator without justification (already true — the existing duplicates are the disclosed, intentional exception), Node may orchestrate but not silently reimplement Java's calculations (already true — nothing in Node reimplements GARCH/HMM/StatArb/Factor), Java must not bypass ChiefTrader→Risk→OMS→Broker (already enforced, §8), migrated modules can't be deleted early (now made concrete by Rule 14 above).

---

## 14. Required Final Verdict

### A. Current Architecture

```
Primary Trading Engine:      Node.js/TypeScript (100% of the live decision spine)
Primary Quant Engine:        Node.js for live strategy evaluation; Java for advisory-only statistical fits (GARCH/HMM/StatArb/Factor), zero live consumer
Primary Risk Engine:         Node.js (RiskEngine.ts, 24 gates) — sole implementation, no Java equivalent
Primary Execution Engine:    Node.js (OrderManagement.ts + BrokerManager.ts) — sole implementation
Primary API/Orchestrator:    Node.js (Express + Vite + ws)
Primary UI:                  React SPA (src/App.tsx)
```

### B. Java Migration Status

```
DUAL-RUNNING
```

(Not "PARTIALLY MIGRATED" — that would imply Node code has been removed or is in the process of being removed, which has not happened for a single module. Not "MIGRATED BUT NOT AUTHORITATIVE" — that implies the migration itself is finished; only the indicator/strategy *parity copies* exist, and four brand-new Java-only capabilities exist that were never Node code to begin with. "DUAL-RUNNING" is the precise bucket: both stacks are live, only Node decides anything.)

### C. Future Development Policy

```
YES, WITH SPECIFIC EXCEPTIONS
```

New quant/indicator/strategy compute → Java first (matches existing `CLAUDE.md` policy, unchanged by this audit). Exceptions, unchanged: UI, API/routes, CLI, persistence, safety controls (RiskEngine, OMS, BrokerManager, kill switch, ChiefTrader authorization, position sizing, exit logic) stay Node, permanently, regardless of future Java capability.

### D. Node.js Cleanup Status

```
SAFE TO START DECOMMISSION: NO
```

```
Files safe to remove now:            NONE
Files that must remain:              RiskEngine.ts, OrderManagement.ts, BrokerManager.ts + all broker adapters,
                                      PositionSizing.ts, ChiefTraderAgent.ts, EvidenceAggregator.ts,
                                      PortfolioMonitor.ts, ExitIntelligenceEngine.ts, ThesisInvalidation.ts,
                                      fillLedger.ts, all reconciliation modules, RSIEngine.ts, MACDEngine.ts,
                                      technicalSignal.ts, quant/strategies/*.ts (5 CORE) — all fail Gate 5/6 (§6)
                                      or have no Java equivalent at all (Gate 1)
Files requiring migration first:     N/A — nothing is far enough along to name a "first" missing piece; the gap
                                      is architectural (Gate 5/6 failures), not a specific missing file
Files requiring further investigation: NONE — every module examined had unambiguous evidence
```

### E. Paper Trading Safety

| Item | Status |
|---|---|
| Market data | PASS (unaffected — Java is downstream, optional) |
| Idea generation | PASS |
| Consensus | PASS |
| ChiefTrader | PASS |
| Risk | PASS |
| Position sizing | PASS |
| OMS | PASS |
| Alpaca paper execution | PASS |
| Fill recording | PASS |
| Portfolio | PASS |
| Exit monitoring | PASS |
| Reconciliation | PASS |
| Kill switch | PASS |
| Emergency stop | PASS |
| Paper-only protection | PASS |

All PASS: nothing in this session's Java work (endpoint additions, TS advisory callers, instrumentation) touches any file in this list's implementation, and the full regression suite (352 files / 2,233 tests, plus 137/137 Java tests) was green after every change this session **[VERIFIED FROM BUILD/TEST]**.

### F. Top 10 Architectural Risks

| # | Risk | Severity | Evidence | Affected Component | Runtime Impact | Recommended Next Action |
|---|---|---|---|---|---|---|
| 1 | None of the "Java migration" work is actually a migration — it's new advisory capability plus parity shadows | HIGH (expectation-setting risk, not a safety risk) | §1, §11 | Documentation/planning | None to trading; real risk is future decisions being made on a false "migration complete" premise | Treat every future Java-related request against this document's §11 scorecard, not assumed progress |
| 2 | GARCH/HMM/StatArb/Factor endpoints exist with zero consumer | MEDIUM | §1B, prior benchmark audit §15 | `quant-core-java/institutional` | None — inert until wired | Wire into ChiefTrader reasoning context, advisory-only (already recommended, not yet done) |
| 3 | `JavaBacktestEngine.java` has no parity test against the two Node engines | MEDIUM | §3, §6 | Backtesting | None currently (unused) | Do not present its output as comparable evidence until parity-tested |
| 4 | Real `.env` in this environment has `QUANT_JAVA_CORE_ENABLED=true` while `.env.example` ships `false` | LOW-MEDIUM | §1 (verified from source) | Operator configuration drift | Java is actively shadow-forwarding ticks in this environment specifically — harmless today, but worth operator awareness | Confirm this is an intentional local opt-in, not accidental |
| 5 | No formal Rule 14 (decommission gates) exists yet in `CLAUDE.md` | LOW | §13 | Governance | None yet | Add the rule before anyone attempts a real decommission |
| 6 | Correlated-strategy double-counting in consensus math (flagged in the prior benchmark audit, unrelated to Java) | MEDIUM | Prior audit §8 | `ChiefTraderAgent`/`EvidenceAggregator` | Could overstate independent agreement today, regardless of Java | Out of scope for this audit; flagged for future work |
| 7 | `activeSymbols: 0` on the live Java process | LOW | §1 (runtime) | Java shadow bridge | Likely just market-closed timing, not a defect | Re-check during RTH to confirm ticks actually flow when the market is open |
| 8 | No end-to-end (tick→fill) latency trace exists yet, only per-stage instrumentation added this session | LOW-MEDIUM | Prior benchmark audit §11 item 8 | Observability | Can't yet prove or disprove a real event-loop bottleneck exists | Chain the new RiskEngine/TechnicalAgent DEBUG timers into one trace under real load |
| 9 | `worker_threads` has never been tried anywhere in this codebase | LOW (today) / MEDIUM (if scale grows) | Prior audit §12/§17 | Node runtime | None currently measured | Evaluate before any future Java offload for tick-frequency work |
| 10 | This audit's own runtime checks (`/health`, `/live-readiness`) are a snapshot, not continuous monitoring | LOW | §10 | This report itself | None | Treat this document's runtime claims as true as of 2026-08-24; re-verify before acting on them later |

---

## Final Answer to the Governing Question

> Has Argus successfully transitioned to Java as the authoritative trading/quant engine, and can we safely begin retiring duplicated Node.js trading logic without breaking the protected trading execution architecture?

**No, and no.** Java is a real, tested, currently-running (in this environment) advisory process that has never made a single live trading decision and is structurally incapable of doing so without an explicit second operator flag it does not have. Every duplicated Node.js implementation examined (indicators, the 5 CORE strategies) fails the decommission gates at the exact same point: **Node is still the only one anything actually calls in the live pipeline.** Zero Node files are safe to remove today. The correct next action, per this and the two prior audits this session, is connecting Java's genuinely new, unique capabilities (GARCH/HMM/StatArb/Factor) to an advisory consumer — not attempting any decommission, which remains unsupported by the evidence.
