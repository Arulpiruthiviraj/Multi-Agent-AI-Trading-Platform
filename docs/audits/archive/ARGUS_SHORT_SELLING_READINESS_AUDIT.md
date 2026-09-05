# ARGUS — Short Selling Readiness & Asymmetric Risk Audit

**Date:** 2026-08-21  
**Mode:** Read-only forensic inspection (no runtime mutation, no `placeOrder` from this audit)  
**Scope:** Live spine ChiefTrader → RiskEngine → OMS → BrokerManager + IB Gateway socket / Web API adapters, PortfolioMonitor, local portfolio ledger, UI holdings math  
**Operator context:** IB Gateway paper account `DUR959160` may report ~CAD $1M equity; that does **not** imply Argus short-selling readiness  

**Global verdict:** Argus is **not production-ready for short selling**. The protected spine is **long-only by design**. A flat-account `SELL` is **fail-closed** at RiskEngine (`sell_position_exists`). Broker adapters can wire a raw IB `OrderAction.SELL`, but they advertise `shortSelling: false`, perform **no** borrow/locate handling, and the portfolio / exit / P&L stack assumes **long inventory only**. Enabling shorts without the remediation plan below would be **UNSAFE** (uncapped upside, wrong or missing P&L, exit side inverted).

**Note on filenames:** There is no `OrderManager.ts` / `ChiefTrader.ts`. Authoritative modules are `OrderManagement.ts` and `ChiefTraderAgent.ts`.

---

## 1. Readiness Scorecard

| Category | Status | Key Finding |
|---|---|---|
| Broker Socket Order Translation | **PARTIAL** | `IbkrSocketSession.placeStockOrder` maps `SELL`→`OrderAction.SELL` / `BUY`→`BUY` with no `shortSaleSlot`, locate, or open/close intent. `getCapabilities().shortSelling === false`. `closePosition()` *would* flip side on `qty < 0`, but live path never opens shorts. |
| Inverted Short P&L Arithmetic | **UNSAFE / MISSING** | OMS realized P&L is long-exit only: `(fill − entry) × qty` on **SELL**. PortfolioMonitor / CapitalAllocation / InternalPaperBroker ignore or skip `qty ≤ 0`. UI formula coincidentally matches short math *if* qty were negative, but shorts are not managed. |
| Mandatory Stop-Loss for Shorts | **MISSING** | No short-specific stop gate. PortfolioMonitor emits **SELL** risk-exits only for `quantity > 0` longs. Covering a short would require **BUY**; that path does not exist. |
| Margin & Borrow Restriction Handling | **MISSING** | No margin-account check, no Reg-T / maintenance cushion math, no IB Error **201** / locate fail-closed mapping on the order path. Session `error` handler logs connect/hist warnings only. |
| Agent Entry vs Exit Intent Disambiguation | **MISSING** | Ideas are `BUY` \| `SELL` \| `HOLD` only. No `SELL_TO_OPEN` / `SELL_TO_CLOSE` / `BUY_TO_COVER`. Risk-exit agent is `SELL`-only. Flat `SELL` never reaches OMS via RiskEngine. |

**Overall readiness:** **NOT READY** (live + paper). Historical Evaluation / BacktestEngine remain long-only (`replaySafety.shortSellingDefault: false`).

---

## 2. Phase Findings

### Phase 1 — Broker adapter & order routing

#### IB Gateway socket (`IBGatewaySocketAdapter` + `IbkrSocketSession`)

| Question | Evidence | Answer |
|---|---|---|
| Flat + `SELL` → valid short (Sell-to-Open)? | `placeStockOrder` sets `action: OrderAction.SELL`, `totalQuantity`, `tif: DAY`, no short-sale fields. Capabilities: `shortSelling: false`. | **Wire-level SELL possible if called**; Argus does **not** claim or validate short-sale semantics. Broker may reject (locate/SSR) or fill as short depending on account — Argus would not track it correctly. |
| Negative position + `BUY` → Buy-to-Cover? | Same mapping: `BUY` → `OrderAction.BUY`. `closePosition` uses `pos.quantity > 0 ? SELL : BUY` with `Math.abs(qty)`. | **Hypothetically yes at the wire**, if a negative position existed. Live RiskEngine/PortfolioMonitor never create that state through the spine. |
| Error 201 / borrow fail-closed? | `EventName.error` during connect logs `CONNECT_FAIL` or warnings; historical path rejects on error. **No** order-ack / Error 201 → OMS REJECTED mapping on `placeStockOrder`. | **MISSING.** Failures may leave OMS `PENDING`/`UNKNOWN` (timeout path) without a typed “no borrow” reason. |

