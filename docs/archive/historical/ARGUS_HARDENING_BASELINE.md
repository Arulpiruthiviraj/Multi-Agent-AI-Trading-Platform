# ARGUS_HARDENING_BASELINE.md

**Phase 0 only. No implementation has begun. This document establishes the regression baseline that every subsequent hardening change must be measured against.**

---

## 1. Repository State

- **Branch:** `main`
- **Git status:** 112 uncommitted paths — 49 modified, 62 untracked (new files), 1 deleted. **All of this predates this hardening task** — it is the accumulated, already-tested output of this session's prior work (the 4-phase remediation plan from earlier in this engagement, plus this session's 13 frontend truth-wiring fixes and the two prior analysis documents). Nothing has been touched as part of this Phase 0 baseline pass beyond running read-only checks and writing this file.
- **Deleted file:** `src/server/services/EncryptionService.ts` — confirmed intentional (a dead, hardcoded-key duplicate of the real `src/server/core/EncryptionService.ts`, removed in a prior session; zero import references).
- **New files of note:** `CURRENT_STATE_BASELINE.md`, `FINAL_APPLICATION_STATE_ANALYSIS.md` (this hardening pass's authoritative input), 8 new `v2System.*.test.ts` files + their corresponding new routes in `v2System.ts` (this session's frontend truth-wiring), `vitest.setup.ts` (DB test isolation), `playwright.config.ts` + `e2e/` (E2E scaffolding from a prior session), and the full set of prior-session additions documented in `FINAL_ANALYSIS.md` §16-26 (AuthConfig, RateLimiters, PositionSizing, Commissions, Slippage, ConfidenceCalibration, ExternalDataCache, AgentSynergy, TransactionLifecycleTracker, MarketDataCrossChecker, and their tests).
- I am **not** committing, discarding, or reorganizing any of this uncommitted work — it is out of scope for this hardening task and will be left exactly as-is unless a specific hardening change requires touching one of these files, in which case it will be called out explicitly in that change's own before/after note.

## 2. Baseline Build/Test/Lint Results

