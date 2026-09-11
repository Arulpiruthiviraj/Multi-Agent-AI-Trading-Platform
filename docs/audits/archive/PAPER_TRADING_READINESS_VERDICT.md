# Paper Trading Readiness Verdict — 2026-08-23

Read-only-verified except where noted. Real test/compiler output only; no fabricated numbers.

## 1. Executive Verdict

**GO for supervised PAPER** (`PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS` — unchanged from
`CLAUDE.md`; this audit found nothing that regresses that status). **LIVE remains `LIVE_NO_GO`**
(`evaluateLiveReadiness()`, unaffected by anything in this pass — organic closed PAPER FILLED SELL
P&L is still **0 / 30 trades · 0 / 10 sessions**, confirmed just now via
`npx tsx scripts/organic_paper_soak_status.ts`, script exited cleanly).

This is a fix-and-verify pass, not a new capability. Nothing here changes edge, soak progress, or
LIVE eligibility — it removes a real defect that was silently rejecting valid PAPER BUY orders.

## 2. Defect Remediation Summary

| # | Defect | File(s) | Fix | Verified by |
|---|---|---|---|---|
| P0 | `BROKER_ENVIRONMENT_UNKNOWN` rejecting valid PAPER BUYs (real TSLA/RIOT rows, 2026-08-21T18:31:14/16Z, `data/argus.db` trades `60697e63…`/`1b8f549f…`) | [`src/server/services/OrderManagement.ts:79`](../../src/server/services/OrderManagement.ts#L79) | `readTradingMode()` now routes the raw `settings.tradingMode` DB read through the existing `normalizeTradingMode()` helper instead of returning it verbatim. Root cause: a missing/malformed DB value (e.g. an unseeded row) returned `null`, which `classifyBrokerEnvironment()` cannot classify as `PAPER`/`LIVE` and fails closed to `UNKNOWN` — even though `resolveOmsPaperMode()`'s `PAPER_TRADING_ONLY` short-circuit and Alpaca's `getCapabilities()` both say PAPER is fine. `normalizeTradingMode()` always resolves to a valid mode, defaulting ambiguity to `PAPER`, never `LIVE`. | New regression test in `OrderManagement.test.ts` reproducing the exact scenario (unseeded `tradingMode: null`, no `PAPER_TRADING_ONLY`, no stored broker-connection row, Alpaca dual-capable) — order now reaches the broker. 2 new tests in `brokerEnvironment.test.ts` documenting the still-correct fail-closed case vs. the now-fixed normalized case. |
| P1 | `trades.profit_loss` null on some FILLED SELLs | `src/server/services/omsEntryPrice.ts` | **Not a live defect** — see §2.1. No code change made. | Direct query against `data/argus.db`: 67/69 SELL+FILLED rows already have correct `profit_loss`. |
| — | 3 pre-existing test failures (`architecture.protection.test.ts`, `NewsCatalystStore.test.ts`, `WalkForwardValidator.test.ts`) | see prior audit | Fixed in an earlier pass this session (root-caused each individually; not superficial skips). | Full suite green (§3). |
| — | `npm run dev` crash (`ERR_INVALID_ARG_VALUE` in `startJavaQuantCoreAndWait`) taking down the entire Argus process | [`scripts/devWithOpenAlice.ts:317-388`](../../scripts/devWithOpenAlice.ts#L317) | `fs.createWriteStream()`'s async-opening fd was passed directly into `spawn()`'s `stdio` array, racing the open. Fixed with `fs.openSync()` (synchronously valid fd) + split into a safe wrapper (try/catch, warn-and-continue) around the real logic — matching every other companion service's fail-open discipline. | Confirmed in this pass still present at `devWithOpenAlice.ts:388` (`fs.openSync`, not `createWriteStream`). Not re-verified via a live `./argus.sh start` this pass — that remains the operator's own action. |

### 2.1 Why P1 is not a defect

The user-reported IWM/NVDA null-`profit_loss` rows predate the current 3-tier cost-basis fallback in
`omsEntryPrice.ts` (broker position → local `portfolio` row → most recent live FILLED BUY). Querying
`data/argus.db` directly: **67 of 69** `SELL`+`FILLED` trades already carry a correctly computed
`profit_loss`. Only the 2 rows the spec named are null, and both are from before that fallback chain
existed in the code that ran at the time. Nothing in current code reproduces this — no fix was made,
and the 2 historical rows were **not** backfilled (that would mean writing values into trade history
without being asked).

## 3. Test Suite Verification

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` (full) | **348 / 348 files, 2210 / 2210 tests passed** (316s) — up from the prior session's 348/2207 baseline by the 3 new regression tests added this pass |
| Targeted re-run (`brokerEnvironment.test.ts`, `OrderManagement.test.ts` + siblings, `liveReadiness.test.ts`, `tradingModeEnv.test.ts`) | 6 files / 48 tests passed |

Java Quant Core (`quant-core-java`) was **not** re-run this pass (`mvn clean test`) — no Java files were
touched in this fix, and the last recorded run this session was 87/87 green. If you want a fresh
confirmation before market open, run:

```bash
cd quant-core-java && mvn clean test
```

## 4. Market Open Readiness Checklist (IBKR/Alpaca PAPER)

Everything below is either previously-verified-and-unchanged (per `CLAUDE.md` and this session's
earlier forensic audit) or reconfirmed live this pass — marked accordingly. This is **not** a new
audit of ChiefTrader/RiskEngine internals; see `docs/audits/CURRENT_STATE_AND_LAST_MARKET_RUN_AUDIT.md`
for that.

- [x] **`PAPER_TRADING_ONLY=true`, `ARGUS_TRADING_MODE=PAPER`** — reconfirmed live in `.env` this pass.
- [x] **`settings.trading_mode = "PAPER"`, `settings.budget = 2000`** — reconfirmed live in `data/argus.db` this pass.
- [x] **`broker_connections` has a row for `"Alpaca"` with `paper_mode=1`** — reconfirmed live this pass. (Not load-bearing for the P0 fix itself — `resolveOmsPaperMode`'s `mode==='PAPER' && paperCapable` branch covers Alpaca even without this row — but it's a second independent layer that also resolves correctly.)
- [x] **RiskEngine 24 gates / ChiefTrader 0.75 + 2-agent quorum** — unchanged, protected spine untouched this pass.
- [x] **Kill switch (`TRADING_PAUSED`/`EMERGENCY_STOP`)** — unchanged, untouched this pass.
- [x] **Daily Goal Campaign soft-lock** — unchanged, untouched this pass; off by default (`settings.campaign_enabled`).
- [ ] **IB Gateway TCP :4002 live connectivity** — not exercised this pass (this fix path is Alpaca-specific; IBKR's dual-capable branch in `resolveOmsPaperMode` was already covered by existing tests and untouched). Operator should confirm Gateway is up before relying on it tomorrow.
- [ ] **A real `./argus.sh start` / `stop` / `restart` cycle** — the boot-crash fix (row 4, §2) was verified in isolation, not via a live rerun. Recommend the operator do one clean start/stop cycle before market open.

## 5. Pre-Market Operator Checklist (tomorrow)

```bash
./argus.sh start                       # or: npm run dev
curl -s :3000/api/v2/live-readiness     # expect result: "LIVE_NO_GO" (correct)
curl -s :3000/api/v2/quant-core/health  # only meaningful if QUANT_JAVA_CORE_ENABLED=true
./argus health                          # ecosystem port/process check
```

- Confirm reconciliation is clean (or mismatches understood) before enabling Autobot.
- Watch for any further `BROKER_ENVIRONMENT_UNKNOWN` in `trades.reasoning` — should not recur for
  Alpaca given the fix; if it does, capture the exact `settings.tradingMode` /
  `broker_connections` row at that moment, since that's the next place to look.
- Export 3–5 `traceId`s that reach OMS during the session for a sanity spot-check
  (`/api/v2/traces/:id/export`).