#### IBKR Web API (`InteractiveBrokersWebApiAdapter`)

- `shortSelling: false` (“not implemented this pass”).
- `placeOrder` forwards side as BUY/SELL; `closePosition` same abs-qty flip as socket.
- No borrow / Error 201 specialization found.

#### OMS (`OrderManagement.ts`)

- Sole production `.placeOrder(` caller (architecture invariant).
- Submits `{ side: 'BUY' \| 'SELL', type: 'MARKET', quantity, clientOrderId }` — **no** open/close / short flag.
- On SELL fill: `syncLocalPortfolioAfterSellFill` **decrements** long qty / deletes row — assumes long close, not short open.
- Realized P&L only when `side === 'SELL'`: `(fillPrice - preTradeEntryPrice) * quantity` (long exit). **No** BUY-to-cover realized P&L path.

#### Other brokers (capability honesty)

| Adapter | `shortSelling` |
|---|---|
| AlpacaBroker | `false` |
| InternalPaperBroker | `false` (comment: long-only; SELL without position does not open short) |
| QuestradeBroker | `false` (read-only orders) |
| IB Gateway / Web | `false` |

---

### Phase 2 — RiskEngine & asymmetric loss controls

#### Gate `sell_position_exists` (authoritative short block)

```text
SELL → pass iff existingPosition && existingPosition.quantity > 0
      then maxQuantity = min(sized, existingPosition.quantity)
```

- Flat account `SELL` → **FAIL** (first failure recorded among all gates).
- Negative qty is **not** treated as a short inventory; check is strictly `> 0`.
- There is **no** `ALLOW_SHORTING` (or equivalent) in `config/tradingSafety.json`.

#### Other short-related controls — absent

| Control | Present? |
|---|---|
| Explicit allow-short toggle (live) | **No** (`replaySafety.shortSellingDefault` is research/replay only, default `false`) |
| Margin account type check before short entry | **No** |
| Mandatory buy-to-cover stop (2–3% upside) at approval | **No** — live stop assumption is `stopLossAssumptionPct` (0.05) for **long** risk-per-share sizing, not a short BTC bracket |
| Initial / maintenance margin for shorts (30–50%) | **No** — sizing uses equity / buying power / FIXED_DOLLAR / concentration as for longs; CapitalAllocation **skips** `qty ≤ 0` when computing used allocation |
| `argus_capital_allocation` on SELL | Passes with “SELL/exit does not consume allocation” — correct for **long exit**, wrong if SELL were short-to-open (would understate capital use) |

**Asymmetric risk conclusion:** If RiskEngine were weakened to allow flat SELLs, Argus would **not** enforce a hard upside stop or margin cushion. That is an **uncapped loss** exposure class. Current fail-closed gate is the primary safety net — **do not remove it** without the full remediation set.

---

### Phase 3 — PortfolioMonitor, schema, inverse P&L

#### Negative quantity support

| Layer | Behavior |
|---|---|
| SQLite `portfolio.quantity` (`real`) | Schema **allows** negative numbers (no CHECK `quantity > 0`). |
| PortfolioMonitor | `if (holding.quantity <= 0) continue;` — **shorts never monitored**. |
| Opening-trade lookup | Latest **FILLED BUY** only — no short-open SELL metadata. |
| Risk exits | Always `emitTradeIdea({ side: 'SELL', agent: riskExitAgent })`. |
| localPortfolioSync | SELL fill decrements long; oversell → delete. **No** path to create `qty < 0`. |
| CapitalAllocation `snapshotCapital` | Ignores `qty <= 0` in used positions. |
| InternalPaperBroker | SELL reduces/deletes long; comment explicitly declines short inventory; unrealized = `marketValue - cost` (long). |
| PortfolioReconciliation | Can hydrate whatever broker reports (including negative qty from IB). Local vs remote compare uses absolute drift tolerance — **would accept** broker shorts into `portfolio` on hydrate, then PortfolioMonitor would **ignore** them for exits. |

#### Unrealized / realized P&L rigor

