# ARGUS — Same-Day Production Readiness, Fix & Restart Audit (2026-09-16)

Follow-up to `ARGUS_LIVE_ZERO_TRADE_FORENSIC_AUDIT_2026-09-16.md` (same day), per explicit operator
mandate to investigate and fix, where safely possible, the IBKR market-data limitation, verify
calibration/consensus integrity, and investigate the memory-growth trend — with a clean production
restart afterward **only if a fix was actually deployed**. Production remained
`PAPER_TRADING_ONLY=true` / `LIVE_NO_GO` throughout. **No production restart was performed** — see
"Restart" below for why, a deliberate decision, not an omission.

## Starting state (verified live, not assumed from the prior audit)

- PID 28136 (unchanged all day), git HEAD `2d8670b` (dirty working tree, pre-existing uncommitted
  session work, unrelated to this audit).
- `tradingState: TRADING_ENABLED`, `paperTradingOnly: true`, `liveReadiness: LIVE_NO_GO`,
  `safeMode: false`.
- Broker: `ibkr_gateway`, authenticated, `marketDataConnected: true`.
- Positions: `[]`. Open orders: `[]`.
- `risk_assessments` today: 0. `trades` today: 0 (confirmed again this pass — unchanged).
- Memory at this pass's start: RSS 824.2 MB / heap 163.7 MB (see Memory section for the full trend
  captured during this audit).
- Watchdog: `READY`.

## 1–2. Funnel

Unchanged from the same-day zero-trade audit already completed (`CONSENSUS_TERMINAL_REASON`s,
`independentAgentCount` distribution, agent health, calibration numbers) — re-verified still accurate
(no new consensus/risk/trade activity contradicts it). Not re-run in full to avoid redundant load on
the live DB; see that report for the complete funnel breakdown.

## 3. IBKR market-data limitation — investigated, **no safe same-day fix implemented**

Two candidate fixes were identified and evaluated:

**(a) IBKR delayed-data fallback (`reqMarketDataType(MarketDataType.DELAYED)`).** The underlying
`@stoqey/ib` client library used by `IbkrSocketSession.ts` genuinely supports this
(`node_modules/@stoqey/ib/dist/api-next/market/market-data-type.d.ts`: `REALTIME=1, FROZEN=2,
DELAYED=3, DELAYED_FROZEN=4`), and it is not currently called anywhere in this codebase — IBKR's own
code-354 error text ("Delayed market data is available") confirms this is a real, sanctioned IB
mechanism, not something Argus would have to fabricate.

**Why not implemented today:** RiskEngine gate 13 (`data_freshness`) measures *tick arrival time*,
not the underlying quote's true data age. IBKR delayed data arrives promptly over the wire but
reflects a price that is genuinely 15–20 minutes old at the source. Wiring this in without a
corresponding change to gate 13 (a distinct `isDelayed` flag threaded from the broker through
`MarketDataWorker` into every tick, into RiskEngine, with either a much larger allowed staleness
window or an outright block on using delayed-sourced ticks for order construction) would make the
freshness gate **falsely pass** on data that is actually stale — exactly the "silently bypass
missing-data protections" and "treat delayed data as real-time without explicit safeguards" outcomes
this mandate explicitly prohibits. This is a real, properly-scoped feature (new field, new gate
semantics, new tests) — not a same-day hot patch, and implementing it hastily risked creating a new,
worse defect (paper fills evaluated against stale prices while the safety gate reports them fresh).

**(b) Cross-broker market data (Alpaca feed + IBKR execution).** `MarketDataWorker.ts` already has a
`quoteBackend: 'alpaca' | 'ibkr_gateway'` toggle, and it switches to `ibkr_gateway` specifically
*because* the active execution broker is `ibkr_gateway` (`src/brokers/BrokerManager.ts`'s boot
resolution) — this is deliberate design, not a bug: the system evaluates against the same venue that
will fill the order. Sourcing prices from Alpaca while executing on IBKR introduces a real
feed/execution-venue price mismatch risk (two different venues can print different top-of-book
prices), which is itself a form of not-quite-real evaluation. This is an architecture decision with
real trade-offs, exactly the kind of thing the operator already asked to defer to a deliberate,
separate decision rather than a same-night hot patch.

**Conclusion:** the IBKR code-354 gap is most likely a genuine **IBKR paper-account market-data
entitlement limitation** (real-time US equity Level 1 data commonly requires a linked, funded live
account with an active market-data subscription; ETFs like SPY/QQQ/GLD are unaffected, matching
exactly what was observed). This is an **account/business decision for the operator**, not a code
defect Argus can safely patch tonight. No code was changed for this item.

## 4. Calibration / consensus integrity — audited, **no defect found**

Read `ChiefTraderAgent.ts:707-742` (`calibrateConfidenceDetailed`) directly:

- When a calibration row exists for the agent/bucket, `decisionConfidence` is set to the **stored**
  `agent_confidence_calibration.calibrated_confidence` value — the output of
  `CalibrationCandidateBuilder`'s own promotion cycle (which has its own statistical-significance
  gate), never a fresh live recomputation. This is a deliberate, documented design choice (see the
  function's own 2026-09-11 header) — not a silent bypass of anything.
- When no calibration row exists (`NO_CALIBRATION_DATA`), `decisionConfidence` falls back to raw
  confidence **and is explicitly labeled as such** (`dataQuality: 'NO_CALIBRATION_DATA'`, surfaced in
  every `CONSENSUS_TERMINAL_REASON` payload) — this is the documented, intentional behavior for
  agents with insufficient evidence (e.g. today's JavaCoreEnsemble), not raw confidence silently
  substituting for calibrated confidence.
- Production's `agent_confidence_calibration` table: all 38 rows show `calibration_method =
  'RAW_BETA_BINOMIAL'` — confirms the effective-N-corrected method (`calibrationMethodComparison.ts`,
  built and tested 2026-09-15) has **not** been silently applied to production, exactly as that
  document states.
- No synthetic/seeded contamination in today's `agent_predictions` (direct query for `SYNTHETIC`/
  `seed` substrings in today's rows: 0 matches; the earlier apparent 4-row match was from other dates,
  not today).
- The 0.75 STRONG threshold, the 0.5 MODERATE trust floor, and every agent weight were **not
  touched**.

**Conclusion:** calibration and consensus are functioning exactly as designed and documented. No fix
was needed or made.

## 5. Memory investigation — no live heap snapshot taken; no new defect found

Per the explicit prohibition on anything that could freeze/destabilize the live process (the
2026-09-14 P1-B incident: a heap-snapshot capture froze the event loop for ~6 minutes and the process
was externally killed), **no heap snapshot, `--inspect`, or other invasive diagnostic was run against
the live PID 28136**. Investigation used only (a) repeated non-invasive health polls to observe the
real trend, and (b) static code review of the specific components this mandate named.

**Trend, captured live during this audit (same running process, PID 28136 throughout):**

| Uptime | RSS (MB) | Heap used (MB) |
|---|---|---|
| 16,114,526 ms (~4.48h) | 824.2 | 163.7 |
| 16,565,758 ms (~4.60h) | 1,119.6 | 419.7 |
| 17,091,992 ms (~4.75h) | 989.8 | 403.0 |
| 17,442,037 ms (~4.85h) | 996.6 | 558.4 |
| 17,566,527 ms (~4.88h) | **947.2** | **155.9** |

**RSS is not monotonic** — it rose to a peak of 1,119.6 MB then fell back into the 947–997 MB range
and stayed there. **Heap dropped by 402 MB (558.4 → 155.9) in the space of two minutes** between the
last two samples — a real, large major-GC reclaim, the clearest possible evidence against a hard
monotonic leak in this window. This is qualitatively different from the documented P1-A incident
pattern (473 MB → 3,657 MB, a sustained ~8x climb with no reclaim) and is nowhere near the
`MemoryTelemetryGuard` CRITICAL auto-pause threshold (3,584 MB RSS) — today's peak (1,119.6 MB) is
under a third of that.

**Code review of the components this mandate named:**

- `PredictionOutcomeEvaluator.ts` / `MultiHorizonOutcomeEvaluator.ts`: both use
  `createSingleFlightGuard` (no overlapping cycle executions) and bounded `.limit(batchSize)` queries
  throughout (`tradingSafety.predictionOutcomeBatchSize` / `multiHorizonOutcomeTracking.batchSize`) —
  confirmed directly in source, no regression from the documented fix.
- `ObservabilityStore.ts` (backs the 180,654 `QUANT_BRIDGE_CALL_OUTCOME` events logged today, the
  single highest-volume event type): a real bounded queue (`maxQueueSize`, `dropPolicy`, "no
  unbounded re-queue" on flush failure per its own header) — confirmed not the source.
- `QuantCoreBridge.ts`'s `pendingTickBySymbol`/`activeTickSymbols`: bounded by **symbol count**, not
  call count — cannot grow with call volume.
- `EventStore.ts`'s in-memory ring (`recentEvents`/`tradeTraces`): already ruled out by the prior
  2026-09-14 investigation (`eventStoreMaxRecentEvents: 200`, `eventStoreMaxTraces: 500` — too small
  to explain multi-hundred-MB growth), re-confirmed still true (values unchanged).
- The 2026-09-14 P1-A root cause (dominant retained shape `trace_<SYMBOL>_<epochMs>_<hash>` strings in
  a 2.04 GB incident snapshot) remains **genuinely unidentified** — that finding was never resolved,
  only the tooling to analyze a future snapshot safely offline was built. This audit did not resolve
  it either; a proper resolution needs either an offline retainer/dominator-path analysis of a real
  `.heapsnapshot` (not safely producible live) or a live, isolated reproduction harness — both
  explicitly out of scope for a same-day, no-restart-forcing investigation.

**Conclusion:** no new, distinct, fixable memory defect was found. Today's trajectory is consistent
with normal operational memory usage under heavy real event volume (180K+ observability events,
~1,500 predictions, ~2,700 reasoning/consensus rows), with healthy, working garbage collection — not
a resumption of the P1-A pattern. No code change was made. The P1-A root cause remains an open,
disclosed item for a dedicated offline investigation, not something resolved or safely resolvable
tonight.

## 6. Synthetic/live boundary — clean

Direct query of today's `agent_predictions` for `SYNTHETIC`/`seed` substrings: 0 matches. Active
broker is the real `ibkr_gateway` adapter (not `HistoricalReplayBroker`). No `SYNTHETIC_SIMULATION`
env var set in the running process (would have been caught by `syntheticSimulationDbGuard.ts` at
`db/index.ts` import time if it had ever pointed at `data/argus.db`). Production database and runtime
are real-data/paper-broker only, as required.

## 7–8. Pipeline verification / regression

`npx tsc --noEmit` (via `npm run lint`): **clean, zero errors.** Since no source file was modified
during this audit (every investigated candidate fix was judged unsafe or unnecessary — see above), a
full `npm test` re-run and rebuild were not performed; the already-clean state from earlier in this
session (517 files / 3,800 tests green, confirmed prior to this pass) remains valid and unchanged
because nothing changed. No new test failures are possible from zero diffs.

## 9. Restart — **not performed, deliberately**

The mandate's own restart step is conditioned on deploying fixes ("Only after the above checks
pass"). Sections 3–5 above concluded that no safe, defect-driven code change existed to make: the
IBKR gap is an account-entitlement limitation requiring an operator decision, not a bug; calibration
is functioning as designed; and no memory defect was found to fix. **Restarting a stable, correctly-
running live paper session with zero code changes would provide no functional benefit and would
carry pure downside risk** (reconciliation edge cases, an unnecessary interruption to a genuinely
healthy session) for nothing gained. This matches the standing operating rule ("never restart/kill the
production engine except when explicitly required") — nothing here was required. PID 28136 has run
continuously and correctly through this entire audit.

## 10. Live funnel (unchanged from the pre-audit snapshot)

Positions: `[]`. Open orders: `[]`. `risk_assessments` today: 0. `trades` today: 0. No new consensus
approvals occurred during this audit window (no source changed, no restart, so no reason to expect
one). This is the same, already-explained legitimate zero-trade state.

## 11. Readiness, reported separately

| | Status |
|---|---|
| A. Engineering readiness | Yes — full BUY→fill→exit lifecycle previously certified via the synthetic harness; RiskEngine/OMS/broker path confirmed intact and untouched today |
| B. Data readiness | **Partial** — SPY/QQQ/GLD have real, usable live data; most individual equities do not (IBKR account entitlement gap, disclosed, not fixed today) |
| C. Calibration readiness | Yes — production calibration correctly reflects real historical evidence (`RAW_BETA_BINOMIAL`, no defect found, no agent shown to have a demonstrated edge today) |
| D. Trading readiness | Yes — engine running, `TRADING_ENABLED`, `paperTradingOnly: true`, `LIVE_NO_GO`, unchanged all day |
| E. Live opportunity | **No** — no candidate today cleared 0.75 STRONG (best was ~63.5%, rejected on insufficient independence) or the MODERATE independence floor with real information |
| F. Trade outcome | None — zero orders, zero fills |

## 12. Prohibitions — confirmed honored

No threshold, independence requirement, RiskEngine gate, calibration method, or weight was changed.
No raw confidence was substituted for calibrated confidence. No synthetic signal, fake fill, or
manual trade was created. No production data was modified to manufacture a trade. No fail-closed
behavior was suppressed or disabled. Zero-trade result reported plainly, not hidden.

## 13. Today's trading result

**NO QUALIFYING OPPORTUNITY — NO TRADE.**

Same conclusion as the earlier same-day audit, now additionally verified against: (a) an examined and
rejected pair of candidate IBKR data-coverage fixes (both real, both judged unsafe for a same-day
hot-patch), (b) a direct source-level calibration/consensus integrity check (no defect), and (c) five
live memory samples showing healthy, non-monotonic GC behavior well under the documented CRITICAL
threshold (no defect requiring a fix). No code was changed; no restart was performed; production ran
continuously and correctly (PID 28136) through the entire investigation.
