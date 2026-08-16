# ARGUS_SAFETY_HARDENING_REPORT.md

**Phase 1 (P0 Safety Blockers) — complete.** Scope: `ARGUS_PRE_IMPLEMENTATION_BASELINE.md`'s Phase 1
row. All four P0 items from the current audit (`FINAL_ANALYSIS.md` Section 30) closed, each with
real, tested code, following the "extend, don't replace" discipline — no existing engine was
rewritten; every fix routes through an already-existing, already-correct mechanism
(`TradingEngine.setTradingState()`, `RiskEngine`'s existing gate ladder, `PositionSizing`'s existing
idempotency conventions).

## 1. Portfolio reconciliation now actually blocks trading

**Before**: `PortfolioReconciliation.ts` set `tradingEngine.state.emergencyStopActive = true`
directly on a significant mismatch. `RiskEngine`'s real `emergency_stop` gate reads
`tradingEngine.state.tradingState`, never that boolean — so a real position drift never actually
blocked a single new order, despite the code's own comments and log line claiming it did.

**After**: `PortfolioReconciliation.ts` now calls `await tradingEngine.setTradingState('TRADING_PAUSED', {reason, actor: 'system:PortfolioReconciliation'})`
— the one real path that changes `tradingState`, persists it to `settings` (survives a restart),
and appends an audited `kill_switch_events` row. `TRADING_PAUSED` (not `EMERGENCY_STOP`) is used
deliberately: it blocks new orders without also cancelling every real open order, matching "existing
positions remain observable."

**Proof, not assertion**: `PortfolioReconciliation.tradingBlock.test.ts` — a real integration test
(temp SQLite DB, real `BrokerManager`/`RiskEngine`/`TradingEngine`, no mocks) that seeds a real
broker-side position mismatch, runs `reconcile()`, and then calls `RiskEngine.evaluateRisk()` with a
brand-new, unrelated proposal — asserting it is rejected specifically at the `emergency_stop` gate.
This is the exact chain the task specified: **BROKER MISMATCH → RECONCILIATION → TRADING BLOCKED →
RISK ENGINE REJECTS NEW ORDER.**

## 2. Broker (Alpaca) request timeouts, retry, and a real circuit breaker

**Before**: `AlpacaBroker.fetchAlpaca()` used a bare `fetch()` — no timeout, no retry, no 429
handling. A hung call blocked the caller (ultimately `OrderManagement.executeOrder()`) indefinitely.

**After** (`AlpacaBroker.ts`):
- Every request now has a real 15s timeout via `AbortController`.
- **Idempotency-safe retry only**: GET/DELETE calls are always safe to retry (2 additional attempts,
  exponential backoff 500ms/1500ms). `POST /v2/orders` is retried **only** when the caller supplies
  a real idempotency key — see item 3 below. A definite HTTP error response (4xx/5xx) is never
  retried, since Alpaca already gave a real answer.
- Real 429 handling, honoring `Retry-After` when present.
- A real circuit breaker: 3 consecutive failures opens the circuit for 30s, failing fast (no network
  call at all) rather than continuing to hammer a known-down API.
- All failures are typed (`AlpacaRequestError` with `.kind`: `TIMEOUT | NETWORK | RATE_LIMITED |
  HTTP_ERROR | CIRCUIT_OPEN`) so callers can branch on real failure classification instead of
  string-matching an error message.

**Tests**: `AlpacaBroker.reliability.test.ts` (8 tests, fake-timer-driven) — timeout classification,
network-error retry-and-recover, 4xx never retried, 429+Retry-After retried, circuit breaker opening
and fast-failing, and a real success resetting the failure count.

## 3. Order submission is now safely retryable (and order crash recovery exists)

**Before**: no way to distinguish "order never reached Alpaca" from "Alpaca received it but the
response was lost," and *"NEVER blindly retry an order submission"* meant order POSTs simply
couldn't use the retry machinery above at all, leaving them exposed to hangs with zero recovery
path. A local row could be wrongly marked `REJECTED` (because the HTTP call threw) while Alpaca had
actually accepted or even filled the order — and nothing ever revisited it.

**After**:
- `Order.clientOrderId` (additive field, `BrokerAdapter.ts`) is set to the local `trades.id` UUID
  by `OrderManagement.executeOrder()` and passed through to Alpaca as the real `client_order_id`
  field — which **Alpaca itself deduplicates on**. This makes retrying a timed-out order submission
  provably safe: even if the first attempt actually reached Alpaca, a retry with the same key can
  never create a second real order.
