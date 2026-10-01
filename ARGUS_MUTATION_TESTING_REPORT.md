# ARGUS — Safety-Critical Mutation Testing Report

**2026-09-30. Adversarial Synthetic Market & Trading Validation Framework, §30.**
PAPER_TRADING_ONLY / LIVE_NO_GO unchanged throughout. No LIVE order placed. No trading threshold,
RiskEngine policy, consensus threshold, strategy logic, or calibration value was changed. Mutation
testing operated entirely against local test infrastructure — no network, no broker connectivity.

**Headline finding:** the installed automated mutation-testing tool (Stryker + its Vitest runner)
produced **demonstrably unreliable** survivor/coverage data for this stack. Two of its "Survived"
labels were independently proven false by hand — the mutated code was, in fact, already caught by
existing tests. Rather than report a mutation-score percentage built on a tool shown to be wrong,
this pass pivoted to **direct, hand-applied mutation testing**: for each targeted safety guard, the
exact mutation was applied to the real source file, the real test suite was run against it, the
result was recorded, and the file was restored. This is slower per mutant but every result below is
independently trustworthy — confirmed by actually running the tests, not by trusting a report.

---

## 1. Infrastructure audit and tool selection

No mutation-testing framework existed in this repo before this task (confirmed: no `stryker.conf.*`,
no `@stryker-mutator/*` dependency, searched `package.json`/`src/`/`scripts/`/`config/`).