All checks run twice where run-to-run stability matters; all confirmed stable.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` (== `npm run lint`) | **Clean, 0 errors** |
| Build | `npm run build` | **Clean** — Vite SPA (3,008.16 kB / 609.25 kB gzip main chunk, pre-existing >500kB chunk-size warning, not new) + esbuild server bundle (477.4kb) |
| Unit/integration tests | `npx vitest run` | **50 files / 326 tests passing** — run twice consecutively, identical result both times (14.55s and 13.96s) |
| Raw-write security scanner | `npm run security:scan-writes` | **Clean** — 10 route files scanned, no unallowlisted `req.body` writes |
| Dependency audit | `npm audit` | **4 moderate, 0 high/critical** — all in the dev-only `drizzle-kit → @esbuild-kit → esbuild` chain, never shipped to production (unchanged from every prior session's finding) |

**No failing tests, no build errors, no type errors exist in the current baseline.** Any regression introduced by hardening work will be visible against this exact baseline.

## 3. Identified Working Functionality (Summary)

Full detail lives in `FINAL_APPLICATION_STATE_ANALYSIS.md` (this hardening pass's authoritative source) and is not re-derived here. In summary, confirmed real and working:

- Full event-driven pipeline: `MarketDataWorker` → 5 real agents → `ChiefTraderAgent` (weighted consensus + optional real parallel AI debate) → `RiskAgent` → `RiskEngine` (11 real, always-evaluated gates) → `OrderManagementService` → `BrokerManager` → real broker → `PortfolioReconciliation` (real, confirmed-working $100-threshold auto-halt) → SQLite (41 real tables) → `EventBus`/WebSocket → React SPA.
- 13 frontend widgets wired to real backend data this session, each with its own real isolated-DB integration test (33 of the 326 baseline tests are these, added this session).
- Real risk-gate audit trail: any transaction is fully reconstructable (`transactions` → `consensus_decisions` → `consensus_evidence` → `risk_assessments` → `risk_gate_results` → `trades` → `fills`).

Confirmed **not yet hardened** (this is the hardening task's actual scope, restated from `FINAL_APPLICATION_STATE_ANALYSIS.md`, re-verified against current source in Phase 0 rather than assumed carried-over):

- `RiskEngine.ts`'s order-rate-limit and portfolio-drawdown peak-equity gates: real TOCTOU races, `RiskAgent.assessRisk()` invokes `evaluateRisk()` fire-and-forget with no queue.
- `OrderManagementService`: no cancellation path, partial fills structurally unhandled, orders abandoned (not re-polled) after the 4-second fill-poll window gives up.
- Duplicate-order idempotency: check-then-act on `trades.traceId` (no unique constraint), fails open on a DB error during the check.
- `RiskEngine.ts`'s daily-loss boundary: UTC midnight, not exchange-time midnight.
- `MarketDataWorker.ts`: no duplicate-tick protection, no WS reconnect gap detection/backfill.
- AI outputs (`NewsScoringEngine`, `FundamentalAgent`, `MacroAgent`, `ChiefTraderAgent`'s debate): `JSON.parse()` with no schema/range/enum validation before the result is used.
- `GeminiProvider`/`OpenAIProvider`/`DeepSeekProvider`: hardcode their model, silently ignore `AIRouter`'s per-agent model-override mechanism.
- `FundamentalAgent`/`MacroAgent`: 24h cache gates only the raw AlphaVantage fetch, not the downstream LLM call — real, ongoing cost waste.
- `FundamentalAgent.ts`/`MacroAgent.ts`/`AlphaVantageNewsProvider.ts`/`FMPNewsProvider.ts`: API keys passed as URL query params, with a real path for a fetch-failure's caught error to leak the full URL (including the key) into `console.error` logs.
- `WebSocketContext.tsx`: no reconnect backfill against the existing durable `/api/v2/system/events`/`/api/v2/transactions` endpoints.
- `PortfolioReconciliation.ts`: no re-entrancy guard against an overlapping run; corrects `portfolio` (position) rows but never the underlying stale `trades` row.
- 4 frontend areas still fabricated: Mission Control's Granular Module Toggles (explicitly flagged HIGH RISK, Change Plan already presented, awaiting approval — not touched without it), Trading Arena's risk-decomposition widget, Learning & Evolution's Kelly-sizing/RL-post-mortem/backtest-comparison sections, plus whatever a fresh 20-tab re-scan in Phase 11 finds has drifted since the last full tally.

## 4. Planned Hardening Items (Phase 0 plan only — not yet implemented)

Restating the user's own P0→P3 ordering, with the concrete file-level approach for each item worked out in advance so each phase can proceed as a small, reviewable, tested change rather than a rediscovery exercise:

### P0 — Safety/correctness (next up: Phase 1)

1. **Risk concurrency** (`RiskEngine.ts`, `RiskAgent.ts`): introduce a single in-process async mutex/queue scoped specifically to `evaluateRisk()` invocations — not a global system-wide lock. This serializes only the risk-evaluation critical section (the peak-equity read-then-write and the order-rate-limit count-then-record), leaving market-data ingestion, agent signal generation, and portfolio reconciliation fully unserialized and unaffected. Existing gate order, thresholds, persistence, and event payloads are preserved exactly — the fix is concurrency control around the existing logic, not a rewrite of the logic itself.
2. **Order lifecycle** (`OrderManagement.ts`, `BrokerAdapter.ts`, `schema.ts`'s `trades`/`fills` tables): add a persistent pending-order follow-up mechanism (a bounded background re-poll, not unbounded polling), real `PARTIALLY_FILLED` handling that aggregates multiple real fills against one order, and a real cancellation path using the broker adapter's already-existing `cancelOrder()`.
3. **Duplicate-order idempotency**: evaluate whether a unique index on `trades.traceId` is safe to add (requires checking for any existing duplicate rows first — not yet done, will be step one of that specific change) as the primary fix, with a fail-closed application-level fallback if a DB-level constraint proves incompatible with existing data/behavior.
4. **Daily-loss timezone** (`RiskEngine.ts`): introduce one small, shared trading-timezone helper (real IANA timezone handling, not a naive UTC offset) used consistently for the daily-loss boundary; stored timestamps remain UTC, unchanged.
5. **AI output validation**: a schema-validation layer (field presence, type, enum, numeric range) applied to `NewsScoringEngine`/`FundamentalAgent`/`MacroAgent`/`ChiefTraderAgent`'s debate parse results, sitting strictly between "AI proposes" and "deterministic engines calculate" — never allowed to bypass or weaken `RiskEngine`.
6. **Secret leakage** (`FundamentalAgent.ts`, `MacroAgent.ts`, `AlphaVantageNewsProvider.ts`, `FMPNewsProvider.ts`): move API keys out of query strings where the provider supports header auth; where it doesn't, add explicit redaction before any `console.error` of a caught fetch error.

### P1 — Reliability (Phase 9-10 per the user's numbering)

7. Pending-order → real broker-state reconciliation follow-up (extends item 2 above).
8. `PortfolioReconciliation.ts` re-entrancy guard.
9. WebSocket reconnect backfill against the existing durable event/transaction endpoints.
10. Market-data duplicate-tick + reconnect-gap handling in `MarketDataWorker.ts`.

### P2 — Intelligence/cost (Phase 6-7)

11. Fix `GeminiProvider`/`OpenAIProvider`/`DeepSeekProvider` to actually honor `options.model`.
12. Real cache-key-based AI response caching for Fundamental/MacroAgent (agent + symbol + data version, not just the raw fetch).

### P3 — UI completeness (Phase 11)

13. Fresh 20-tab re-scan → `FRONTEND_REALITY_MATRIX.md`, honest-state-first, no cosmetic completion.

Each numbered item above will get its own before/after explanation, targeted diff, and test run — in the order shown — per the change-management protocol. **No implementation begins until this baseline document is reviewed.**

---

**End of Phase 0. Awaiting go-ahead before Phase 1 (risk concurrency) begins.**
