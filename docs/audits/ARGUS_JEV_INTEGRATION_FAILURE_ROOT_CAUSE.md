# ARGUS Jev integration: why it was idle, what was missing, what is now proven (2026-10-15)

Status in the three-level scheme: **Implemented: YES. Integrated in code: YES (present in production SHA `32613911`). Operationally verified: YES in isolation (one real authenticated call, 2026-10-15), NO in production** (the feature flag is off there, so production Jev activity is still zero). Per the strict completion rule this is **not "complete"**: the exact incomplete stage is *production activation and observation of real events*. Jev has no influence on consensus, RiskEngine, OMS or any order, by design and by test.

## 1. Why Jev was idle in production [VERIFIED]
1. `kickOffJevShadowScoring()` begins with `if (!isJevShadowEnabled()) return;` (`src/server/news/JevNewsTriage.ts`), and `isJevShadowEnabled()` is true only when `ARGUS_JEV_SHADOW_SCORING_ENABLED === 'true'`. That flag defaults to **false** (`.env.example`). The production `.env` contains `JEV_API_KEY` but **no `ARGUS_JEV_*` entries at all** (verified by grep on 2026-10-15). So every article returns at the first line: zero requests, zero ledger rows, an empty calibration report.
2. The Phase 2 path (`ARGUS_JEV_ESCALATION_ENABLED`, `NewsEngine.tryJevFirstAnalysis`) is likewise off by default and not enabled.
3. The AI call governor itself is enabled for Jev (`config/aiCallGovernor.json`: `aiGovernorEnabled: true`, `jevEnabled: true`), and the caller **is** wired: `NewsEngine.ts` calls `kickOffJevShadowScoring` per processed article; the shadow orchestrator calls `AICallGovernor.request({capability:'STRUCTURED_DECISION', kind:'jev_news_shadow_scoring'})` (since `c991233a`); on success it calls `recordShadowScore`.
**Correction of my own earlier statement today:** I told you the caller was "reportedly not wired". That came from a stale header comment in `src/server/ai/JevDecisionProvider.ts` ("Called By: Future: AICallGovernor event-driven enrichment (not wired yet)") which predates the wiring commits. The code path is wired; the shadow flag is what is off. That stale comment is a hazard and should be fixed in the same release.

## 2. History (git, with SHAs)
| SHA | Date | What |
|---|---|---|
| `70de26c3` | 2026-10-05 | Research spike: Jev adapter "not wired to any live path" |
| `b3ca941b`, `3bfadb47` | 2026-10 | Design docs (news-triage plan; AI-as-enhancement boundaries) |
| `724f8bbf` | 2026-10-06 | Phase 1: shadow news scoring + agreement ledger, **"flagged OFF, never touches trading"** (in production SHA: yes) |
| `64670683` | 2026-10-06 | Phase 2: confidence-gated escalation, flagged OFF |
| `78e4f831` | 2026-10 | Phase 3: widening hooks + calibration observability, "all inert" |
| `1a6e0d85`, `3a70d3ff`, `3d7d9105`, `eadfb1b6` | 2026-10-08 | JevDecisionProvider, AICallGovernor, event-driven advisory wiring, architecture-prohibition/failure tests |
| `c991233a` | 2026-10 | Governor-route Jev shadow scoring (budget, cache, singleflight, circuit breaker) |
| `02217be3` | 2026-10-11 | `NewsEngine.tryJevFirstAnalysis` routed through the governor (in production SHA: yes) |
| `86d28e5e`, `e7a0dc9a` | 2026-10 | Jev architecture doc / "Jev certification" merge |
Every delivery commit states that the feature is flagged OFF. I cannot reconstruct what was said verbally in earlier sessions (not available in this context); what the repository shows is that the work delivered **was implemented and unit-tested, and never switched on or watched with a real event.**

## 3. Why the tests passed without proving the workflow [VERIFIED]
* `src/server/news/JevShadowLedger.test.ts` states in its header: "DB round-trips are intentionally NOT tested (sandbox has no migration runner in unit tests)". The one boundary that decides whether the calibration report ever fills was untested.
* The provider and governor tests use mocked fetch/fake providers; none crossed event consumer -> governor -> provider HTTP -> validation -> ledger -> report.
* `releaseCertificationDriver.ts` checks `JevDecisionProvider.isConfigured()` (key presence) and schema probes - evidence of configuration, not of a request.
* Nothing surfaced "configured but receiving zero events" to an operator.