**Selected:** `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, both `^10.0.0`. This is the
de facto standard mutation-testing tool for JavaScript/TypeScript and the only one with a maintained,
purpose-built Vitest runner (this repo's actual test framework) — no realistic alternative was found;
Jest-oriented mutation tools would require a second test runner just for mutation testing, which is a
larger and worse change than using the Vitest-native one.

**Expected runtime / CI implications (as planned):** scoped mutation runs over small, pure files
(~30–60s per file-set) were expected to be fast enough for an explicit `npm run test:mutation`
command, deliberately kept out of `test:tier1` (every commit) per §15/§16 of the task — matching
what shipped.

### 1a. The tool defect found

- First symptom: an isolated single-file run (`liveOrderAuthorization.ts` alone) crashed with
  *"Vitest failed to find test files related to mutated files"* — Vitest's own `--related`
  dependency-graph heuristic failed to associate the file with `liveReadiness.test.ts`, which
  statically imports and calls every exported function in it.
- Disabling `vitest.related` (confirmed via the installed package's own JSON schema and source,
  `node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js`) fixed the crash but
  **did not fix the underlying coverage attribution**: in the combined 3-file run,
  `liveOrderAuthorization.ts` reported **0/81 mutants covered** regardless of
  `coverageAnalysis: 'perTest' | 'all' | 'off'` — all three modes produced byte-identical results,
  which is itself diagnostic (coverage mode should never be irrelevant to the result).
- Independent, direct proof the "0% coverage" was false: `liveReadiness.test.ts`'s own last test
  calls `authorizeProductionOrder({ tradingMode: 'LIVE', paperMode: false })` — a concrete, static,
  unconditional call into the exact code Stryker reported as never executed.
- A second, independent false survivor was then found in `brokerEnvironment.ts`: Stryker reported the
  mutation `if (mode === 'LIVE' && paper === false)` → `if (mode === 'LIVE' || paper === false)` as
  **Survived**. Hand-applying this exact mutation and running `liveReadiness.test.ts` +
  `propertyInvariants.test.ts` **failed 3 tests** — the mutation is very much caught.

Two independent false positives across two different files is enough to disqualify the tool's raw
numbers for this run. **No mutation score, survivor count, or "no coverage" claim from the Stryker
JSON/HTML report in this repo should be treated as ground truth without independent confirmation.**
The `stryker.conf.mjs` / `vitest.mutation.config.ts` / `npm run test:mutation` infrastructure is kept
(it is real, working plumbing, and a future Stryker/Vitest version may fix this), but this report's
actual safety conclusions below come from the manual campaign, not from that tool's own scoring.

*(Unrelated to the tool itself: the first Stryker run exhausted the host disk — 185GB of unrotated
daily DB backups in `data/backups/`, pruned to a 7-day retention with explicit operator approval
before this work continued. Noted here only because it happened during this phase; it is a disk
operations issue, not a testing-framework finding.)*

---

## 2. Mutation scope (risk priority order, as specified)

| Priority | Domain | File(s) | Method |
|---|---|---|---|
| 1 | RiskEngine | — | **Not reached this pass** (see §9, remaining gaps) |
| 2 | OMS / idempotency | `src/server/services/fillLedger.ts` | Manual (1 mutation) |
| 3 | LIVE_NO_GO / trading-mode guards | `src/server/core/{brokerEnvironment,tradingModeEnv,liveOrderAuthorization}.ts` | Stryker (auto, discarded) + Manual (4 mutations) |
| 4 | BrokerManager routing | — | **Not reached this pass** |
| 5 | Reconciliation | — | **Not reached this pass** |
| 6 | Evidence independence | `src/server/services/evidenceIndependence.ts` | Manual (2 mutations) |
| 7 | Calibration safety | — | **Not reached this pass** |

UI, formatting, CLI rendering, documentation, generic helpers, and low-risk observability code were
correctly excluded by design — never considered in scope.

---

## 3. Manual mutation campaign — results

Every row: real mutation hand-applied to the real file, real test suite run, real result recorded,
file restored via `git checkout --` before the next mutation. None of these were run concurrently
with each other or with any other work.

| # | Domain | File:line | Mutation | Result | Classification |
|---|---|---|---|---|---|
| 1 | LIVE_NO_GO | `liveOrderAuthorization.ts:44` | `if (isPaperTradingOnlyEnforced())` → `if (!isPaperTradingOnlyEnforced())` (bypass the PAPER_TRADING_ONLY lock) | `liveReadiness.test.ts` failed (1 test). **`propertyInvariants.test.ts` did NOT catch it on the first attempt** | **MISSING_TEST → fixed** (see §4) |
| 2 | LIVE_NO_GO | `liveOrderAuthorization.ts:51-52` | `if (!arm.ok)` → `if (arm.ok)` (bypass the live-arm confirmation gate) | `liveReadiness.test.ts` failed (1 test, caught via the downstream `evaluateLiveReadiness()` still returning LIVE_NO_GO) | DEAD_CODE for this scenario / real coverage exists |
| 3 | LIVE_NO_GO | `liveOrderAuthorization.ts:55-56` | `if (!ready.ok)` → `if (ready.ok)` (the most severe mutation tested — makes a LIVE order return `ok:true` outright when live-readiness evidence fails) | `liveReadiness.test.ts` failed (1 test) | Covered — real test exists |
| 4 | Evidence independence | `evidenceIndependence.ts:51` | `new Set(['QuantEngine','JavaCoreEnsemble'])` → `new Set([])` (correlated producers incorrectly become independent) | `evidenceIndependence.test.ts` failed (1 test) | Covered — real test exists |
| 5 | Evidence independence | `evidenceIndependence.ts:64` | `return agentName;` → `return CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP;` (every genuinely independent agent incorrectly merges into one group) | `evidenceIndependence.test.ts` failed (2 tests) | Covered — real test exists |
| 6 | OMS / idempotency | `fillLedger.ts:46` | `if (newQty <= 1e-9)` → `if (newQty > 1e-9)` (the exact `<=`→inverted boundary class the task calls out) | `fillLedger.test.ts` failed (3 of 11 tests) | Covered — real test exists |

**6/6 hand-applied mutations were caught by the existing (or, for #1, the newly-strengthened) test
suite.** This is real, trustworthy evidence — not a mutation-tool score.

### Release-critical question, directly answered

> A surviving LIVE_NO_GO mutant is RELEASE_BLOCKER.

**None of the 3 hand-tested LIVE_NO_GO mutations survived.** Mutation #3 (bypassing the live-readiness
check entirely, returning `ok: true` for a LIVE order with failing evidence) is the single most
dangerous mutation tested in this whole pass, and it was caught cleanly by the existing
`liveReadiness.test.ts`.

---

## 4. Real test-quality defect found and fixed (the most valuable finding, per §17)

**`propertyInvariants.test.ts`'s "LIVE_NO_GO cannot be bypassed" property was passing vacuously.**

Its generator used a bare `fc.option(fc.string(), { nil: undefined })` for `tradingMode`. Over
fast-check's effectively unbounded string domain, the probability of randomly generating the exact
literal `"LIVE"` needed to exercise the property's own `if (result.environment === 'LIVE') { ... }`
branch is approximately zero. **500 random runs essentially never executed the assertion the test
exists to make.** This was caught only because mutation #1 above was applied and the property *still
passed* — a real, load-bearing LIVE_NO_GO property test was not actually testing anything.

**Fix applied** (test-only; zero production code changed): replaced the bare `fc.string()` generator
with `fc.oneof(fc.constantFrom('LIVE', 'PAPER', 'Live', 'paper', 'SIMULATOR', '', 'UNKNOWN', ...), fc.string())`
across all three properties in the file, so the interesting literal values are reliably sampled
alongside genuine random/garbage input. Added an explicit `liveBranchHits` counter with
`expect(liveBranchHits).toBeGreaterThan(0)` so this exact failure mode (an assertion that silently
never fires) cannot regress to vacuous again without the test itself failing.

Re-running mutation #1 after the fix: **`propertyInvariants.test.ts` now fails it too** (counterexample
`["LIVE", false]`, found in 94 of 500 runs) — confirmed, not assumed.

**Fixing this exposed a second, independent weak assertion** in the same file (the broker-environment
classification property): it asserted `paperMode === true || paperMode === 1` for a `'PAPER'`
classification, but `normalizePaperMode()`'s real contract is broader — it coerces *any* non-null,
non-`false`/`0` value truthy (e.g. `paperMode: -1` genuinely classifies as PAPER). The property's
assertion was simply wrong about the real contract, not a production bug; corrected to match
`brokerEnvironment.ts`'s actual documented behavior.

**No production code was modified to make any test pass.** Both fixes were test-only, and in both
cases the production code's behavior was independently confirmed correct first.

---

## 5. Mutation score by domain

Per the explicit instruction not to report one meaningless repository-wide number:

| Domain | Mutants (auto, unreliable) | Mutants (manual, reliable) | Manual: killed | Manual: survived |
|---|---|---|---|---|
| RiskEngine | — | 0 | — | — |
| LIVE_NO_GO | 81 (discard — tool bug) | 3 | 3 | 0 |
| OMS / idempotency | — | 1 | 1 | 0 |
| BrokerManager routing | — | 0 | — | — |
| Reconciliation | — | 0 | — | — |
| Evidence independence | — | 2 | 2 | 0 |
| Calibration | — | 0 | — | — |
| Trading-mode classification (`brokerEnvironment`/`tradingModeEnv`, supporting LIVE_NO_GO) | 87 (discard — tool bug, ≥2 proven false) | 1 (spot-check) | 1 | 0 |

The 349 auto-generated mutants across the 3 LIVE_NO_GO files were **not individually hand-verified**
beyond the 2 spot-checks that disproved the tool's reliability — with the tool shown unreliable, the
remaining ~165 untouched auto-flagged "survivors" are **neither confirmed real gaps nor confirmed
false positives**. They should not be cited either way until re-run against a fixed tool version or
individually hand-verified.

---

## 6. Risk-weighted success criteria — answered directly

- **No surviving mutant capable of bypassing LIVE_NO_GO:** confirmed for the 3 mutation classes
  tested (environment lock, live-arm, live-readiness). Not exhaustively proven for every line in the
  3 trading-mode files (tool unreliable for broader coverage claims).
- **No surviving mutant capable of duplicating a fill:** confirmed for the exact `<=` boundary
  mutation tested.
- **No surviving mutant capable of turning correlated evidence into independent evidence (or vice
  versa):** confirmed, both directions.
- **Bypassing RiskEngine rejection, duplicating an order, rerouting an existing order, corrupting
  reconciliation:** **not tested this pass** — see §9.

---

## 7. Explicit answers (as required)

- **Would the current tests detect a RiskEngine regression?** Not evaluated this pass. The earlier
  Section-1 infrastructure audit (same task, same day) found ~21-25 of 25 gates have dedicated
  boundary tests by direct file inspection (and a follow-up correction found all 25/25 do), but no
  mutation evidence was gathered against `RiskEngine.ts` itself.
- **Would they detect a LIVE_NO_GO bypass?** **Yes**, for the 3 concrete bypass mechanisms tested
  (environment-lock, arm-confirmation, readiness-evidence) — one of them only after a real test-quality
  fix made in this pass (§4).
- **Would they detect duplicate order submission?** Not independently re-verified this pass (the
  Section-1 audit found `failureInjectionSuite.test.ts` already covers duplicate-order concurrency via
  a DB unique index — not re-confirmed by mutation here).
- **Would they detect duplicate fill accounting?** **Yes**, confirmed directly.
- **Would they detect cross-broker rerouting?** Not independently re-verified this pass (the
  Section-1 audit found `OrderManagement.crashRecovery.test.ts` already has a dedicated cross-broker
  safety test — not re-confirmed by mutation here).
- **Would they detect evidence-independence corruption?** **Yes**, confirmed in both directions.
- **Would they detect calibration bypass?** Not evaluated this pass.

---

## 8. Performance

- Stryker scoped run (3 files, 349 mutants, `concurrency: 2`): ~30 seconds wall time — but with
  unreliable per-mutant results, this number does not represent real mutation-testing throughput.
- Manual campaign: 6 mutations × (1 file edit + 1 targeted `vitest run` + 1 revert) ≈ under 2 minutes
  total, each individually fast (under 3 seconds per targeted test run).
- Mutation testing is **not** part of `test:tier1` (every commit) or `test:golden`. It is its own
  explicit command.

---

## 9. CI integration

Added, without changing any existing tier:

```
npm run test:mutation   # stryker run (scoped to the 3 LIVE_NO_GO/trading-mode files for now)
```

`test:tier1`, `test:tier3`, `test:tier4`, `test:golden` are byte-for-byte unchanged. Suggested model
(not yet wired into actual CI/scheduling, since this repo's CI is a single GitHub Actions job today):
Tier 1 every commit, Tier 1 + golden on PR, mutation on a pre-release/scheduled cadence, Tier 4 (soak)
long-scheduled.

---

## 10. Full regression

Baseline before this phase: 602 files / 4,640 tests.
Full suite re-run after this phase's one real change (the `propertyInvariants.test.ts` strengthening
— a test file, not production code):

**602 files / 4,640 tests, all passing, exit code 0 — identical to baseline, zero regressions.**
(Run start 20:43:16, duration 669.73s.)

Clean TypeScript typecheck: confirmed (`tsc --noEmit`, zero errors) both before and after the test
file change.

---

## 11. Remaining safety gaps (honest, not glossed over)

- **RiskEngine.ts and OrderManagement.ts — the two highest-priority domains per this task's own
  ordering — were not mutation-tested at all this pass**, neither by the (unreliable) automated tool
  nor manually. This is the single biggest gap left by this phase.
- BrokerManager routing (cross-broker immutability), reconciliation (MISMATCH→MATCH corruption), and
  calibration safety logic were not touched this pass.
- The Stryker/Vitest coverage-attribution bug is unresolved and unreported upstream as of this
  writing — a future dependency bump may or may not fix it; re-verify before trusting its output again.
- ~165 Stryker-flagged "survivors" across the 3 LIVE_NO_GO files remain unclassified (neither
  confirmed real nor confirmed tool artifacts).

## 12. Next recommended phase

Per this task's own instruction to base the recommendation on actual findings, not proceed
automatically: **continue mutation coverage (option B), specifically into RiskEngine.ts and
OrderManagement.ts** — the two top-priority domains this pass did not reach — using the same manual,
hand-verified methodology (the automated tool cannot be trusted for this repo's stack as configured).
External-boundary fuzzing (option A) is reasonable future work but is lower-priority than closing the
#1 and #2 risk-ranked domains that remain completely unexamined.

Stopping here per instruction — not continuing automatically into fuzz testing.
