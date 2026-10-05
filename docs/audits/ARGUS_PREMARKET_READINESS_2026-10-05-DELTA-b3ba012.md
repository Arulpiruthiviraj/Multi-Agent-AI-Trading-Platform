# ARGUS Pre-Market Readiness — Delta Certification (b3ba012)

**Audit date:** Sunday 2026-10-04 (market closed)
**Baseline report:** `ARGUS_PREMARKET_READINESS_2026-10-05.md` at tip `40581f0`
**New certified tip:** `b3ba012` — "fix(quant): degenerate-input hardening and opening-range session anchoring", branch `main`
**Session stance:** PAPER TRADING ONLY · LIVE_NO_GO

**Scope of this document.** This is a DELTA assessment only. It does not re-run the full 33-section audit. It reviews the diff `40581f0..b3ba012` (two commits, 30 files, +709/−50), verifies each change is coherent and safety-strengthening, and determines whether the baseline report's verdicts, 25 safety answers, or edge-evidence conclusions change. All code below was read, not merely listed.

**Hard rules carried over.** PAPER TRADING ONLY, LIVE_NO_GO. This report does not claim Argus "will make money tomorrow"; no audit can prove that. Java remains UNVERIFIED_ON_THIS_HOST (no JDK). NO TRADE is a valid, successful outcome.

---

## COMMITS REVIEWED

### b73de00 — "fix(p2): backlog defect remediation"

**1. PortfolioMonitor per-holding exception isolation** (`src/server/services/PortfolioMonitor.ts`, +14)
- The holdings loop previously ran under one outer try/catch: a single holding's failure (e.g. `resolveOpeningTradeForLiveExit()` throwing on a corrupt row) skipped stop/target review for every holding after it that cycle.
- Each holding now gets its own try/catch. The failure is logged via `console.error`, a WARNING portfolio decision is recorded for that symbol via `recordPortfolioDecision`, and the loop continues. The outer catch remains as the backstop for failures outside the loop (e.g. the initial holdings query).
- **Safety impact:** strictly safer. Stop-loss/take-profit review coverage can only increase, never decrease. No exit logic, consensus math, or risk gate was touched.

**2. IBKR Web API request timeout** (`src/brokers/InteractiveBrokersWebApiAdapter.ts` +23, `config/ibkrConnection.json` +2, `src/server/config/ibkrConnection.ts` +7)
- `https.request()` previously had NO timeout: a Gateway that accepted the connection but never responded hung the promise forever — including `placeOrder`.
- New `webApiRequestTimeoutMs` (30s, config-loaded from `config/ibkrConnection.json` with a 30s code fallback for missing/invalid values).
- Timeout rejects as `BROKER_TIMEOUT` with outcome UNKNOWN — message explicitly states "reconcile by clientOrderId, do not assume the order was not placed." Never auto-retried.
- A `settled` guard plus fail-before-destroy ordering guarantees the late socket error from `req.destroy()` cannot overwrite the timeout rejection (verified: `req.destroy()` emits `'error'` synchronously, so claiming settlement first is load-bearing, not cosmetic).
- **Safety chain verified:** when `placeOrder` throws without a `brokerOrderId` (exactly the BROKER_TIMEOUT shape), OMS's existing handler (`OrderManagement.ts:688-715`) sets status PENDING with `submitOutcome=UNKNOWN`, pauses trading via `pauseTradingForOrphan`, and defers to `reconcileStaleOrders`. The new timeout flows through this proven path unchanged — no OMS code was modified.
- **Safety impact:** strictly safer. Eliminates the infinite-hang failure mode; the timeout can only produce the same UNKNOWN outcome OMS already handles.