| Path | Formula | Short-correct? |
|---|---|---|
| OMS SELL fill realized | `(fill − entry) × qty` | Long exit **yes**; short open **N/A** (blocked); cover should be on **BUY** — **missing** |
| PortfolioMonitor pnlPct | `(price − avg) / avg` | Long **yes**; short **inverted / unused** (skipped) |
| AutonomousDashboard holdings | `(current − entry) × quantity` | If `quantity < 0`, algebra equals `(entry − current) × |qty|` — **coincidentally correct**, not a designed short path |
| InternalPaper mark | `qty * (px − entry)` style via marketValue − cost | Breaks for negative qty |

#### Exit signal dispatch for shorts

**MISSING.** A short needing cover must emit **BUY** (risk-exit). Today risk-exit is hard-coded **SELL** and only for long holdings. Trailing stop / take-profit / quant stop / campaign EOD flatten all assume long PnL direction (`price` rising = profit).

---

### Phase 4 — Agent intent disambiguation

| Concept | In codebase? |
|---|---|
| `TRADE_IDEA_GENERATED` sides | `BUY` / `SELL` / `HOLD` only (`EventBus.emitTradeIdea`) |
| `SELL_TO_CLOSE` vs `SELL_TO_OPEN` / `SHORT` | **No** distinct fields |
| ChiefTrader risk-exit | `agent === PortfolioManager (risk exit) && side === 'SELL'` — skips entry quorum; still a long-exit SELL |
| Opportunity / Technical / News SELL on unowned symbol | Can emit SELL ideas; ChiefTrader may approve on consensus; **RiskEngine rejects** at `sell_position_exists` |
| Confusion risk if shorting “enabled” by removing the gate only | High: agent SELL on flat names would become short-to-open with **no** intent bit, **no** BTC stop, **wrong** portfolio sync |

Backtest / Historical Evaluation UI exposes a research `shortSelling` checkbox; live spine does **not** honor that flag for OMS orders.

---

## 3. Identified Risk Gaps & Edge Cases

1. **Primary safety is “refuse shorts,” not “manage shorts.”** Removing `sell_position_exists` without replacements → uncapped upside + wrong P&L + no cover exits.
2. **Broker hydrate hazard:** IB can report short positions from **manual** Gateway trades. Recon may insert `qty < 0` into SQLite; PortfolioMonitor skips them → **orphan shorts** with no Argus stop.
3. **OMS SELL sync on orphan short:** If a SELL fill arrived while local long was 0, sync no-ops; broker short grows; local stays empty → recon MISSING_LOCALLY / operator pause noise.
4. **Error 201 / SSR:** Not typed; operator may see PENDING/UNKNOWN; no automatic fail-closed “short unavailable.”
5. **Capability lie risk:** Wire can send SELL while `shortSelling: false` — honesty for UI; not a second gate inside `placeOrder` today.
6. **UI coincidence:** Holdings PnL formula looks “short-safe” for negative qty but PortfolioMonitor/OMS are not — operators must not trust dashboard short P&L as certified.
7. **Allocation undercount:** Negative positions ignored in capital used → budget guard would not reserve short margin if shorts were allowed.
8. **LIVE_NO_GO unchanged:** Even after paper short work, live eligibility remains separate; shorts on live margin would need stronger gates than paper.

---

## 4. Remediation Plan (production-safe shorts — additive, flag-gated)

Do **not** bypass RiskEngine, OMS, or ChiefTrader. Prefer a reviewed feature flag (e.g. `config/tradingSafety.json` → `allowShortSelling: false` default) + architecture-protection tests.

### 4.1 Intent model (Phase 4 first)

- Extend trade-idea payload (config `eventNames` / typed idea):  
  `intent: 'OPEN_LONG' | 'CLOSE_LONG' | 'OPEN_SHORT' | 'CLOSE_SHORT'`  
  Keep `side: 'BUY' | 'SELL'` as broker action.
- Mapping:
  - OPEN_SHORT → SELL when flat / no long  
  - CLOSE_SHORT → BUY when `qty < 0`  
  - CLOSE_LONG → SELL when `qty > 0`  
  - OPEN_LONG → BUY when flat / no short  
- Refuse OPEN_SHORT unless `allowShortSelling === true`.
- ChiefTrader: risk-exit for shorts = CLOSE_SHORT (BUY); longs remain CLOSE_LONG (SELL).

### 4.2 RiskEngine gates (Phase 2)

Add recorded gates (fail-closed), numbers from JSON only:

