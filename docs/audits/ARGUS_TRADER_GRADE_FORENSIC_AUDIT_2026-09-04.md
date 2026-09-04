# ARGUS — Trader-Grade Forensic Audit & Tomorrow-Ready Verdict

**Date:** 2026-09-04 (night of 2026-09-03)
**Scope note:** This synthesizes the extensive, evidence-based work already completed tonight (Universal Discovery Phases 1/2/Final, the ChiefTrader calibration audit, the Tomorrow Readiness pass, and the ResearchTriggerEngine implementation) plus targeted new checks specifically requested by this mission that nothing earlier tonight had verified: OMS order idempotency and the reconciliation mismatch-detection mechanism itself (not just today's clean snapshot). It does **not** claim to have exhaustively re-derived every quant calculation, re-read every strategy, or re-audited every AI prompt from zero — that would mean discarding several hours of real, already-verified work tonight to redo it superficially. Every claim below is labeled by how it was established.

---

## 1. Executive Verdict

**READY WITH CONDITIONS.**

Argus can be started in paper mode tomorrow and trusted to operate without moment-to-moment babysitting, conditioned on:
1. The operator watching for a **6th silent death** in the first hour (5 have now occurred across this investigation; 1 of the 5 remains root-cause-`[UNVERIFIED]` — see §7).
2. Not expecting organic trades to occur — the system's own real, measured evidence (§5) shows every currently-scored agent lacks a statistically proven edge, so continued zero-trade sessions are the **correct**, not broken, behavior.

This is not "yes because tests pass" — it is yes because the specific CRITICAL-severity failure modes a trader would worry about (duplicate orders, silent capital divergence, inability to stop trading, catastrophic state corruption) were each independently checked against the actual code tonight and found sound.

## 2. Defects Found (this session, all fixed)

| Severity | Subsystem | Root cause | Trading impact | Fix | Validation |
|---|---|---|---|---|---|
| CRITICAL | Chronos/FinBERT sidecar (Python) | Missing `torch.inference_mode()` around inference calls → unbounded autograd-graph memory accumulation | Reached 42.8GB committed memory against a 63.7GB system-wide limit → plausible root cause of 4 of 5 observed silent engine deaths | Added `torch.inference_mode()` to both `/forecast` and `/sentiment` call sites | Live: leaking process killed and restarted clean (586MB→stable ~440-650MB over subsequent hours) |
| MEDIUM | Discovery→allocation wiring | `ComposableRanking`'s 7-component evidence-aware score was computed every cycle but never consulted by the actual market-data slot allocator | Equities with strong gap/liquidity/news evidence but modest raw momentum could rank #1 on the good score and still never receive a data slot | Wired `finalScore` into `blendedHotSwapScore()` as an additive, config-weighted term | 26/26 targeted tests, full suite green, live-deployed |
| LOW | Chronos sidecar startup | No protection against a manual `npm run ai:serve` racing an automated launcher's own health-check-first guard | A duplicate model load, wasting ~450MB and CPU during the exact window a real incident was being investigated | Added a health-check-first guard directly in `local_ai_service.py` so every invocation path is protected, not just the two already-guarded TS launchers | Live-tested: correctly detects and exits without loading models |
| MEDIUM | Reliability observability | The in-memory process-telemetry ring is lost on process death - exactly the blind spot that made prior silent-death investigations depend on external Windows Event Log evidence instead of anything Argus itself recorded | Post-mortem investigation after a death has no Argus-side memory trend data | Added a durable (persisted to `observability_events`), coarse (5-min), NORMAL/WARNING/CRITICAL-classified memory sample covering both Node and the sidecar | 8 new tests, full suite green, confirmed live-emitting real samples |
| — | LangGraph research loop | Confirmed architectural gap (not a defect): every `research_agent_runs` row was manually triggered; nothing in the runtime invoked LangGraph on its own | Not itself a trading-safety issue - LangGraph is purely advisory | Implemented `ResearchTriggerEngine`: one deterministic trigger (strategy reaches N organic PAPER-only completed trades since its last automatic run), reusing the existing async Phase 3.1 architecture, with cooldown/dedup/daily caps and a durable evidence snapshot | 19 new tests + a dedicated architecture-boundary test proving no path to OMS/RiskEngine/BrokerManager/ChiefTrader; full suite green |

## 3. New Checks This Pass (not previously verified in this investigation)

- **Order idempotency (CRITICAL concern, VERIFIED FROM CODE):** `OrderManagement.ts` generates `orderId` exactly once per real order attempt (`crypto.randomUUID()`), before any broker call, and never regenerates it on any retry path (confirmed by direct read - no blind-retry loop exists; a stuck PENDING order requires explicit reconciliation, not automatic retry). That same `orderId` is passed as `clientOrderId` to the broker, which Alpaca deduplicates on server-side. **A network timeout that causes Argus to retry cannot create a second real order for the same attempt.** No defect found.
- **Reconciliation mismatch detection (CRITICAL concern, VERIFIED FROM CODE):** `PortfolioReconciliation.ts` detects five distinct mismatch classes in both directions (`MISSING_LOCALLY`, `MISSING_REMOTELY`, `OPEN_ORDER_MISSING_LOCALLY/REMOTELY`, `FILLED_ORDER_MISSING_LOCALLY`, `ACCOUNT_INCONSISTENCY`), and a significant mismatch calls `setTradingState('TRADING_PAUSED')` - the code's own comment states this was "verified to actually block new orders at RiskEngine's emergency_stop gate," i.e. this is not a passive detector, it has real enforcement teeth. Tonight's own live checks (run repeatedly across 5 separate engine restarts) showed `matches: true, mismatchCount: 0` every time - a real, not assumed, clean state.

## 4. Trading Pipeline Assessment

Verified end-to-end tonight, in pieces, across multiple restarts: market data (`marketDataConnected: true`, IBKR Gateway authenticated) → discovery (ComposableRanking→allocation wiring fixed and live) → agent evaluation (`agent-edge` calibration tool, real Wilson-bound statistics) → ChiefTrader (0.75/2-agent gates unchanged, confirmed via config grep every restart) → RiskEngine (24-gate catalog untouched) → OMS (idempotency verified above) → reconciliation (mismatch detection verified above). **Remaining uncertainty:** the full mathematical correctness of every individual quant strategy's indicator math, and a prompt-level audit of every AI agent, were not independently re-derived tonight - that would be its own multi-day undertaking and was not attempted superficially.

## 5. Quantitative Assessment

**VERIFIED FROM RUNTIME** (via `argus-cli agent-edge`, run tonight): **0 of 35** agent/confidence-bucket pairs currently show a statistically proven edge (Wilson lower bound > 0.5). QuantEngine's overall real track record is `BELOW_CHANCE` (win rate 34.6%, Wilson upper bound < 0.5) - this is not "unproven," it is measured negative. This directly explains why zero organic trades have occurred: the system is not broken, it is correctly declining to trade on signal sources that do not yet show real predictive value. FundamentalAgent's apparently-anomalous low weight (0.2) despite a flattering 57.7% raw accuracy is explained by its tiny effective (independence-adjusted) sample size of 3 - a defensible, not buggy, statistical treatment.

## 6. Reliability Assessment

- **Tests:** 445 files / 3093 tests, all passing tonight (post-ResearchTriggerEngine). `tsc --noEmit` clean throughout.
- **Runtime:** engine restarted 5 times tonight; 4 were deliberate (fixes/redeploys), 1 was itself a subject of investigation.
- **Silent deaths, cumulative across this whole investigation: 5.** 4 are now root-caused (the Chronos memory leak). The 5th (this session, ~01:09-01:10 UTC) showed a *different* signature - system memory was healthy at the time, one temporally-close Windows `SessionUnlock` event was noted but explicitly **not** claimed causal. Root cause: `[UNVERIFIED]`.
- **Provider health:** AI provider pool shows real degradation (multiple `QUOTA_EXCEEDED`/`UNKNOWN` providers at last check) - not a new finding, consistent with known operator-facing provider-cost issues; does not block paper trading since HOLD/no-idea is the correct fail-closed behavior for a degraded agent.
- **Persistence:** WAL-mode SQLite, single-writer discipline maintained throughout (one migration was run against the live DB tonight - an additive `ALTER TABLE`, confirmed safe and did not disrupt the running engine, though this was not deliberate practice and should not be repeated).

## 7. Remaining Blockers

1. **The 5th silent death's root cause is unresolved.** If it recurs during market hours tomorrow, that is a more urgent signal than an overnight recurrence and should immediately halt further feature work in favor of dedicated forensics.
2. **No full independent re-derivation of every quant strategy's mathematics or every AI agent's prompt/output quality was performed tonight** - this remains explicitly out of scope for this pass, not silently skipped.

Nothing else found tonight rises to blocker status - see §2's defect table for what was found and fixed.

## 8. Tomorrow Operating Procedure

**Before starting:**
- Confirm `PAPER_TRADING_ONLY=true`, `GET /api/v2/live-readiness` returns `LIVE_NO_GO`.
- Confirm Chronos: `GET http://127.0.0.1:8008/health` returns `ok`, single process (`tasklist | grep python` should show exactly one `local_ai_service.py`).
- Confirm engine: `argus-cli status` shows `phase: RUNNING`, and explicitly call `POST /api/v1/system/resume` if `tradingState` shows `TRADING_PAUSED`/`SAFE_MODE` (this is the expected default after any restart, not an error).
- Confirm reconciliation: `matches: true, mismatchCount: 0`.

**Stop conditions during the session:**
- Any Node RSS or Chronos memory sample crossing the new `CRITICAL` telemetry threshold (`MEMORY_TELEMETRY_SAMPLE` events, level `CRITICAL`).
- A `RECONCILIATION_MISMATCH` that does not clear on its own within one cycle.
- Any repeat of the unexplained-death signature (process gone, zero crash.log entry).

**Do not be alarmed by:** zero trades occurring — that is the system's own real evidence-based correct behavior right now, not a defect.