**3. Broker buying-power TOCTOU** (`src/server/engines/buyingPowerReservations.ts` NEW, `src/server/engines/RiskEngine.ts` +11)
- Risk evaluations are serialized by the `evaluationQueue` mutex, but broker order placement sits outside it: two approved BUYs could each observe the same unchanged broker buying-power snapshot before either filled. The settings-budget side of this race was already closed (gate 23 `argus_capital_allocation` with DB-backed `pendingBuys` + `PendingCapitalReservations`).
- New `getReservedBuyNotional()`: durable, DB-derived reservation = `SUM(quantity × price)` over non-terminal BUY orders, excluding REPLAY/HISTORICAL_REPLAY environments (research orders must never reserve live buying power), NULL environment counted as live (matches gate 23's own JS-side filter semantics). Uses the same non-terminal definition as gate 23's `pendingBuys` filter.
- Subtracted from the fresh broker buying-power snapshot before sizing and gates: `buyingPower = Math.max(0, snapshot − reserved)`. Recorded as a `buying_power_reservation` gate event when > 0.
- Unknown/reconciliation-required orders keep their reservation (fail-closed), matching the OKTA-fix philosophy. DB read errors return 0 (same as today's behavior — the underlying snapshot is still the real broker value; failing closed to zero buying power on a transient DB error would block all trading).
- **Safety impact:** strictly more conservative. The reservation can only ever REDUCE the buying power RiskEngine sees, never increase it. Over-reservation edge cases (stale snapshot already reflecting a fill, partial-fill remainder) err toward rejecting a valid order, never toward approving an invalid one. No gate logic, threshold, or consensus math changed.

### b3ba012 — "fix(quant): degenerate-input hardening and opening-range session anchoring"

**4. Twelve strategy null-guards** (11 strategy files)
- A 422-case suite (`degenerateInputs.test.ts`) feeds null/NaN/missing ATR, DMI, MACD, VWAP, moving averages, RSI, Keltner, opening range, prior channel, previous-day levels, relative strength, and SMC context to all 21 strategies. Baseline established first: zero strategies actionable on the neutral fixture, so any actionable result under mutation is a real fail-open defect.
- Twelve failures were REAL (all TypeErrors): `smcLiquiditySweep` on empty `{}` (shape-validated against `emptySmc()`), `trendFollowing`/`oscillatorMomentum` on null MACD, five VWAP consumers (`momentumBreakout`, `vwapVolumeStructure`, `openingRangeBreakout`, `vwapMeanReversion`, `gapContinuation`) on null VWAP, four strategies (`pullbackContinuation`, `trendFollowing`, `maCrossover`, `relativeStrengthRotation`) on null movingAverages.
- Each fixed with a null-guard that fails the dependent condition closed. A missing input never becomes a directional signal; `triggerMet` is explicitly false when its defining input is absent.
- **Safety impact:** strictly safer. Previously these threw, which (per #5) aborted evaluation for ALL strategies on that symbol that cycle.

**5. `StrategyEngine.evaluateAll()` per-strategy isolation** (`src/server/quant/strategies/StrategyEngine.ts`, +27)
- Defense-in-depth backstop: each strategy's `evaluate()` runs in its own try/catch. A throwing strategy fails closed (`triggerMet=false`, confidence 0, error stated openly in `conditionsFailed`, null stop/target with honest basis) instead of aborting every other strategy's evaluation. The fail-closed evaluation then passes through the existing `applyTriggerGate`.
- **Safety impact:** strictly safer. Cannot produce an actionable idea (confidence 0 < 0.6 trade bar, `triggerMet=false`).

**6. Opening-range session anchoring** (`src/server/quant/indicators/supportResistance.ts`, `src/server/replay/marketSession.ts` +22, callers)
- `openingRange()` anchored its window at the first bar of the UTC day — wrong when premarket bars are included (a 4:00 AM bar is not the opening range). New optional `regularSessionStartMs` parameter; when supplied, bars before it are excluded.
- New `regularSessionOpenMs(dayMs, timeZone)`: computes the real regular-session open (`replaySafety.regularSessionStartMinutes` = 570) in any IANA timezone, DST-correct via the Intl database (iterative wall-time→UTC resolution, same pattern as `tradingWallTimeToIso`), no hardcoded EST/EDT offset.
- `CampaignOpeningSurge` (1Min bars include premarket) and `QuantSignalAgent` (via `computeIntradayFetchWindow`, which already computed the session open internally — now exposed) supply it. `computeSupportResistanceFeatures` threads it through as an optional third parameter.
- **Behavior-change scope:** ONLY when the new optional parameter is supplied. Omitted (all other callers: BacktestEngine, replay, parity harness), behavior is byte-for-byte unchanged. Where supplied, the opening range becomes MORE correct (real 9:30 ET open), which can only improve OPENING_RANGE_BREAKOUT input accuracy — it remains behind the same experimental flag.

**7. Documentation** (`docs/architecture/ARGUS_ARCHITECTURE.md` +60, `src/components/DocumentationTab.tsx`)
- New dated architecture section "2026-10-04 (evening)" covering all six changes, written in the same change per the repo's living-doc contract.
- In-app DocumentationTab quant section extended with the fail-closed degenerate-input behavior.
- README/CLAUDE reviewed: no setup steps, CLI commands, or operator contracts changed — no updates required.

---

## NEW TESTS (all present, coherent)

| File | Coverage |
|------|----------|
| `src/server/quant/strategies/degenerateInputs.test.ts` | 422 cases: baseline (0 actionable on neutral fixture) + 20 degenerate mutations × 21 strategies (never throws, never actionable) + `evaluateAll` isolation test (injected throwing strategy fails closed, others unaffected, can never become best idea) |
| `src/brokers/InteractiveBrokersWebApiAdapter.timeout.test.ts` | 3 cases: silent gateway → BROKER_TIMEOUT/UNKNOWN with reconcile instruction; late socket error cannot overwrite timeout rejection (settled-guard); responding gateway resolves normally |
| `src/server/engines/buyingPowerReservations.test.ts` | 6 cases: empty → 0; non-terminal BUY notional reserved; FILLED/REJECTED/CANCELED release; SELLs ignored; REPLAY/HISTORICAL_REPLAY ignored; UNKNOWN/RECONCILIATION_REQUIRED keep reservation (fail-closed) |
| `src/server/replay/marketSession.test.ts` | 3 cases: 9:30 AM ET on EDT date (13:30 UTC), on EST date (14:30 UTC), same 09:30 wall-clock across the DST fall-back boundary |
| `src/server/services/PortfolioMonitor.isolation.test.ts` | 1 case: throwing first holding does not prevent review of later holdings (POSITION_MONITORED still emitted) |
| `src/server/quant/indicators/supportResistance.test.ts` | +2 cases: anchored range excludes premarket bars; unavailable when no bars at/after session start |

Note: the 30s adapter timeout is mocked to 120ms in tests via `vi.mock` of the config loader — the production default remains 30s.

---

## IMPACT ON THE 25 SAFETY ANSWERS (baseline §32)

Reviewed each answer against the delta. **No answer changes.** Key confirmations:

- **Q1 (P0 defects):** No. The delta fixes P2 defects; it introduces no P0. The three backlog items were verified REAL at `40581f0` by read-only inspection before fixing.
- **Q2 (P1 capable of changing orders/positions/prices/P&L):** No. The buying-power reservation CAN reduce order sizing, but only in the conservative direction — it closes the TOCTOU P1 rather than creating one. The opening-range anchor changes OPENING_RANGE_BREAKOUT inputs only where intraday bars exist, toward greater correctness, behind the existing experimental flag.
- **Q5 (kill-switch race):** No change — untouched.
- **Q9/Q10 (reconciliation):** Unchanged — still NO, still hard gates for Monday.
- **Q13 (budget):** Unchanged — still MISMATCH, still a hard gate.
- **Q16/Q17 (consensus / NO TRADE):** Unchanged, with Q17 marginally strengthened: degenerate inputs now fail closed to non-actionable evaluations, so weak/absent evidence is even less likely to reach consensus.
- **Q18 (RiskEngine tests):** The reservation is additive and conservative; no gate logic or threshold changed. The 101/101 + 19/19 baseline is not invalidated by inspection, but the full RiskEngine suite was not re-run in this delta review (see LIMITATIONS).
- **Q19 (OMS tests):** No OMS code changed; the timeout flows through the existing SUBMIT_UNKNOWN path.
- **Q24 (supervised PAPER safe tomorrow):** Conditional YES stands — same pre-market checklist gates.
- **Q25 (sign the certificate):** Still NO — the code is signed; the session cannot be signed until Monday's checklist gates (Q9, Q10, Q13, Q14, Q15, Q20) pass. Unchanged.

---

## VERDICTS

**Readiness: READY_WITH_CONDITIONS — STANDS (strengthened, not weakened).**
Every change in the delta is strictly safety-strengthening: broader review coverage (PortfolioMonitor), elimination of an infinite-hang mode (IBKR timeout), tighter capital accounting (buying-power reservation), and fail-closed degenerate handling (12 null-guards + evaluateAll isolation). No approval threshold, consensus weight, risk gate, OMS behavior, or kill-switch logic was altered. The Monday pre-market checklist gates are unchanged and still mandatory.

**Edge evidence: WEAK — STANDS.**
The delta contains no new strategies, no new backtests, no new OOS evidence, and no change to any research methodology. The opening-range anchoring improves input correctness for one experimental strategy but is not edge evidence.

**Expected value: INSUFFICIENT_EVIDENCE — STANDS.**
No corrected OOS expectancy is computable; unchanged from baseline.

---

## NEW CONCERNS INTRODUCED (evidence-based)

1. **Reservation over-conservatism (by design, low risk).** `getReservedBuyNotional` may over-reserve when the broker snapshot already reflects a fill that the DB hasn't marked terminal yet, or on partial fills. This errs toward rejecting valid BUYs (missed opportunity), never toward approving invalid ones (capital breach). Documented in the module. Not a safety regression.

2. **Reservation read-failure mode (deliberate, documented).** On DB read error the function returns 0 — i.e., today's behavior. The alternative (fail to zero buying power) would halt all trading on a transient DB fault. This is a reasoned trade-off, stated in code, not an oversight.

3. **Java parity gap for the null-guards.** The 12 strategy fixes are TS-only. Per the repo's Java Engine Authority (AGENTS.md rule 13) these are bug fixes to existing TS calculations, recorded as migration candidates. If any of the five Java CORE strategies (RangeReversion/PullbackContinuation/MeanReversion/TrendFollowing/MomentumBreakout) share the same null-deref patterns, those remain unfixed in Java — and Java is UNVERIFIED_ON_THIS_HOST regardless. The TS live path (the one that trades) is fixed and tested.

4. **Pre-existing test failures unrelated to this delta.** The baseline report documents 7 tier-1 failures at `40581f0` (BrokerManager recovery/boot-auth, strategySelectionReplay fixtures, BrokerManager alpaca-switch, urlSafety/webhooks DNS sinkhole artifacts, 2 timeout flakes). This delta was not verified against a full-suite re-run; none of the delta's files overlap those failing suites' code paths except `PortfolioMonitor.test.ts` (the new isolation test was moved to its own file `PortfolioMonitor.isolation.test.ts` after hitting the file's known shared-DB-connection teardown issue — passes standalone).

---

## LIMITATIONS OF THIS DELTA REVIEW

- Read-only: no code was modified, no tests were executed. Test files were verified present and their assertions read for coherence; the parent agent's session reports them passing (degenerate 422/422, timeout 3/3, reservation 6/6, session 3/3, isolation 1/1 at commit time).
- The full tier-1 suite was not re-run at `b3ba012`. The baseline's 7 failures are carried over as still-open P2 test/fixture debt.
- `sim:market-open --certify` remains NOT RUN (same as baseline).
- Deployment-environment assertions (`PAPER_TRADING_ONLY=true`, OKTA −14 broker truth, fresh-tick feed evidence) remain Monday pre-market gates, unchanged.

---

## FINAL NOTE

Profit tomorrow is not guaranteed, and no audit can prove it. This delta certifies that the `40581f0..b3ba012` changes are coherent, strictly safety-strengthening, and introduce no new execution-critical defects — the engineering-readiness verdict stands, and is marginally stronger for the closed TOCTOU, the eliminated hang mode, and the fail-closed degenerate handling. Edge evidence remains WEAK and expected value INSUFFICIENT_EVIDENCE; a healthy Argus tomorrow may correctly make zero trades, and that is a successful outcome.