## 4. Real end-to-end proof (isolated; one authenticated call) [VERIFIED 2026-10-15 ~10:15 ET]
`scripts/forensic/jevE2eProof.ts` ran the production code path against a throwaway SQLite file (`ARGUS_DB_PATH`), with one genuine recent article read (SELECT only) from production news storage: NOK, GlobeNewswire, published 14:00Z. Result (`docs/audits/jev_evidence/jev_e2e_proof_result.json`):
* event -> `kickOffJevShadowScoring` -> governor approval -> **authenticated HTTPS call to the real Jev API** -> valid response -> schema validation -> `jev_shadow_scores` row -> `getCalibrationSummary`: all succeeded.
* Model reported by the API: `jev-1.13.0` (alias `jev-latest` resolves to it). Latency 393 ms. Input tokens 856. Estimated cost at the vendor list price (0.042 USD / 1M input tokens): ~$0.000036 per article (an estimate; billing records were not checked).
* No-input behavior: an article with an empty body produced no request and no row.
* The proof also exposed a **real defect**: a second call for the same (article, symbol) hit the governor cache and wrote a **second ledger row**, doubling scored-article, token and cost counts (`rowsAfterDuplicate: 2`).

## 5. Changes made (branch `dev/storage-redesign`, merged to `main`; production not changed)
1. **Fix:** `recordShadowScore` records one observation per (article fingerprint, symbol) (`src/server/news/JevShadowLedger.ts`). Regression test fails before the fix ("expected 2 to be 1") and passes after.
2. **Visibility:** `getJevShadowStatus()` (`JevNewsTriage.ts`) and the `jev-calibration` report/route now state `shadow scoring: ACTIVE` or `IDLE - <first blocking reason>` (flag off / no key / governor Jev disabled), so a configured-but-idle provider is no longer indistinguishable from a healthy one.
3. **Permanent end-to-end test:** `src/server/news/JevShadowIntegration.e2e.test.ts` (6 tests) drives the real consumer, governor, provider HTTP client, validation, migrated SQLite ledger and calibration summary against a local HTTP stand-in for the Jev server (documented wire format). It asserts: authenticated request sent and row persisted and reported; duplicate recorded once; no-input sends nothing; HTTP 500 and malformed response are non-blocking and write nothing; **flag unset reports IDLE and sends nothing (the production state)**; full outage never blocks or throws in the caller. A stand-in server is a regression guard, not proof of the real provider - section 4 is that proof.
4. Tests: 31 files / 248 tests pass across `src/server/news`, the governor/Jev provider/call-reduction/hot-path-prohibition suites and the observability route; `tsc --noEmit` clean.

## 6. Architecture (unchanged by this work)
NewsEngine (real articles) -> `kickOffJevShadowScoring` (fire-and-forget, never throws, never awaited by the news cycle) -> `AICallGovernor` (budget `jevCallsPerMinute` 20, `aiPerSymbolCallsPerMinute` 4, `jevMaxInFlight` 4, queue 32, 8 s timeout, circuit breaker, cache) -> `JevProvider` -> `recordShadowScore` -> `jev_shadow_scores`. The ledger is write-only; nothing in consensus, sizing, RiskEngine, OMS or brokers reads it (`jevCannotCauseOrder.test.ts`, `hotPathProhibition.test.ts`).

## 7. What is still needed before this can be called complete
1. A certified release containing these changes (nothing deploys from `main` automatically; production remains on `32613911`).
2. After owner-approved deployment: set `ARGUS_JEV_SHADOW_SCORING_ENABLED=true` (an env change needs a controlled restart) under the existing governor budget (worst case ~20 calls/min x ~850 tokens is ~$0.30 per 6.5-hour session at list price), then **observe real production rows** via `argus jev-calibration` (it now says ACTIVE/IDLE and why). Until a production row exists, the correct status is "incomplete at production activation".
3. Open research questions (none answered by this work): Jev's accuracy against independently verified labels, calibration, and incremental information beyond existing agents. The ledger's LLM-agreement comparison is currently empty because the LLM side runs only when escalated and most AI providers are offline; agreement with an LLM is not correctness. Jev must stay SHADOW_ONLY and outside consensus until separately evidenced, authorised and approved. Recommendation today: **KEEP_SHADOW** (not yet earning more).
4. Fix the stale header comment in `JevDecisionProvider.ts`.

## 8. Standing acceptance rule proposed for every agent/provider
"Integrated" requires evidence that real events reach it and its results reach the intended destination, and a zero-event agent must state why (disabled flag, no eligible input, governor refusal, outage) in an operator-visible report. This work adds that for Jev only; the other agents are not yet audited against the rule.
