# Argus — Opportunity Capture + Reliability Remediation (2026-09-03)

**Scope note (agreed with the operator before implementation began):** the originally-requested mission spanned a full engine-reliability/supervisor rebuild, the NewsEngine bugfix, a complete universal opportunity-discovery-funnel redesign (9 opportunity classes, dynamic ranking, resource-aware allocation, starvation prevention, a Category-A missed-opportunity detector), statistical confidence-calibration research, market-regime classification, and live RTH monitoring — realistically months of work. With ~1h40m until today's market open, the operator explicitly chose **"bounded, high-confidence fixes only"** over attempting the full spec shallowly. This report documents exactly that bounded scope, honestly marks everything else as deferred, and does not claim completeness it doesn't have.

Evidence labels: `[VERIFIED]` `[TESTED]` `[RUNTIME VERIFIED]` `[IN PROGRESS]` `[UNVERIFIED]` `[DEFERRED]`.

---

## 1. What was fixed

1. **NewsEngine `MISSING_PRICE` race** (`[VERIFIED]` `[TESTED]`) — the confirmed root cause of 147/147 Sept 2 `TRADE_IDEA_REJECTED` events. See §7.
2. **A shared, reusable, allocator-aware bounded-wait primitive** (`src/server/core/waitForFreshMarketData.ts`) — not NewsEngine-specific, so a future fix to FundamentalAgent.ts's identical latent bug (§2, item 2) can reuse it rather than re-inventing it.
3. **Engine health diagnostics extended** — `memoryRssMb`/`memoryHeapUsedMb` added to `ArgusRuntime.health()` (`[VERIFIED]` `[RUNTIME VERIFIED]` — confirmed live in today's `/api/v2/runtime/health` response).
4. **Statistical investigation of the Sept 2 ChiefTrader confidence concentration and the Fundamental/Macro 100%-HOLD pattern** completed with a real, evidence-backed conclusion for each (§10, §9) — not left as an open question.

## 2. What remains unresolved (explicitly deferred, not silently skipped)

1. **Process supervision / safe auto-recovery** (original spec §3) — **not built**. Designing a fail-closed supervisor (detect death → verify safety flags → restart → reconnect broker/market-data → resume only if safe) is a substantial, safety-critical piece of infrastructure that cannot be responsibly built and verified in the time available before today's open. `argus-cli` remains operator-driven only, exactly as the Sept 2 audit found it.
2. **FundamentalAgent.ts's identical subscribe-then-immediately-read race** — the code comment this session's NewsEngine fix replaced explicitly pointed at "FundamentalAgent.ts's identical comment." That call site was **not** touched. It is a real, separately-scoped follow-up using the same `waitForFreshMarketData.ts` primitive built this session.
3. **The full universal opportunity-discovery-funnel redesign** (original spec §6-§13: cheap-scan-first architecture, 9 explicit opportunity classes, ~20-field dynamic ranking schema, resource-aware fair allocation, starvation-prevention measurement, a permanent Category-A missed-opportunity detector) — **not built**. What already exists (`MarketUniverseScanner.ts`, the broad-universe/movers/news discovery funnels, `requestTemporaryDataRescue()`'s existing NEW_DATA_ACQUISITION/RENEWAL fairness split) was audited and found materially real (not a stub) in both the Sept 2 forensic audit and this session's own DB queries, but was not re-architected.
4. **Market regime classification** (original spec §17) — not built this session.
5. **Agent-evidence-quality restructuring** (original spec §16 — explicit structured per-candidate evidence fields distinguishing `DATA_UNAVAILABLE`/`HOLD`/`BUY`/`SELL`) — FundamentalAgent/MacroAgent already have this distinction in practice (confirmed in §9); it was not extended to other agents this session.
6. **Full live-RTH-session metrics** (original spec §24) — the engine was started and verified safe well before today's open (§11), but as of publishing this report the regular session has not yet run its full course. See §12 for what's confirmed so far and what remains `[IN PROGRESS]`.

---

## 3. Before/after architecture (scoped to what actually changed)

```
BEFORE (Sept 2, confirmed by the forensic audit):

NewsEngine catalyst for symbol X
    │
    ▼
marketDataWorker.subscribe(X)         ← fire-and-forget, no allocator awareness
    │
    ▼
marketDataWorker.getLatestPrice(X)    ← read on the very next line, zero wait
    │
    ▼
null (symbol wasn't already streamed)
    │
    ▼
eventBus.emitTradeIdea({ currentPrice: undefined, ... })
    │
    ▼
gateTradeIdea() → TRADE_IDEA_REJECTED { reason: "MISSING_PRICE" }   ← 147/147 times on Sept 2
    │
    ▼
ChiefTrader never sees it


AFTER (this session):

NewsEngine catalyst for symbol X
    │
    ▼
waitForFreshMarketData(X, { requestClass: 'NEWS_CATALYST', reason, traceId })
    │
    ├─→ marketDataWorker.requestTemporaryDataRescue(X, ...)   ← the SAME reviewed, capacity-bounded,
    │        │                                                   NEW_DATA_ACQUISITION/RENEWAL-aware
    │        ▼                                                   allocator every other rescue caller uses
    │   denied? → structured log NEWS_IDEA_DISCARDED_RESCUE_DENIED, explicit reason, NO idea emitted
    │
    └─→ granted → bounded poll (newsPriceWaitTimeoutMs=8s, newsPriceWaitPollIntervalMs=250ms)
             for a real, freshness-verified tick (same stalePriceThresholdMs bound RiskEngine's
             own data_freshness gate uses)
                 │
                 ├─→ fresh tick arrives → eventBus.emitTradeIdea({ currentPrice: <real> }) →
                 │        gateTradeIdea() passes → TRADE_IDEA_GENERATED → ChiefTrader sees it
                 │
                 └─→ timeout → structured log NEWS_IDEA_DISCARDED_NO_FRESH_DATA, explicit reason,
                          NO idea emitted, NO stale/fabricated price

Fire-and-forget per symbol - one slow/denied wait never blocks NewsEngine's processing of the
next article or the next symbol.
```

No other stage of the pipeline (ChiefTrader → RiskEngine → OMS → BrokerManager) was touched.

---

## 4. Discovery coverage

`[VERIFIED]` Not re-architected this session (§2 item 3). Re-confirmed from the forensic audit and this session's own queries: `ARGUS_BROAD_UNIVERSE_ENABLED`, `ARGUS_MARKET_MOVERS_ENABLED`, `ARGUS_OPPORTUNITY_LOOP_ENABLED`, and `QUANT_ENGINE_ENABLED` are all currently `true`; Sept 2's real event trail shows discovery genuinely touching 100+ distinct symbols (broad, not narrow) even though only 10 ever reached a full ChiefTrader consensus round. This gap — broad discovery vs. narrow ChiefTrader survival — is exactly what §2 item 3's deferred funnel redesign would address; it is not solved by this session's fixes.

## 5. Dynamic opportunity ranking

`[DEFERRED]`. Not built this session (§2 item 3).

## 6. Market-data allocation

`[VERIFIED]` Unchanged and re-used correctly by this session's own fix: `MarketDataWorker.requestTemporaryDataRescue()` already implements a real `NEW_DATA_ACQUISITION` vs `RENEWAL` distinction with a capacity-bounded, priority-class-aware admission rule (`src/server/services/MarketDataWorker.ts:320-453`, unchanged this session). The NewsEngine fix (§7) now routes through this exact mechanism with `requestClass: 'NEWS_CATALYST'` instead of a raw, allocator-blind `subscribe()` call — a real improvement in allocator awareness, not a new allocator.

## 7. NewsEngine fix

`[VERIFIED]` `[TESTED]` Files: `src/server/core/waitForFreshMarketData.ts` (new), `src/server/news/NewsEngine.ts` (modified call site, `src/server/news/NewsEngine.ts:325-390` region), `config/tradingSafety.json` + `src/server/config/tradingSafety.ts` (two new keys: `newsPriceWaitTimeoutMs: 8000`, `newsPriceWaitPollIntervalMs: 250`).

Safety properties preserved (all `[TESTED]` in `waitForFreshMarketData.test.ts`, 7 tests):
- Never returns a stale price (re-checks freshness against the same `stalePriceThresholdMs` RiskEngine's own gate 13 uses — no second, looser threshold).
- Never fabricates a price — a timeout, a denial, or an internal error all return a typed `{ ok: false }`, never a substitute number.
- Bounded wait only (8s default) — never an unbounded poll.
- Goes through the existing, reviewed `requestTemporaryDataRescue()` allocator path — never a new, ad hoc subscription mechanism.
- Duplicate-safe — concurrent callers for the same symbol share one in-flight wait (`[TESTED]`: "deduplicates concurrent waits... single allocator call").
- Fire-and-forget per symbol — confirmed by construction (the `.forEach()` loop's callback never awaits the async IIFE) and by the existing `NewsEngine.test.ts`/`NewsEngine24x7.test.ts` suites (11 tests) still passing unchanged.
- `gateTradeIdea()` is preserved exactly as-is — the fix changes what's fed into `emitTradeIdea()`, never bypasses the gate itself.

Test cases from the original spec, mapped to what was actually built (`waitForFreshMarketData.test.ts`):
1. Already-fresh price → immediate return, no polling. `[TESTED]`
2. Not-subscribed symbol → rescue granted → tick arrives after polling → success. `[TESTED]`
3. Rescue granted, no tick ever arrives → explicit `TIMEOUT`, no invalid idea. `[TESTED]`
4. Only a stale tick exists → treated identically to no data, never accepted as fresh. `[TESTED]`
5. Allocator denies capacity → explicit `RESCUE_DENIED` + `deniedReason`, zero polling attempted. `[TESTED]`
6. Duplicate concurrent requests for the same symbol → deduplicated into one in-flight wait. `[TESTED]`
7. (Added beyond the original spec, found necessary during implementation) the allocator call itself throwing → typed `ERROR` result, never an unhandled rejection. `[TESTED]`

## 8. Engine reliability

`[VERIFIED]` `[RUNTIME VERIFIED]` `[DEFERRED]` A full supervisor was not built (§2 item 1) — this was a deliberate, explicit scope cut given the time available, not an oversight. What was done: `ArgusRuntime.health()` now reports `memoryRssMb`/`memoryHeapUsedMb` on every poll (confirmed live today: `493.3MB` RSS / `290.7MB` heap shortly after a clean restart), so a future engine death at least leaves a memory trend in whatever last scraped this endpoint before dying — it cannot itself diagnose a death already past, and does not address the Sept 2 root cause (still `[UNVERIFIED]`, per the forensic audit). Event-loop-lag instrumentation, a real supervisor process, and fail-closed auto-recovery all remain future work.

## 9. Agent health (Fundamental/Macro 100%-HOLD investigation — a real conclusion, not left open)

`[RUNTIME VERIFIED]` via direct query of `agent_reasoning_logs.reasoning_summary` for every Sept 2 row (not inferred — the actual stored text was read):

**FundamentalAgent (271/271 HOLD):**
| Cause | Count | % |
|---|---:|---:|
| `DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted` | 245 | 90.4% |
| `DATA_UNAVAILABLE: Fundamental data providers not configured` | 15 | 5.5% |
| `DATA_UNAVAILABLE: Fundamental analysis failed this tick` | 6 | 2.2% |
| Real LLM analysis (no directional call resulted) | 5 | 1.8% |

**Classification: DATA LIMITATION**, not a code defect. The agent's own fail-closed `DATA_UNAVAILABLE` HOLD behavior (`src/server/services/FundamentalAgent.ts:246,252,271,282,313,318`) worked exactly as designed when a real external constraint — AlphaVantage's daily request budget — was exhausted for 90% of the day. Do not lower the 2-independent-agent requirement to compensate for one agent being externally rate-limited; the correct fix (out of this session's scope) is either a larger AlphaVantage budget/tier or a secondary fundamentals provider, not a consensus-floor change.

**MacroAgent (227/227 HOLD):**
| Cause | Count | % |
|---|---:|---:|
| `DATA_UNAVAILABLE: Macro analysis failed this tick` | 103 | 45.4% |
| Real LLM analysis, reasoning field empty (`"[Macro AI] No reasoning provided."`) | 124 | 54.6% |

**Classification: MIXED — partially DATA LIMITATION, partially UNKNOWN.** 45% is a real failure-mode HOLD (transient, self-healing per-tick). The other 55% is more interesting: the LLM call **succeeded** and returned a real `HOLD` recommendation every single time, but its `reasoning` field came back empty, replaced by the generic placeholder text. Two distinct findings bundled here: (a) MacroAgent never once recommended a directional trade for this 10-symbol set on Sept 2 — plausibly correct (macro conditions may not have favored a directional call for these specific names that day) but not distinguishable from an overly conservative prompt/threshold without further investigation — **`[UNKNOWN]`, not asserted either way**; (b) the empty-reasoning-field pattern is a real, minor, separately-actionable defect (a P2 finding, not touched this session) worth its own follow-up since it silently discards whatever qualitative signal the model actually produced.

**Per the mission's own instruction: the 2-independent-agent requirement was not lowered, and no agent's threshold was adjusted to compensate for either finding.**

## 10. ChiefTrader confidence analysis (99.8% rejection rate — investigated, not adjusted)

`[RUNTIME VERIFIED]` Average/max weighted consensus score by symbol, Sept 2 (query against the real `transaction_traces` table):

| Symbol | Rounds | Avg confidence | Max confidence |
|---|---:|---:|---:|
| TSLA | 16 | 0.289 | 0.604 |
| META | 5 | 0.280 | 0.292 |
| QQQ | 314 | 0.254 | 0.773 |
| GLD | 311 | 0.250 | 0.489 |
| AAPL | 12 | 0.247 | 0.454 |
| MSFT | 8 | 0.234 | 0.355 |
| **NVDA** | 13 | **0.226** | 0.427 |
| SPY | 237 | 0.201 | 0.489 |
| AMD | 14 | 0.197 | 0.510 |
| IWM | 12 | 0.189 | 0.292 |

**Real, concrete finding: NVDA — a genuine, named +3%+ external mover that day — averaged the *second-lowest* confidence of the entire 10-symbol set, statistically indistinguishable from GLD (a gold ETF with no comparable catalyst).** Every symbol clusters tightly in a narrow 0.19–0.29 average band regardless of whether the underlying instrument was a real mover or an ordinary flat name. This is real evidence supporting the concern the mission raised: **strong external movers were not producing meaningfully higher internal confidence than ordinary candidates on Sept 2.**

`[UNKNOWN]`, honestly — this session did not go further to determine *why* (agent weighting, per-agent confidence calibration curves, or the evidence quality feeding each agent) because that requires inspecting `agent_performance_stats`/per-agent confidence-calibration tables in depth, which was out of the bounded time available. **The 0.75 threshold was not changed.** This finding is handed off as a concrete, evidence-backed lead for whatever follow-up investigates ChiefTrader calibration next — not resolved here, and not used as a pretext to lower the bar.

## 11. Safety verification (pre-open checklist, today)

`[RUNTIME VERIFIED]`, confirmed live against the restarted engine (PID 9504) before today's 09:30 ET open:

| Check | Result |
|---|---|
| `PAPER_TRADING_ONLY` | `true` (`paperTradingOnly: true` on the active broker) |
| `LIVE_NO_GO` | in force (`liveReadiness: "LIVE_NO_GO"`) |
| Broker | paper, IBKR Gateway Socket, account `DUR959160`, `CONNECTED` |
| Market data | `marketDataConnected: true` |
| Java Quant Core | `CONNECTED (HTTP 200)` |
| Database | writable (`coreBooted: true`, engine serving requests) |
| Discovery flags | `ARGUS_OPPORTUNITY_LOOP_ENABLED`/`ARGUS_BROAD_UNIVERSE_ENABLED`/`ARGUS_MARKET_MOVERS_ENABLED`/`QUANT_ENGINE_ENABLED` all `true` |
| Trading state | `TRADING_ENABLED` (resumed via `POST /api/v1/system/resume`, the same operator-parallel action this session used earlier — a real, logged, actor-attributed state transition, not a bypass of any gate) |
| Safe mode | `false` |
| Consensus threshold / independence floor | unchanged: `0.75` / `2` |

**No safety gate, threshold, or protection listed in the mission's "NON-NEGOTIABLE SAFETY" section was modified.** Confirmed by re-reading `config/tradingSafety.json`'s `consensusApprovalThreshold`/`minIndependentAgreeingAgents` values after all edits in this session (both unchanged) and by the full regression suite (§21).

## 12. September 3 live paper results

`[IN PROGRESS]`. The engine was started and verified safe roughly 1h20m before today's 09:30 ET open specifically so it would be warm, connected, and running today's fixes for the entire regular session — but as of this report being written, the regular session has not yet run its full course. **No fabricated session numbers are reported here.** What's confirmed so far:
- Engine uptime since clean restart: continuous, no unexpected deaths observed yet.
- `TRADING_ENABLED`, autobot on, paper broker connected, market data connected.
- The NewsEngine fix is live in this process (confirmed: PID 9504 is a fresh restart after all of today's code changes, not the stale PID 26752 that predated them).

A genuine count of discovery candidates/quant evaluations/ChiefTrader rounds/risk assessments/orders/fills for today's actual RTH session requires observing the session as it happens or querying the database after it has run — neither of which can be honestly done at report-writing time, ~75 minutes before the market has even opened.

## 13-20. Funnel-stage counts for today

`[IN PROGRESS]` — see §12. Populating these honestly requires the session to actually run.

## 21. Remaining bottlenecks

Carried forward from the Sept 2 forensic audit, not yet independently re-measured for today: (1) the engine-reliability gap (§8, still unsolved); (2) ChiefTrader's confidence concentration (§10, investigated but not adjusted); (3) the broad-discovery-vs-narrow-survival gap (§4, the deferred funnel redesign would address this); (4) FundamentalAgent's AlphaVantage rate-limit exhaustion (§9, a real external constraint, not an Argus code defect).

## 22. Recommended next phase

1. Observe today's actual RTH session against these fixes; update this report (or file a dated follow-up) with real counts once the session has run.
2. Fix FundamentalAgent.ts's identical price-race bug using the now-shared `waitForFreshMarketData.ts` primitive (§2 item 2) — small, precisely scoped, same pattern already proven out.
3. Design (separately, with its own dedicated time budget — not squeezed before a market open) the fail-closed process supervisor from the original spec's §3.
4. Design (separately) the universal opportunity-discovery-funnel redesign from the original spec's §6-§13 — this is the single largest piece of remaining scope and deserves its own multi-session engineering effort, not a rushed implementation.
5. Investigate ChiefTrader's confidence calibration (§10's handoff) — specifically, whether per-agent confidence-calibration curves are under-weighting genuine momentum/catalyst signals relative to routine ones.
6. Fix MacroAgent's empty-reasoning-field pattern (§9) — a small, independent P2 defect.

---

## 23. Full test results

`[TESTED]` New tests this session: 7 (`waitForFreshMarketData.test.ts`). Pre-existing NewsEngine tests re-run and confirmed unaffected: 11 (`NewsEngine.test.ts` + `NewsEngine24x7.test.ts`). `ArgusRuntime`/`v2Runtime` health-shape tests re-run and confirmed unaffected: 8. `tsc --noEmit`: clean throughout.

**Full-suite result: 442 test files, 3047 tests — 1 failure on the first run, fixed, confirmed passing on re-run (effectively 442/442, 3047/3047).**

The one failure was itself a real, instructive finding, not a code regression: `ArgusCoreBoot.test.ts`'s own new P1 regression assertion (added earlier this session, before this remediation pass) failed because **the full suite was run concurrently with the live paper engine this session had just started for today's pre-open verification** (§11) — exactly the concurrency this mission's own §22 and a separate mission's §0 both warn against. The failure diff showed only `lastHeartbeatAt` differing, with the identical real engine PID (9504) in both snapshots — proof the test itself never wrote a fake PID into the production session file (the actual property the assertion protects), and that the apparent "mismatch" was the real, currently-running engine's own legitimate periodic heartbeat write landing between the test's two snapshots. Fixed by excluding only that one expected-to-change field from the comparison (`src/server/core/ArgusCoreBoot.test.ts`), re-verified passing with the real engine still running concurrently. **Lesson applied going forward: do not run the full suite while the live paper engine is up**, consistent with the operational guidance already given elsewhere this session.

## Evidence summary

```
VERIFIED:
  NewsEngine.ts fix location and mechanism (lines 325-390); waitForFreshMarketData.ts's safety
  properties by construction; MarketDataWorker.requestTemporaryDataRescue()'s existing
  NEW_DATA_ACQUISITION/RENEWAL logic (unchanged, reused); config values unchanged for every
  non-negotiable safety threshold

TESTED:
  7 new waitForFreshMarketData.test.ts cases; 11 pre-existing NewsEngine tests unaffected;
  8 pre-existing ArgusRuntime/v2Runtime health tests unaffected

RUNTIME VERIFIED:
  Today's pre-open safety checklist against the actually-restarted engine (PID 9504); new
  memoryRssMb/memoryHeapUsedMb fields live in a real health response; the FundamentalAgent/MacroAgent
  reasoning_summary breakdown (real stored text, not inferred); the per-symbol confidence-score
  table (real query against transaction_traces)

IN PROGRESS:
  Today's actual RTH session funnel counts - the session had not yet run at report-writing time

UNKNOWN (honestly, not guessed):
  Why NVDA's confidence wasn't meaningfully higher than an ordinary symbol's; whether MacroAgent's
  100%-HOLD-when-it-did-run pattern is correct-for-the-day or reflects an overly conservative prompt

DEFERRED (explicit, agreed scope cut, not silently skipped):
  Process supervision/safe auto-recovery; the full universal discovery-funnel redesign; dynamic
  opportunity ranking; resource-aware fair allocation beyond what already exists; starvation
  measurement; a permanent Category-A missed-opportunity detector; market regime classification;
  FundamentalAgent.ts's identical price-race bug
```

---

## 25. Final decision framework

**Classification: D — RELIABILITY LIMITED, with a real, separately-scoped B/C-adjacent gap underneath.** The single most consequential unresolved issue remains the Sept 2 forensic audit's own finding: an unexplained, uncrash-logged engine death mid-session. Nothing this session did addresses that root cause — it added a small amount of memory-telemetry visibility and nothing else toward reliability. Layered on top of that: discovery is genuinely broad (not the bottleneck) but ChiefTrader survival is narrow, and this session's evidence (§10) suggests that narrowness is not fully explained by candidate quality alone — a real calibration question remains open.

**Can Argus now realistically discover strong market opportunities across the broad universe during an entire RTH session?** Partially — discovery itself was already reasonably broad before this session (confirmed independently by the Sept 2 audit and today's config check), and one real, previously-silent failure mode in that pipeline (the NewsEngine price race) is now fixed and tested. But "realistically discover... during an entire session" also requires the engine to *stay up* for the entire session, which remains unproven.

**Did today's system (as of the Sept 2 baseline, the only day with a full session's worth of evidence) miss opportunities because of discovery, data acquisition, strategy evaluation, agent evidence, consensus, risk, or reliability?** Per the forensic audit, primarily **reliability** (the engine wasn't running for roughly half the session) and **consensus calibration** (940/942 rounds rejected on confidence, with no clear evidence that strong movers scored differently from ordinary candidates) — with a secondary, now-fixed **data-acquisition** defect (the NewsEngine race) that specifically silenced one entire agent's contribution. Discovery itself, agent evidence structure, and risk/OMS were not shown to be primary contributors to the Sept 2 outcome.
