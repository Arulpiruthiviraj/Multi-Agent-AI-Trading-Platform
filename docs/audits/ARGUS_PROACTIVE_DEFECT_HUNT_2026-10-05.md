# Argus Proactive Defect Hunt — 2026-10-05

**Goal:** find defects *before* market open instead of discovering them live.
**Method:** four parallel read-only sweeps (trading spine & order lifecycle; market data & news ingestion; risk/portfolio/reconciliation; session/time/auth/config/infra) + targeted pattern greps. Every P1 below was verified against the actual code by the reviewing agent; structural P1s/P2s carry exact file:line and a concrete trigger scenario.
**Result:** 0 × P0, 18 × P1, 12 × P2. No findings put capital directly at risk through the live order path (OMS remains the sole production `placeOrder` caller, no POST retries, kill-switch re-check intact) — but several P1s corrupt paper evidence, defeat safety quarantines, or emit phantom trading ideas.

---

## P1 — Fix before market open

### 1. PortfolioMonitor: division by zero on zero cost basis → infinite PnL → phantom TARGET_REACHED
`src/server/services/PortfolioMonitor.ts:297`
```ts
const PnL = ((currentLivePrice - holding.averagePrice) / holding.averagePrice) * 100;
```
No guard on `holding.averagePrice`. A zero-basis position (transferred-in, corporate-action reset, or the IBKR adapter's fabricated `entryPrice: 0` — see #11) makes any live price > 0 compute +Infinity PnL → `TARGET_REACHED` risk-exit SELL idea at full confidence. Negative basis could phantom-trigger `HARD_STOP`. Line 211 guards `quantity <= 0` but not basis.
**Fix:** fail closed — skip exit math and record `NO_BASIS`/WARNING when `!(averagePrice > 0)` (mirrors `POSITION_BASIS_UNAVAILABLE` in `positionFillEvidence.ts`).

### 2. PortfolioMonitor exit logic runs on marks with no freshness bound
`src/server/services/PortfolioMonitor.ts:213`
```ts
const currentLivePrice = marketDataWorker.getLatestPrice(holding.symbol);
if (!currentLivePrice) {
```
`getLatestPrice` returns the cached tick with no age check (`getLatestPriceAgeMs` exists but is never called here). Reproduce the 2026-10-05 incident pattern — GC/event-loop pressure ages a tick stale — and reconciliation correctly fails closed with `ACCOUNT_VALUATION_UNAVAILABLE`, but the 60s monitor timer keeps emitting `TARGET_REACHED`/`HARD_STOP`/`TRAILING_STOP`/`EOD_FLATTEN` SELL ideas against hours-old data, or misses a real unfolding loss. Reconciliation's own `resolveMark` refuses ticks older than `stalePriceThresholdMs` — the two subsystems disagree on mark trustworthiness.
**Fix:** check `getLatestPriceAgeMs(symbol)` vs `tradingSafety.stalePriceThresholdMs` before exit evaluation; on stale, record `STALE_PRICE` and skip.

### 3. EXTERNAL_MANUAL quarantine defeated one cycle after creation
`src/server/services/OrderManagement.ts:933`
```ts
if (o.status !== knownRow.status || (filledQty > 0 && !isTerminalOrderStatus(knownRow.status))) {
  await this.applyFollowUpUpdate(knownRow, o);
}
```
A manual/TWS order with no local row is quarantined as `EXTERNAL_MANUAL` ("do not record fills"). Next cycle the broker still says FILLED while local says EXTERNAL_MANUAL, so the first clause is true forever → `applyFollowUpUpdate` → `recordFillProgress` inserts real fills and the CAS status write flips the quarantined row to FILLED. The Phase-20 quarantine is deterministically defeated. (`EXTERNAL_MANUAL` *is* in `TERMINAL_ORDER_STATUSES`, but the first clause fires regardless.)
**Fix:** `continue` for audit/diagnostic rows (`EXTERNAL_MANUAL`, `ARCHIVED_DIAGNOSTIC`) at the top of the `knownRow` branch; also add both statuses to the `notInArray` exclusion in `recordFillProgress`'s catch.

### 4. Kill-switch stamps CANCELED on unconfirmed IBKR cancel
`src/server/engines/TradingEngine.ts:642` + `src/brokers/IBGatewaySocketAdapter.ts:328`
`cancelAllOpenOrders` treats `broker.cancelOrder()` returning `true` as "cancelled at the broker" and stamps `trades.status='CANCELED'` — but for IBKR, `true` means only "cancel request written to the socket" (`IbkrSocketSession.cancelOrder` is void, fire-and-forget; confirmation arrives async via orderStatus). If the fill wins the race, the row reads CANCELED while holding fills and a real broker position, and the kill-switch audit log overstates "cancelled N open order(s)". (Alpaca's path is fine — its DELETE throws on already-filled.)
**Fix:** stamp non-terminal `CANCEL_REQUESTED` on send-ack; terminal `CANCELED` only on broker-confirmed cancellation or after a bounded confirmation window with no fill evidence.

### 5. Crossed IEX quotes pass the discovery spread screen (negative spreadBps)
`src/server/continuous/MarketUniverseScanner.ts:198,229`
```ts
const spreadBps = (typeof bid === 'number' && typeof ask === 'number' && bid > 0 && ask > 0)
  ? ((ask - bid) / ((ask + bid) / 2)) * 10000 : null;
if (snap.spreadBps != null && snap.spreadBps > cfg.broadUniverseMaxSpreadBps) return { pass: false, reason: 'SPREAD' };
```
A momentarily crossed quote (bid > ask — routine on IEX for thin names in volatility) yields *negative* spreadBps, which always passes the positive ceiling. The candidate is admitted on corrupt quote evidence and consumes a scarce streaming slot — while the streaming path's own `getLatestSpreadBps` (`MarketDataWorker.ts:872`) explicitly rejects crossed quotes. Admission is strictly weaker than runtime on the same data shape.
**Fix:** treat `spreadBps < 0` as corrupt evidence — reject with a distinct `SPREAD_CROSSED` reason or null it. TS plumbing, no threshold change.

### 6. Bid/ask freshness measured at receipt time, feeding a RiskEngine execution gate
`src/server/services/MarketDataWorker.ts:1511,1517` → `src/server/engines/RiskEngine.ts:917`
`latestBidEvidence.observedAtMs` / `latestAskTimestamps` are stamped `Date.now()` at message handling while the exchange timestamp `msg.t` (parsed two lines above) is discarded for freshness. If the socket goes half-open or the event loop stalls (the 2026-10-05 2.1GB condition), a burst of delayed quotes processed minutes late looks fresh, and `getLatestSpreadBps(symbol, extendedHoursMaxQuoteAgeMs)` passes the `extended_hours_execution_policy` gate on a bid from 4pm paired with an ask from 9am — the exact fabrication the function's doc comment says it prevents.
**Fix:** on the Alpaca `"q"` path store the exchange timestamp as the observation time (or both, take min); keep receipt time for IBKR where no exchange timestamp exists.

### 7. Daily-loss baseline is in-memory only — a mid-day restart erases morning losses
`src/server/engines/RiskEngine.ts:517` (+ `TradingEngine.ts:117,144`)
```ts
if (tradingEngine.state.dayStartDateStr !== todayStr) {
    tradingEngine.state.dayStartDateStr = todayStr;
    tradingEngine.state.dayStartEquity = equityNow;
    tradingEngine.state.currentDailyLoss = 0;
}
```
After any mid-day restart (crash, deploy, OOM), the already-depressed equity becomes the day's baseline and `currentDailyLoss` zeroes — the kill switch needs a full fresh threshold of *additional* losses before tripping. `tradingEngine.state` has no persistence write path.
**Fix:** persist `dayStartEquity`/`dayStartDateStr` (settings table or dedicated row) and restore on boot, or derive the baseline from the day's first persisted account snapshot.

### 8. NaN dollar-impact neuters the reconciliation pause gate
`src/server/services/PortfolioReconciliation.ts:313,336`
```ts
const price = pos.currentPrice || avgPrice;   // both can be null (F26 "unavailable" state)
mismatches.push({ ..., approxDollarImpact: qty * price });  // qty * undefined = NaN
worstImpact = Math.max(...mismatches.map(m => m.approxDollarImpact));  // NaN
```
`NaN >= SIGNIFICANT_MISMATCH_DOLLARS` is false, so a *confirmed* divergence can never trip the pause; `toFixed(2)` renders `"NaN"` in logs, corrupting forensics. (Line 200 already uses the safer `Math.max(SIGNIFICANT_MISMATCH_DOLLARS, …)` shape — note `Math.max(100, NaN)` is still NaN, so apply the finite-price fallback there too.)
**Fix:** compute `Math.abs(qty) * finitePositivePrice` with a conservative fallback when no finite positive price exists; NaN must never reach the pause comparison.

### 9. Non-positive daily-buy cap silently disables the cap (fail-open)
`src/server/engines/DailyBuyNotional.ts:24`
```ts
return paperCap > 0 ? paperCap : null;
```
`maxDailyBuyNotionalDollars: 0` (operator intending "block all buying") or a negative typo resolves to `null`, and `evaluateDailyBuyNotional` treats `null` as "skip" — daily buying becomes unbounded. The header comment documents the footgun ("0 would mean uncapped — do not ship 0") but implements it fail-open; the only guard is a test-time assertion.
**Fix:** fail closed — treat non-positive/NaN as `0` (every BUY fails `projected <= cap`), or validate at config load and refuse to boot trading.

### 10. Negative price/quantity rows subtract from deployed notional
`src/server/engines/DailyBuyNotional.ts:28-30`
```ts
if (!Number.isFinite(px) || !Number.isFinite(qty)) continue;
sum += px * qty;
```
One anomalous row (adapter glitch, manual correction, bad legacy import) with negative quantity/price subtracts thousands from "already deployed"; the cap then approves BUYs it should block. Sibling `snapshotCapital` (`CapitalAllocation.ts:92-96`) already guards `qty > 0 && px > 0` — the two capital paths disagree.
**Fix:** add the same `px > 0 && qty > 0` guard; log-and-skip anomalous rows loudly.

### 11. AlpacaBroker `parseFloat` → NaN quantity drops the position from allocation `used` (fail-open)
`src/brokers/AlpacaBroker.ts:318`
```ts
quantity: parseFloat(p.qty),   // NaN on missing/unparseable qty — violates the F26 Position contract (number | null)
```
NaN flows into `snapshotCapital` → `qty <= 0` → `continue` — the position vanishes from `used`, `remaining` is overstated, gate 23 approves over-budget BUYs.
**Fix:** map unparseable fields to `null` per F26; make `snapshotCapital` treat null quantity as `degraded` (fail-closed).

### 12. IBKR WebAPI adapter fabricates `entryPrice: 0` → permanent false halt on all BUYs
`src/brokers/InteractiveBrokersWebApiAdapter.ts:291`
```ts
entryPrice: p.avgCost ?? p.avgPrice ?? 0,
```
A position with no basis (transferred-in, corporate actions) gets `entryPrice: 0` → `snapshotCapital` marks `degraded` → `evaluateAllocationGuard` fails **every** BUY with `CAPITAL_SNAPSHOT_DEGRADED` until the position closes. (Also feeds #1's phantom TARGET_REACHED via the hydrate path.)
**Fix:** use `null` per the F26 contract instead of fabricating 0.

### 13. `AUTH_SESSION_TTL_DAYS=0`/typo silently falls back to 10-year sessions
`server.ts:332`
```ts
const SESSION_TTL_MS = (Number(process.env.AUTH_SESSION_TTL_DAYS) || 3650) * 24 * 60 * 60 * 1000;
```
`0` or `NaN` are falsy → `|| 3650` → ~10-year sessions and cookies, the opposite of operator intent. Read in exactly one place; `checkAuthConfig` never validates it.
**Fix:** parse strictly at boot; treat missing/zero/negative/non-numeric as fatal auth-config error (fail closed).

### 14. InternalPaperBroker `tick()` mints cash on over-sell
`src/brokers/InternalPaperBroker.ts:224`
```ts
} else if (order.side === 'SELL') {
   this.cash += cost;                    // credited before any position check
   const pos = this._positions.get(order.symbol);
```
Two approved SELLs against the same pre-fill position (or one oversized SELL): the second finds no position but still credits full proceeds. Equity/buying power inflate, corrupting paper P&L evidence and downstream sizing. (Simulator-only, but it is also the fail-closed fallback target.)
**Fix:** reject (or clamp to held quantity) any SELL exceeding the held position before crediting cash — fail closed like the BUY branch.

### 15. InternalPaperBroker drops `clientOrderId`, breaking fill attribution
`src/brokers/InternalPaperBroker.ts:106`
`placeOrder` builds its `Order` literal without `clientOrderId` and implements no `getOrderByClientOrderId()`. Every internal-paper fill flows through `reconcileInboundBrokerOrders()`, whose dedup check can never match, so fills are misfiled as `SOURCE: EXTERNAL_MANUAL`. Same bug class as the IBKR gap fixed 2026-09-09, still live in the simulator.
**Fix:** copy `orderData.clientOrderId` into the created `Order`; implement `getOrderByClientOrderId()` as an in-memory lookup.

### 16. Reconciliation hydrates broker-side shorts, then they become invisible (false MATCH)
`src/server/services/PortfolioReconciliation.ts:266-268`
A short (−100 XYZ) opened outside Argus: no fill rows → hydrate inserts `quantity: -100` with no sign check → read-back verifies → `RECONCILIATION_MATCH`, no mismatch ever recorded. PortfolioMonitor then skips the row forever (`quantity <= 0 → continue`) — no stop/target review — and the `MISSING_REMOTELY` loop skips it too. Reconciliation's documented purpose includes catching externally-placed orders.
**Fix:** reject non-positive remote quantities in the hydrate path — record `SHORT_POSITION_UNMONITORED` mismatch/operator alert instead.

### 17. Account-level tripwires pause on a single transient cycle (no debounce)
`src/server/services/PortfolioReconciliation.ts:461,467,475`
`ACCOUNT_VALUATION_UNAVAILABLE` / `ACCOUNT_INCONSISTENCY` are recorded at exactly `$100` impact and the pause gate fires on first occurrence — no `confirmConsecutiveFault` debounce, unlike every symbol-level and open-order check (which require 2 consecutive cycles). One blip halts the session with no auto-resume per standing policy.
**Fix:** route account-level mismatches through the same `confirmConsecutiveFault(…, PAUSE_CONSECUTIVE_CYCLES)` debounce.

### 18. Follow-up re-broadcasts ORDER_EXECUTED every 15s for unchanged partial fills
`src/server/services/OrderManagement.ts:824`
```ts
if (match.status !== row.status || (match.filledQuantity ?? 0) > 0) {
  await this.applyFollowUpUpdate(row, match);
}
```
A working partial fill re-triggers `applyFollowUpUpdate` (and its unconditional `ORDER_EXECUTED` emit) every 15s cycle with nothing changed — an event storm for downstream listeners. Same mechanism as the real 2026-10-01 incident (replayed SELL → unintended short flip); that fix guarded only the inbound-recovery trigger.
**Fix:** gate on real change — compare `match.filledQuantity` against the fills-ledger watermark.

---

## P2 — Fix this week

1. **News credibility filter is unreachable; per-provider weights are dead config.** `NewsEngine.ts:144` — `assess(normalized, 0.8)` hardcodes the weight; min achievable score is 0.5, so `if (credibility < 0.3) continue` can never fire, and every provider's `credibilityWeight` is ignored. (Also means the Oct-5 PCVX "credibility-filtered" hypothesis was impossible.) Fix: thread provider identity through `fetchAllLatest()` and pass the real weight.
2. **NewsDeduplicator wipes its seen-cache at 10k entries → mass re-analysis.** `NewsDeduplicator.ts:20` — wholesale `.clear()`; at ~233 articles/day, ~6 weeks uptime triggers re-running FinBERT/escalation/LLM on up to 10k already-seen articles. Fix: bounded eviction (LRU/time-window) or durable seen-ids.
3. **Cross-provider dupes re-emit fresh catalysts after every restart; no article-age gate.** Dedup is in-memory-only while the DB guard is keyed on provider-native id — a CNBC copy of a Yahoo story sails through as "new" post-restart and emits `NEWS_CATALYST` for a days-old story. Fix: persist fingerprints / rehydrate on boot; add max-article-age gate.
4. **All four paid news providers report HTTP failures as successful empty batches.** `FinnhubNewsProvider.ts:21` et al — `if (!res.ok) return []` → recorded as success with zero articles; 401/429/5xx is invisible. Fix: throw so the manager records `errorCount`/`NEWS_PROVIDER_FAILED`.
5. **Rescue RENEWAL extensions uncapped → eviction immunity.** `MarketDataWorker.ts:571` — `extensionCount` tracked but never capped; each RENEWAL resets the clock and skips the budget; rescued symbols are excluded from eviction ranking. A renewed symbol becomes permanently unevictable — the inverse of the PTC hot-swap starvation. Fix: cap `extensionCount` in config.
6. **Expired movers cache keeps awarding the hot-swap mover bonus.** `MarketUniverseScanner.ts:743` — `getCachedMoverSymbols()` serves symbols past TTL; `blendedHotSwapScore()` grants the bonus with no staleness discount. During a movers-endpoint outage, yesterday's movers keep winning the single hot-swap slot. Fix: return staleness alongside symbols; decay/skip the bonus past TTL.
7. **No per-stage news discard counters** (the PCVX forensic gap, still open). Dedup/credibility/cluster discards all `continue` silently; `NEWS_PIPELINE_TICK` reports only fetched/analyzed. Fix: add `dedupFiltered`, `credibilityFiltered`, `clusterSkipped` to the tick payload.
8. **tradingSafety numerics type-checked but never range-checked.** A hand-edit of `"campaignEodFlattenEtMinutesBeforeClose": 0` passes validation → `isCampaignEodFlattenWindow` computes start `"15:60"` → window never matches → EOD flatten silently never fires, leaving campaign positions exposed overnight. Fix: per-field range assertions, fail boot on violation.
9. **gracefulShutdown exits 0 even when the drain failed.** Both exit paths call `process.exit(0)` despite `drainFailed` — supervisors with `restart: on-failure` never restart; exit code contradicts the unclean-shutdown marker. Fix: `process.exit(drainFailed ? 1 : 0)`.
10. **4 boot-started workers never stopped in shutdown drain** (`opportunityScreenerWorker`, `quantCoreBridge`, `kronosForecastAgent`, `firstFillForensicCheckpoint`) — in-flight handlers can touch SQLite after close, tripping the error-storm breaker mid-drain. Fix: add the four `stop()` calls before the SQLite checkpoint.
11. **Crash-recovery wrong-broker fallback reintroduces the false-REJECTED the 2026-09-29 fix closed.** `OrderManagement.ts:1054` — `getBroker(brokerId) || activeBroker` asks the *wrong* broker about an order stamped to an unregistered adapter; its "not found" marks the row REJECTED. Fix: skip rows with a stamped-but-unregistered broker id as uncheckable.
12. **buyingPowerReservations catch returns 0 (fail-open).** A transient `SQLITE_BUSY` during gate evaluation reopens the TOCTOU race the module was built to close. Fix: propagate a sentinel so RiskEngine fails closed.

**P2 runners-up (credible, condensed):** OMS reservation leak if `getActiveBroker()` throws before first release (`OrderManagement.ts:401`); `sumDailyBuyNotional` unparseable timestamp → `RangeError` → *all* ideas rejected incl. protective SELLs (liveness); `campaignScalpTarget1Hit` never cleared → phantom `HARD_STOP` on next-day re-buy; mark-less position suppresses the whole account equity-consistency check; RiskEngine campaign block's `pendingBuys` lacks the REPLAY filter (fail-closed under-sizing); stale OMS comment asserting an Alpaca dedup guarantee the adapter's FD-9 note refuted (doc hazard — a future reader could re-enable POST retries); mid-session broker switch can orphan an in-flight order on the old broker; `MarketRegimeAgent.detectRegime` fires an LLM call on a bare `setInterval` with no overlap guard (slow responses stack and emit contradictory regimes out of order).

## Verified clean (not reported)
RiskEngine evaluation mutex; emergency-stop gate; persist-then-emit; data_freshness/price_validity gates; SELL quantity clamp; PositionSizing fail-closed on stale marks; OMS kill-switch re-check with no await before the sole `placeOrder`; no POST retry; SUBMIT_UNKNOWN → PENDING + pause; fill-ledger idempotency; ChiefTrader per-symbol consensus mutex (uppercase-canonicalized key); IbkrSocketSession orderRef/execId dedup; no production `placeOrder` caller other than OMS; DST/timezone handling (all session math via `Intl`/`America/New_York`); daily cutoffs NY-based; auth expiry/sliding refresh; rate-limiter coverage on trading-mutating routes; migrations rethrow; missing config JSON throws; `PAPER_TRADING_ONLY` demotion; `normalizeTradingMode` unknown → PAPER.
