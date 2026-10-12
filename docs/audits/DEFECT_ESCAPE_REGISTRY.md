# Defect Escape Registry

**Machine-readable source of truth:** `defect-escape-registry.json` (same directory, schema `version: 1`).

## What it is

The defect-escape registry is the permanent ledger of every defect that reached
production (`detectedIn: "prod"`), regardless of whether it was caught by an
operator, an audit, or a forensic pass. Each entry records the severity, the
root cause, the fix reference, and — critically — the regression test that
prevents the defect from escaping again.

## The rule

**Every prod escape gets a regression test, and the pre-market suite enforces it.**

- The suite fails if a registry entry is missing a `regressionTest`.
- Tests must assert causal / negative / boundary / failure behavior, not `toBeDefined()`
  (per the engineering standard in `AGENTS.md`: "Tests prove behavior").

Status semantics:

| Status | Meaning | Enforcement |
|---|---|---|
| `fixed` | Fix **and** regression test exist on THIS branch | Enforced green — the test must be present and passing |
| `fixed-elsewhere` | Fix + test landed on a sibling branch | Verified at merge (warn only, no hard block) |
| `open` | Defect unresolved or only partially mitigated | Regression test must exist; TDD-red (failing test) is allowed while the defect is open |

## Entries (2026-10-12)

### P0 — `event-loop-stall-20261012` — OPEN

~3-minute event-loop freeze 13:32–13:35 ET on prod PID 7244; `/health` timeouts,
CPU ~10%, self-recovered. **Cause UNKNOWN** — candidates: `v8.writeHeapSnapshot`
(`heapSnapshotEnabled=false` in the shipped config; needs a deploy-side check)
and a synchronous better-sqlite3 commit tail.

- Fix: **open**
- Regression test: `pending:src/server/observability/eventLoopStallMonitor.test.ts`
  (being added by stall-mitigation work)

### P0 — `toggle-bounds-bypass-20261012` — FIXED-ELSEWHERE

`POST /api/v1/autobot/toggle` bypassed `validateSettingsBounds`, allowing
unbounded risk-parameter mutation.

- Fix: branch `fix/oct12-hunt-defects` (item H1)
- Regression test: pending — test added on that branch; verify both at merge (warn only)

### P1 — `guard-expiry-race-20261012` — FIXED

ConfluenceCoordinator's 10-minute in-flight guard replaced still-running
evaluations (CAT: 11.5-minute overlap on a 25-minute evaluation).

- Fix: `486d51f` — generation-token `isLiveCheck` emission fence
- Regression test: `src/server/services/ConfluenceCoordinator.quantInflight.test.ts`
  — verified present in the tree on this branch (covers the fence)

### P1 — `intraday-provider-backlog-20261012` — OPEN

Intraday fetch timeout rate 76.5%→54.6%. Commit `b842ef5` bounds the wait with a
real timeout, but the data still doesn't arrive — mitigation, not a fix.

- Fix: **open**
- Regression test: pending — chaos-provider test being added

---

*Boundaries: PAPER_ONLY, LIVE_NO_GO. The registry is audit documentation only; it
changes no runtime behavior.*