- `AlpacaBroker.getOrderByClientOrderId()` (new) queries Alpaca directly by that key — a real,
  authoritative answer to "did the broker actually receive this order?"
- `OrderManagementService.reconcileStaleOrders()` (new) — runs once on `start()` (real startup
  recovery) and every 5 minutes thereafter. Finds local `trades` rows with no recorded
  `brokerOrderId` that are `PENDING` or `REJECTED`, looks each up by client order id, and corrects
  local state to match the broker's real answer: a genuinely-never-received order is honestly
  confirmed `REJECTED`; a wrongly-`REJECTED`-but-actually-filled order is corrected to `FILLED` with
  a real fill row recorded through the same `recordFillProgress()` path a normal live fill uses.
  Previously-unused `TransactionStatus.RECONCILED` is now actually set on the affected transaction.

**Tests**: `OrderManagement.crashRecovery.test.ts` (5 tests) — the exact dangerous scenario
("locally REJECTED, broker actually filled it → corrected to FILLED, real fill row exists"), the
"genuinely never reached broker → honestly REJECTED" case, a still-open-but-partially-filled case,
proof that already-tracked orders (real `brokerOrderId`) are left to the existing
`followUpOpenOrders()` job (no double-handling), and honest no-op degradation when the active
broker doesn't support the lookup.

## 4. AI provider call timeouts

**Before**: zero timeout anywhere in `AIRouter.ts` or any provider file — a hung call blocked the
calling agent's tick indefinitely.

**After**: `AIRouter.ts`'s two real call sites (`routeTask()`'s sequential failover loop,
`routeConsensus()`'s parallel `Promise.all`) both wrap `provider.chat()` in a 20s `Promise.race`
timeout. A timeout is handled by the **exact same per-provider try/catch every other real failure
already goes through** — `routeTask()` fails over to the next provider; `routeConsensus()` records
`status:"error"` for that provider and still aggregates whatever real successes exist. A hung
provider can never silently become a fabricated BUY/SELL, and never blocks the whole consensus call.