| Gate | Rule (sketch) |
|---|---|
| `shorting_enabled` | OPEN_SHORT only if flag true |
| `margin_account_required` | Broker account type / IB tags confirm margin (paper DU* may still need explicit check) |
| `sell_position_exists` | Rename/split: CLOSE_LONG requires `qty > 0`; OPEN_SHORT requires `qty === 0` (no flip through mixed) |
| `cover_position_exists` | CLOSE_SHORT requires `qty < 0`; clamp to `abs(qty)` |
| `short_stop_bracket_required` | OPEN_SHORT rejected unless proposed cover stop within `maxShortUpsidePct` (config) |
| `short_margin_cushion` | Notional × maintenance pct ≤ buying power remaining (config; broker BP as input, not fabrication) |

Keep existing 24-gate recording discipline; extend catalog in `riskGateOrder.json`.

### 4.3 OMS / portfolio (Phase 3)

- On OPEN_SHORT fill: create/update `portfolio.quantity` **negative**; stamp `brokerId`.
- On CLOSE_SHORT (BUY) fill: increment toward zero; realized P&L = `(entry − fill) × coverQty`.
- Extend `localPortfolioSync` for BUY covers and short opens.
- PortfolioMonitor: process `qty < 0` with inverted stop/target (`stop` above entry); emit CLOSE_SHORT / BUY.
- CapitalAllocation: count short notional toward used capital when flag on.

### 4.4 Broker adapters (Phase 1)

- Gate `placeOrder`: if `!getCapabilities().shortSelling && wouldOpenShort` → throw before IB.
- When enabling: set `shortSelling: true` only after locate/error handling exists.
- Map IB errors (incl. **201**, SSR) → OMS status REJECTED + structured reason; never silent PENDING forever without reconcile.
- Optional: IB `shortSaleSlot` / order refinements per IB API docs for the socket path.

### 4.5 Agents / research

- Opportunity / Technical SELL on flat: tag OPEN_SHORT only if flag on; else keep today’s reject at Risk.
- Quant / BacktestEngine: keep long-only until OOS + paper soak for shorts separately; do not reuse long PF floors.
- UI: show intent + negative qty; replace coincidental PnL with explicit short formula tests.

### 4.6 Verification (paper only first)

1. Flag off: flat SELL still rejected (`sell_position_exists` / `shorting_enabled`).
2. Flag on (IB paper): OPEN_SHORT → negative holding → BTC stop emits BUY → cover P&L sign correct.
3. Forced Error 201 simulation → REJECTED, no fabricated fill.
4. Manual Gateway short hydrate → PortfolioMonitor covers or operator alert (no silent ignore).
5. `architecture.protection.test.ts` + new unit tests for sizing/P&L/gates.
6. Organic paper soak floors for shorts **separate** from long soak; LIVE remains `LIVE_NO_GO` until evaluateLiveReadiness says otherwise.

---

## 5. Immediate Operator Guidance

- **Do not** follow “CONFIRM SELL with 0 shares to short” guides against Argus today — RiskEngine will reject; if anything reached the broker outside Argus, Argus will not manage the short.
- Practice **long** BUY → SELL on IB Gateway paper until a reviewed short feature ships.
- Respect asymmetric risk: even after remediation, shorts need mandatory cover stops and margin checks before any LIVE consideration.

---

## 6. Evidence Index (files inspected)

| Area | Paths |
|---|---|
| IB socket | `src/brokers/IBGatewaySocketAdapter.ts`, `src/brokers/IbkrSocketSession.ts` |
| IB web | `src/brokers/InteractiveBrokersWebApiAdapter.ts` |
| OMS | `src/server/services/OrderManagement.ts`, `localPortfolioSync.ts` |
| Risk / sizing / capital | `src/server/engines/RiskEngine.ts`, `PositionSizing.ts`, `CapitalAllocation.ts`, `config/riskGateOrder.json`, `config/tradingSafety.json` |
| Portfolio / exits | `src/server/services/PortfolioMonitor.ts`, `src/server/db/schema.ts` (`portfolio`) |
| Consensus | `src/server/services/ChiefTraderAgent.ts`, `src/server/core/EventBus.ts` |
| Paper / research | `src/brokers/InternalPaperBroker.ts`, `config/replaySafety.json`, `src/server/engines/backtest/BacktestEngine.ts` |
| UI | `src/components/AutonomousDashboard.tsx` |

---

*This audit documents current behavior. It does not authorize LIVE short trading, lower consensus floors, or bypass OMS/RiskEngine.*
