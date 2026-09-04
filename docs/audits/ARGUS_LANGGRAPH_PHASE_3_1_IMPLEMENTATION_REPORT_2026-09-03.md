# Argus LangGraph — Phase 3.1 Implementation Report (2026-09-03)

**Scope delivered: Phase 3.1 (asynchronous research execution lifecycle) only.** Phase 4A (structured research-experiment proposals) was explicitly **not** attempted in this pass — a deliberate, time-boxed scope decision, not an oversight. See §17 for the reasoning.

Evidence labels: `VERIFIED` (confirmed in source) · `TESTED` (covered by a passing automated test) · `RUNTIME VERIFIED` (observed against the actually-running system) · `UNVERIFIED` (not established) · `DEFERRED` (explicit, reasoned scope cut).

---

## 1. Executive verdict

`RUNTIME VERIFIED` The real production race identified in the Phase 3 report — a genuine LLM-backed run (11-16s) racing `server.ts`'s 15s HTTP watchdog, previously producing a reproduced-live `unhandledRejection` — is now structurally eliminated. The fix was runtime-verified against the actually-running engine: a real 11.65s LangGraph run completed correctly while the HTTP response itself returned in ~1ms, and `crash.log`'s `unhandledRejection` count stayed at exactly 123 (its pre-fix baseline) despite the run's duration being well inside the old race window. Bounded concurrency (previously configured but never enforced anywhere — confirmed by grep) is now real and tested. Restart-orphan recovery and best-effort cancellation with idempotent completion were both implemented and runtime-verified, including the specific "cancel wins the race against a late-arriving result" guarantee.

## 2. Before/after architecture

```
BEFORE (Phase 3, the confirmed defect):
  POST /research/strategy-graduation/:id
    → await runStrategyGraduationRecommendation()   [11-16s, can exceed server.ts's 15s watchdog]
    → res.json(...)                                  ← reproduced-live unhandledRejection here

AFTER (Phase 3.1):
  POST /research/strategy-graduation/:id
    → await beginStrategyGraduationRun()             [fast: DB insert only, ~1ms]
    → res.json({ status: "PENDING", runId, ... })    ← response sent, connection closed cleanly
    → void completeStrategyGraduationRun(...)         [detached: the real 11-16s LangGraph call
                                                        happens AFTER the response is already gone -
                                                        cannot race any HTTP-layer timeout]
    → GET /research/strategy-recommendations/:runId  ← existing Phase 3 read route, unchanged,
                                                        now also serves as the async result-poll target
```

## 3. Files added/modified

| File | Change |
|---|---|
| `src/server/db/schema.ts` | Added `started_at` column to `research_agent_runs` (additive) |
| `drizzle/0056_chilly_wolverine.sql` | Hand-trimmed migration (auto-generated version included unrelated destructive drift on `memory_rules`/`sessions`/`settings`/`users`, same pre-existing drift issue found and trimmed in Phase 2 — removed before applying) |
| `src/server/services/ResearchAgentRunner.ts` | Full rewrite: `beginStrategyGraduationRun`/`completeStrategyGraduationRun` split, bounded concurrency, restart recovery, `cancelResearchRun`, idempotent conditional-UPDATE pattern throughout |
| `src/server/routes/researchRoutes.ts` | POST route now async-first; new `POST /research/runs/:runId/cancel` |
| `src/server/research/researchRecommendations.ts` | `RecommendationRunStatus` extended additively |
| `scripts/argus-cli.ts` | `research-recommend` now polls the read API instead of relying on a long-lived synchronous POST |
| `src/components/StrategyResearchRecommendations.tsx` | Messaging updated to reflect PENDING being the *normal* immediate response, not a rare race outcome |
| `src/server/services/ResearchAgentRunner.test.ts` (new) | 13 tests |
| `src/server/routes/researchRoutes.strategyGraduation.test.ts` | Rewritten for the new async response shape + cancel route |
| `docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md` | Phase 3.1 section, updated limitations |