**Honest limitation, not fixed this pass**: this is a router-level "soft" timeout (`Promise.race`),
not true request cancellation — the underlying HTTP request to the AI provider is not aborted
(unlike `AlpacaBroker`'s `AbortController`-based timeout), because that would require every
individual provider file to accept and honor an abort signal, a larger change. The caller is
guaranteed to never block past the timeout; the abandoned in-flight request itself is not yet
cancelled. Documented here rather than silently left unstated. (`AI_PROVIDER_TIMEOUT_MS = 20_000`,
module-level constant in `AIRouter.ts`.)

**Tests**: `AIRouter.test.ts` (new file — this file did not exist before this session, closing a
real, previously-total coverage gap identified by the audit) — 4 tests: a single hung provider
eventually fails rather than hanging forever, failover to a healthy second provider after the first
times out, `routeConsensus()` treating a timeout exactly like any other failure (never a fabricated
verdict), and `routeConsensus()` still aggregating a real success alongside a timed-out failure.

## 5. Reconciliation expanded beyond positions

**Before**: only broker *positions* were reconciled. Cash/buying power, open orders, and filled
orders vs. the internal `trades` table were entirely unchecked.

**After** (`PortfolioReconciliation.ts`):
- **Open orders**: the broker's real non-terminal orders are compared against local non-terminal
  `trades` rows (matched by `brokerOrderId`). An order on either side with no counterpart on the
  other is a real, newly-visible drift (`OPEN_ORDER_MISSING_LOCALLY` / `OPEN_ORDER_MISSING_REMOTELY`).
- **Account consistency**: since Argus does not maintain a second, independent cash ledger (building
  one would be a much larger, out-of-scope change), this checks that the broker's *own* reported
  numbers are internally consistent — `equity ≈ cash + Σ(position market value)`, tolerance
  `max($50, 1% of equity)` — and that cash/buyingPower/equity are all finite. A violation
  (`ACCOUNT_INCONSISTENCY`) is a real signal of a broken/partial broker response, not a fabricated
  comparison against data Argus doesn't have.
- Both new mismatch types feed the **same** `worstImpact`/`SIGNIFICANT_MISMATCH_DOLLARS` →
  `setTradingState('TRADING_PAUSED')` path as position mismatches — fixed in item 1 above, so this
  extension inherits the real enforcement, not just detection.

**Explicitly NOT done this pass** (documented per the audit's own "third of four reconciliation
targets" finding, not silently left unstated): filled orders vs. the internal `trades` table are
still not separately reconciled — open-order reconciliation and the crash-recovery job in item 3
together cover most of the same real risk (an order Alpaca filled that Argus doesn't know about),
but a dedicated fills-history cross-check was judged lower-priority than the four items above and is
carried forward as a P2 item.

**Tests**: `PortfolioReconciliation.openOrdersAndCash.test.ts` (5 tests) — a real phantom broker
order flagged, a real "ghost" local order flagged, a non-finite broker response flagged AND
verified to actually pause trading (not just detected), an equity/cash drift beyond tolerance
flagged with the correct dollar impact, and a consistent response producing no false positive.

## Files changed

`src/server/services/PortfolioReconciliation.ts`, `src/brokers/AlpacaBroker.ts`,
`src/brokers/BrokerAdapter.ts` (additive `clientOrderId`/`getOrderByClientOrderId` on the shared
interface), `src/server/services/OrderManagement.ts`, `src/server/ai/AIRouter.ts`. New test files:
`PortfolioReconciliation.tradingBlock.test.ts`, `AlpacaBroker.reliability.test.ts`,
`OrderManagement.crashRecovery.test.ts`, `PortfolioReconciliation.openOrdersAndCash.test.ts`,
`AIRouter.test.ts`. One existing test assertion updated (`OrderManagement.test.ts`, to match the new
`clientOrderId` field now always present in the `placeOrder()` payload — a real, intentional
behavior addition, not a broken test).

## Files explicitly NOT touched

Per `ARGUS_PRE_IMPLEMENTATION_BASELINE.md`'s own list: `RiskEngine.ts`'s gate ladder and gate order
(extended in effect — `emergency_stop` now actually enforces the reconciliation pause, but the gate
itself, its order, and every threshold are unchanged), `ChiefTraderAgent.ts`'s consensus math,
`quant/strategies/*.ts`, `Commissions.ts`/`Slippage.ts`/`ReplayClock.ts`, the frontend.

## Verification

- `npx tsc --noEmit`: clean.
- `npx vitest run`: **99 test files / 690 tests passing**, run twice consecutively (up from the
  Phase 0 baseline's 94/667 — 5 new test files, 23 new tests, zero regressions).
- `npm run build`: clean (Vite SPA + esbuild server bundle, only the pre-existing >500kB
  chunk-size advisory).

## Before / After

| Gate (from `FINAL_ANALYSIS.md` §30.27) | Before Phase 1 | After Phase 1 |
|---|---|---|
| GATE 1 — Broker Safety | FAIL (no timeout/retry/crash-recovery) | **Materially improved** — real timeout, retry, circuit breaker, and order-level crash recovery now exist and are tested. Not yet a full PASS: retry/backoff is Alpaca-specific (other broker adapters unchanged, out of this pass's scope), and true AI-request cancellation is still soft (item 4's documented limitation). |
| GATE 2 — Position Reconciliation | FAIL (pause claim didn't reach the gate; only positions checked) | **Real fix** — the pause claim now provably reaches `RiskEngine`'s gate (integration-tested), and reconciliation now also covers open orders and account consistency. Fills-vs-`trades` cross-check remains a documented P2 gap. |
| GATE 9 — AI Reliability | FAIL (no timeout anywhere) | **Partially improved** — a real caller-side timeout now exists and is tested; hallucination protection, reproducibility control, and historical AI backtesting (the other three real gaps this gate covers) are unchanged by this phase and remain open for Phase 7/9. |

**This phase does not change the standing trading-edge verdict.** Nothing here makes any strategy
more profitable or statistically validated — it makes the safety-critical path more honest about
its own real failure modes, and closes the single most dangerous documented gap (reconciliation not
actually enforcing its own claimed pause). `FINAL_ANALYSIS.md`'s Section 30 conclusion (NO-GO for
autonomous real-money trading, no validated edge) stands unchanged; this report will be cross-
referenced from the final `ARGUS_REAL_MONEY_READINESS.md` scorecard (Phase 15), not used to
prematurely revise it.