## 4. Research run state machine

```
PENDING --(begin)--> RUNNING --(LangGraph call)--> COMPLETED | FAILED | UNAVAILABLE | TIMEOUT
   |                                                                          ^
   +--(cancelResearchRun)--> CANCELLED  <----------------------------------- +  (late result: no-op)
(orphaned PENDING/RUNNING from a prior process) --> FAILED_ON_RESTART
```
`VERIFIED`+`TESTED`: every transition away from `PENDING`/`RUNNING` is a single conditional `UPDATE ... WHERE status IN ('PENDING','RUNNING')` — confirmed by direct test (`cancelResearchRun wins the race against a later completion write`) and by real runtime observation (§9).

`COMPLETED`/`FAILED`/`UNAVAILABLE` were kept as the existing Phase 2 status names (not renamed to `SUCCEEDED` as the originating spec's illustrative example used) — a deliberate choice to avoid a breaking rename of values already read by `researchRecommendations.ts`, the frontend panel, and 15 pre-existing passing tests. `RUNNING`/`TIMEOUT`/`CANCELLED`/`FAILED_ON_RESTART` are new, purely additive.

## 5. API contracts

```
POST /api/v2/research/strategy-graduation/:strategyId
  → 200 { ok, live:"NO-GO", shadowOnly:true, runId, correlationId, status:"PENDING"|"FAILED" }
     (FAILED only if the request was rejected outright, e.g. MAX_CONCURRENCY_REACHED - the slow
      path is never invoked for a request that never started)

POST /api/v2/research/runs/:runId/cancel
  → 200 { ok:true, cancelled: boolean }   (best-effort; false is a safe outcome, not an error)

GET  /api/v2/research/strategy-recommendations/:recommendationId    (existing Phase 3 route, unchanged)
GET  /api/v2/research/strategy-recommendations?strategyId=X          (existing Phase 3 route, unchanged)
```
No new "runs" resource was introduced — the existing read route already serves this purpose, per the explicit instruction not to invent a second persistence/read surface.

## 6. Persistence changes

`VERIFIED` One additive column (`started_at`). No new table. No second SQLite writer — Python remains fully stateless with respect to this table (unchanged from Phase 2/3; `langgraph-research/` still never opens `data/argus.db`).

## 7. Experiment proposal schema

`DEFERRED` — not built in this pass. See §17.

## 8. Provenance model

`VERIFIED` Unchanged from Phase 3 (`graphVersion`, `providerModel`, `provenance.fetchedAt`, `correlationId` end-to-end). Phase 3.1 adds `startedAt` to the queryable timeline, sharpening (not replacing) the existing provenance trail.

## 9. Security boundaries

`TESTED`+`RUNTIME VERIFIED` Re-confirmed unchanged: `langGraphArchitectureBoundary.test.ts` (33 tests across this + related files, all passing) still asserts zero imports of RiskEngine/OMS/BrokerManager/ChiefTraderAgent/EventBus, zero `.placeOrder(`/`emitTradeIdea(` calls, Python still has zero SQLite access and zero broker credentials. Nothing in Phase 3.1 touches any of these — it is purely an execution-lifecycle change to an already-isolated advisory service.

## 10. Anti-hallucination controls

`VERIFIED` Unchanged from Phase 3 — not in scope for Phase 3.1 (no new LLM-facing surface was added). Deferred alongside Phase 4A for the experiment-proposal work specifically (§17).

## 11. Testing results

`TESTED`: **443 test files, 3062 tests, 0 failures** (full suite, run with the live engine *stopped* — a deliberate lesson applied from earlier the same day, when running the suite concurrently with the live engine produced one flaky, since-diagnosed-and-fixed false failure in an unrelated file). Up from the pre-Phase-3.1 baseline of 442/3047 (+1 file, +15 tests). `tsc --noEmit`: clean throughout every incremental change.

New this phase: `ResearchAgentRunner.test.ts` (13 tests) — PENDING→RUNNING→terminal transitions; FAILED-envelope mapping; TIMEOUT-vs-UNAVAILABLE distinction; concurrency rejection at the configured limit; slot release on completion; idempotent completion (cancellation wins the race, verified both against a mock and, separately, live — §9 below); cancelling an already-terminal or unknown run (safe no-op); restart-orphan recovery (swept exactly once per process). `researchRoutes.strategyGraduation.test.ts` rewritten: the key new test uses a deliberately never-resolving mock for the slow path specifically to prove the route cannot be awaiting it (the test would hang/time out if it did — it doesn't).

One real, instructive false failure was found and fixed during test authoring: my first draft of the concurrency tests used a "held promise" pattern with a redundant second completion call in cleanup, which genuinely deadlocked (`Promise.all` on promises nothing would ever resolve). Root-caused to the test's own design, not the production code; rewritten to avoid any real async timing dependency (slot acquisition is fully synchronous-observable within `beginStrategyGraduationRun`, so the concurrency tests never need to actually complete a run to prove the limit).

## 12. Runtime verification

All of the following were observed against the actually-running engine (restarted to `PID 23448` to load these changes; `TRADING_ENABLED`, paper broker connected, `LIVE_NO_GO` intact throughout):

- `RUNTIME VERIFIED`: `research-recommend --strategy=MOMENTUM_BREAKOUT` — the underlying POST returned in ~1ms (confirmed via DB: `created_at` and `started_at` differ by 1ms); the real LangGraph call took **11,649.95ms**; the CLI's new polling loop correctly retrieved the COMPLETED result with a real, fully-populated recommendation (`evidenceAgeMs: 35`).
- `RUNTIME VERIFIED`: `crash.log`'s `unhandledRejection` count stayed at **123** (unchanged from before this run) — the same count observed immediately after the Phase 3 `res.headersSent` guard fix, confirming zero new occurrences despite a real run duration well inside the window that used to race the timeout.
- `RUNTIME VERIFIED`: cancellation — triggered a real run (`PULLBACK_CONTINUATION`), immediately cancelled it (`{"cancelled":true}`), confirmed the row showed `CANCELLED` with no result immediately, then waited 15 real seconds (long enough for the actual in-flight LangGraph call to finish, per the observed 6-16s range) and re-queried: **the row was still `CANCELLED`, `has_result: 0`** — the late-arriving real completion never overwrote it. This is the idempotent-completion/no-double-finalization guarantee, proven against the live system, not just a mock.
- `RUNTIME VERIFIED`: engine health post-verification — `TRADING_ENABLED`, `safeMode:false`, `marketDataConnected:true`, broker connected, unchanged.
- `UNVERIFIED` (not attempted, out of scope for this pass): a real Node-process restart mid-run to observe `FAILED_ON_RESTART` against a genuinely orphaned row from a killed process (covered by a direct unit test with a manually-inserted orphan row instead — `TESTED`, not `RUNTIME VERIFIED`, for this specific case). Restarting the live engine mid-verification specifically to kill an in-flight run was judged an unnecessary, avoidable risk this close to today's market open.
- `UNVERIFIED`: companion (LangGraph process) kill mid-run, Ollama unavailability mid-run, concurrent-requests-hitting-the-configured-limit against the *real* companion (concurrency was tested against a mock, not the live companion, for the same time-proximity-to-open reason).

## 13. Performance measurements

| Measurement | Value | Source |
|---|---|---|
| POST latency (fast path) | ~1ms | Real DB timestamps (`created_at` vs `started_at`) |
| Real LangGraph execution latency (this session) | 11,649.95ms | Real run, MOMENTUM_BREAKOUT |
| `crash.log` unhandledRejection count, before vs. after this verification | 123 vs. 123 | `grep -c` before/after |

## 14. Failure/recovery testing

`TESTED`: FAILED envelope mapping, TIMEOUT-vs-UNAVAILABLE distinction, MAX_CONCURRENCY_REACHED rejection, restart-orphan recovery (via a manually-inserted orphan row — see §12's UNVERIFIED note for the real-process-kill case).

## 15. Trading-spine isolation proof

`TESTED`+`RUNTIME VERIFIED`: unchanged from Phase 3 — zero imports/calls into RiskEngine/OMS/BrokerManager/ChiefTraderAgent/EventBus anywhere in the modified files (confirmed by the existing, still-passing `langGraphArchitectureBoundary.test.ts`); `tradingState` remained `TRADING_ENABLED` with no order/fill/position change throughout every verification step in §12.

## 16. Strategy-lifecycle isolation proof

`VERIFIED`: no file touched in this phase imports or writes to `StrategyEngine.ts`'s arrays or `promotionEngine.ts`'s lifecycle derivation. Unchanged from Phase 3.

## 17. Remaining limitations

- **Phase 4A (structured experiment proposals) was not implemented in this pass.** Reasoning: this session's remaining time before today's market open (identified mid-session) was better spent finishing Phase 3.1 thoroughly — including catching and fixing a real test-design deadlock, and running full, real runtime verification including the cancellation race — than starting Phase 4A's anti-hallucination-validated schema shallowly under the same time pressure. Phase 4A remains fully specified (the schema, validation, and safety requirements from the originating spec) and is a clean, well-scoped next unit of work.
- Cross-process cancellation-vs-in-flight-kill and companion/Ollama-failure-mid-run were tested via mocks, not against the real companion process, for the reason stated in §12.
- No distributed queue/broker was introduced (Redis/Kafka/Celery/Temporal) — correctly not needed; a single in-process counter is sufficient for a single-Node-process orchestrator, per the explicit instruction not to over-engineer this.

## 18. Rollback procedure

1. Revert `src/server/routes/researchRoutes.ts`'s POST handler to await `runStrategyGraduationRecommendation` directly (the function still exists, unchanged in behavior, as the kept synchronous convenience wrapper) and remove the cancel route.
2. Revert `scripts/argus-cli.ts`'s `research-recommend` to its pre-Phase-3.1 direct-await form.
3. The `started_at` column is inert if unused — no down-migration is required to disable this phase; only remove it if fully decommissioning.
4. `ResearchAgentRunner.ts` can be reverted to its Phase 3 version wholesale; no other file has a hard dependency on the new exports beyond the two call sites above.

## 19. Exact configuration

No new config keys were required — `config/langGraphResearch.json`'s pre-existing `maxConcurrentRuns` is now the sole configuration surface for this phase's new behavior (enforced, previously unenforced).

## 20. Explicit list of what Phase 4B/5 still do NOT exist

- No experiment-proposal schema, generation, or validation (Phase 4A itself, deferred — see §17).
- No deterministic validation-job execution triggered from a recommendation (Phase 4B).
- No promotion-gate integration — a recommendation, cancelled run, or any other artifact from this service still cannot mutate `StrategyEngine.ts`'s arrays or `promotionEngine.ts`'s lifecycle state, directly or indirectly (unchanged, re-verified this phase).
- No autonomous self-improvement, closed-loop learning, or LLM-driven strategy mutation of any kind (Phase 5).

---

## Evidence summary

```
VERIFIED:    Route/runner code changes; state-machine design; API contracts; rollback procedure
TESTED:      443 files / 3062 tests full suite; 13 new ResearchAgentRunner tests; rewritten route test
RUNTIME VERIFIED: Fast POST (~1ms) + real 11.65s LangGraph completion; crash.log unchanged at 123;
             live cancellation winning the race against a real late-arriving completion; engine
             health/trading-state unaffected throughout
UNVERIFIED:  Real process-kill mid-run (FAILED_ON_RESTART tested via mock only); companion-kill and
             Ollama-unavailability mid-run tested via mock only, not against the real companion
DEFERRED:    Phase 4A (experiment proposals) - explicit, reasoned scope cut, not attempted shallowly;
             Phase 4B/5 - unchanged, not started
```
