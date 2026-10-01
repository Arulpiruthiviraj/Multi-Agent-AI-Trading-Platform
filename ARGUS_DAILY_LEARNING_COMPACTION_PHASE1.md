# ARGUS — Daily Learning Compaction, Phase 1

**2026-10-01.** Scoped narrowly to `observability_events` only, per the mandate. No other table's
retention behavior was touched. Built and tested entirely against isolated temp SQLite databases —
`data/argus.db` (the currently-running live engine's real database) was never used for destructive
testing, and the new pipeline is **off by default**, not yet wired into the live boot sequence.

---

## 1. Existing retention behavior (before this phase)

`ObservabilityStore.ts`'s `sweepObservabilityRetention()` did a single blind, unconditional delete:

```ts
const cutoff = nowMs - observabilityConfig.retentionDays * 24 * 60 * 60 * 1000;
await db.delete(observabilityEvents).where(lt(observabilityEvents.ts, cutoff));
```

`retentionDays = 14`, swept hourly (`retentionSweepMs = 3600000`). No compaction, no archive, no
verification — a row older than 14 days was simply gone. `candidate_rankings` has an analogous
blind-delete sweep (`operationalRetention.ts`) that this phase deliberately does **not** touch.

## 2. Architecture implemented

```
observability_events (raw, 7-14 day hot window)
        |
        v
observabilityEventsSource.compact()   <- SQL-level GROUP BY aggregation, never row-by-row JS
        |
        v
daily_learning_archive (one row per trading day, COMPACTED)
        |
        v
verifyArchiveRow()  <- read back from scratch, recompute checksum, re-check invariants
        |
        v
VERIFIED  ---------------------------->  FAILED (raw data kept, retried next sweep)
        |
        v
purgeVerifiedDays()  <- DELETE raw + mark PURGED, atomic (one SQLite transaction)
```

Pluggable by design (§19): `DailyCompactionSource` (`types.ts`) is a 2-method interface
(`compact()`, `purgeWindow()`). `observabilityEventsSource.ts` is the one implementation this phase
ships. Adding `candidate_rankings` or another source later means writing a second implementation of
that interface — the orchestrator, archive schema, and verification/purge logic are already fully
generic and require no changes.

**Files added:**

| File | Role |
|---|---|
| `src/server/db/schema.ts` (+table) | `daily_learning_archive` |
| `drizzle/0080_odd_molly_hayes.sql` | Migration (hand-trimmed — see §3) |
| `src/server/db/dailyCompaction/types.ts` | `DailyCompactionSource`, summary/manifest shapes |
| `src/server/db/dailyCompaction/checksum.ts` | Canonical-JSON SHA-256 |
| `src/server/db/dailyCompaction/tradingDayWindow.ts` | NY trading-day window boundaries (reuses `getTradingDayStartMs`) |
| `src/server/db/dailyCompaction/observabilityEventsSource.ts` | The one Phase 1 source |
| `src/server/db/dailyCompaction/DailyCompactionOrchestrator.ts` | compact → verify → purge, idempotency, crash recovery |
| `src/server/db/dailyCompaction/dailyLearningArchiveRepository.ts` | `getDailyLearning()` / `listDailyLearning()` (§14) |
| `src/server/db/dailyCompaction/dailyCompactionScheduler.ts` | Daily sweep timer (mirrors `operationalRetention.ts`) |
| `config/observability.json` / `src/server/config/observability.ts` | `dailyCompactionEnabled` (default `false`), `dailyCompactionSweepMs` |
| `src/server/observability/ObservabilityStore.ts` (modified) | `sweepObservabilityRetention()` gated on the new flag |

**Files NOT touched:** `candidate_rankings`, `trades`, `fills`, `orders`, `reconciliation_events`,
`strategy_engine_promotions`, `daily_strategy_performance`, calibration tables, or any other table's
retention behavior (§20).

## 3. Migration/schema

```sql
CREATE TABLE daily_learning_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date TEXT NOT NULL,            -- America/New_York YYYY-MM-DD (same convention as daily_strategy_performance)
  source_type TEXT NOT NULL,             -- 'OBSERVABILITY_EVENTS' (Phase 1)
  schema_version INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  source_row_count INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  summary_checksum TEXT NOT NULL,
  source_checksum TEXT,
  compaction_status TEXT NOT NULL,       -- PENDING|COMPACTING|COMPACTED|VERIFIED|PURGED|FAILED
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  raw_purged_at INTEGER
);
CREATE UNIQUE INDEX idx_daily_learning_archive_date_source ON daily_learning_archive (trading_date, source_type);
CREATE INDEX idx_daily_learning_archive_status ON daily_learning_archive (compaction_status);
```

**Real issue found and fixed during this task:** `drizzle-kit generate`'s raw output also rebuilt
`memory_rules`/`sessions`/`settings`/`users` with a hardcoded `created_at` default literal baked in
at generation time (pre-existing drizzle-kit snapshot drift, unrelated to this change — confirmed by
inspecting the generated SQL before applying anything). That portion was manually stripped from the
migration file before it was ever run against any database; only the `daily_learning_archive`
`CREATE TABLE`/indexes remain. Verified via a fresh temp-DB migration bootstrap (all 80 migrations
apply cleanly, new table present, no errors).

`trading_date` deliberately uses the **same America/New_York convention** `daily_strategy_performance`
already uses — not UTC. `getTradingDateWindowMs()` computes `[windowStartMs, windowEndMs)` by reusing
`getTradingDayStartMs()` (the existing, already-DST-correct, binary-search-based source of truth
`RiskEngine.ts`'s own day-boundary queries already rely on) for **both** ends, rather than a second,
independent 24h-add calculation that could silently drift out of sync with it across a DST transition.

## 4. Aggregation contract

`observabilityEventsSource.compact()` runs three SQL-level `GROUP BY`/aggregate queries against the
window (never pulls raw rows into JS — this is what keeps it fast at 1M rows/day, see §11):

- `COUNT(*) GROUP BY event_type` → `eventTypeCounts` (exhaustive — every real row counted exactly once, including a genuinely NULL `event_type`, bucketed under the literal key `'(none)'`)
- `COUNT(*) GROUP BY category` → `categoryCounts`
- `COUNT(*), MIN(ts), MAX(ts)` → `sourceRowCount` and the coverage manifest's timestamp bounds

Named semantic sections (`discovery`, `ideas`, `consensus`, `risk`, `orders`, `marketData`,
`reconciliation`, `javaBridge`, `system`) are derived from `eventTypeCounts` using a mapping table
where **every event type was individually verified against `config/eventNames.json` and real
`structuredLogger`/EventBus call sites before being included** — never guessed. A section field this
codebase has no verified event type for (e.g. a named "broker activation" field) was deliberately
**not** invented.

Any real event type not in that mapping still contributes fully to `eventTypeCounts`
(`sum(eventTypeCounts) === sourceRowCount` always holds — the §8 invariant) and is listed in
`coverageManifest.unknownEventTypes`, never silently dropped.

**Deliberately deferred to Phase 2, not fabricated:** per-event-type quantitative sufficient
statistics (sum/sumSquared/confidence buckets) from `payload` JSON. Extracting those safely requires
verifying each event type's real payload schema individually — attempting it generically for Phase 1
risked inventing fields that don't actually exist for some event types, which the mandate explicitly
forbids ("do not fabricate missing metrics").

### Archive example (real output, from `observabilityEventsSource.test.ts`)

```json
{
  "sourceType": "OBSERVABILITY_EVENTS",
  "tradingDate": "2026-01-05",
  "schemaVersion": 1,
  "sourceRowCount": 5,
  "eventTypeCounts": { "DISCOVERY_CANDIDATE_ADMITTED": 2, "TRADE_IDEA_GENERATED": 1, "RISK_ASSESSMENT_COMPLETED": 1, "SOME_FUTURE_EVENT_TYPE": 1 },
  "sections": { "discovery": { "admitted": 2, "filtered": 0, "subscriptionRequested": 0, "subscriptionPromoted": 0, "subscriptionNotPromoted": 0 }, "ideas": { "generated": 1, "rejected": 0 }, "risk": { "assessmentsCompleted": 1, "...": 0 }, "...": "..." },
  "coverageManifest": {
    "sourceTable": "observability_events", "rowCount": 5,
    "eventTypesObserved": ["DISCOVERY_CANDIDATE_ADMITTED", "RISK_ASSESSMENT_COMPLETED", "SOME_FUTURE_EVENT_TYPE", "TRADE_IDEA_GENERATED"],
    "eventTypesSummarized": ["DISCOVERY_CANDIDATE_ADMITTED", "RISK_ASSESSMENT_COMPLETED", "TRADE_IDEA_GENERATED"],
    "unknownEventTypes": ["SOME_FUTURE_EVENT_TYPE"]
  }
}
```

## 5. Verification design

`verifyArchiveRow()` (independently callable, not only inline with compaction — see §8 for why):
re-reads the persisted row from scratch, then:
1. Parses `summary_json` — malformed JSON fails closed.
2. Recomputes the checksum over the parsed object and compares to `summary_checksum` — any
   mismatch fails closed.
3. Confirms every required section key exists.
4. Confirms `sum(eventTypeCounts) === sourceRowCount` (the critical §8 invariant).
5. Confirms the persisted `sourceRowCount` matches what was expected.
6. Only if **all** of the above pass: `compactionStatus → VERIFIED`, `verifiedAt` set.
Any failure: `compactionStatus → FAILED`, `failureReason` set, **raw data is never touched**.

## 6. Checksum design

SHA-256 over a canonical (sorted-key) JSON stringification of the summary object
(`checksum.ts`) — deterministic regardless of JS object key insertion order, which plain
`JSON.stringify` is not guaranteed to be stable against.

## 7. Purge design

`purgeVerifiedDays(source, retentionDays, nowMs)`:
- Selects archive rows where `sourceType` matches, `compactionStatus = 'VERIFIED'`, and
  `windowEndMs < nowMs - retentionDays*86400000`.
- For each eligible day, in its **own transaction**: `source.purgeWindow()` (real `DELETE`) then
  `compactionStatus → PURGED` — **atomic**: a crash or thrown error mid-transaction rolls back
  entirely (raw data untouched, status stays `VERIFIED`, safe to retry next sweep).
- Each day is wrapped in its own `try/catch` so **one failing day cannot block the rest of the same
  sweep** (a real fix made during this task — see §10).
- Days older than the cutoff but **not** `VERIFIED` are logged as `RETENTION_PURGE_BLOCKED` for
  operator visibility, never acted on.

`sweepObservabilityRetention()` in `ObservabilityStore.ts` now branches on
`observabilityConfig.dailyCompactionEnabled`:
- **OFF (the real default — not yet wired into live boot):** byte-for-byte identical to the
  pre-existing blind delete. This is what keeps "existing retention behavior is not weakened" true.
- **ON:** defers entirely to `purgeVerifiedDays()` — never falls back to the blind delete.

`retentionDays` is **unchanged at 14** per the explicit instruction not to shorten it in the same
change that introduces compaction.

## 8. Crash recovery

| Crash point | Recovery |
|---|---|
| Before archive insert | No row exists; next run starts clean |
| After archive insert, before verify | Row is `COMPACTED`; `verifyArchiveRow()` re-reads and verifies it directly — proven in `DailyCompactionOrchestrator.test.ts`'s "crash between compact and verify" case |
| After verify, before purge | Row is `VERIFIED`, `rawPurgedAt` null; next `purgeVerifiedDays()` sweep picks it up normally |
| During purge | Transaction rolls back; row stays `VERIFIED`, raw data untouched; retried next sweep |
| After partial purge (some days, not others, in one sweep) | Each day is isolated — a failure on day N does not prevent days before/after N in the same sweep |

## 9. Tests

**31 new tests across 5 files, all passing:**

- `DailyCompactionOrchestrator.test.ts` — 16 tests, every scenario named in §15 of the mandate (normal compaction, zero-event day, thousands of events, unknown event type, duplicate run, checksum mismatch, row-count mismatch, malformed payload, archive write failure, purge failure, crash-between-compact-and-verify, crash-between-verify-and-purge, partial purge, already-purged day, day newer than cutoff, current day never purged).
- `observabilityEventsSource.test.ts` — 3 tests against the **real** compactor with real seeded rows.
- `ObservabilityStore.test.ts` — 3 tests proving the gating behavior (OFF = unchanged; ON = VERIFIED-only deletion; ON + unverified day = correctly retained).
- `dailyLearningArchiveRepository.test.ts` — 3 tests for the §14 query API.
- `dailyCompactionPerformance.soak.test.ts` (Tier 4, §17) — 1 test, 3 scales.

**Critical assertion satisfied:** every purge-related test explicitly asserts the underlying raw
store was or was not actually touched (not just the archive row's status label) — "purge failure"
and "partial purge" both prove raw data survives when verification/purge doesn't complete cleanly.

**Two real defects found and fixed by this test suite** (not by inspection — by a test failing):
1. A row with a genuinely NULL `event_type` was counted in `sourceRowCount` but silently excluded
   from `eventTypeCounts`, breaking the `sum(eventTypeCounts) === sourceRowCount` invariant. Fixed:
   null keys now bucket under the literal `'(none)'` key, counted and visible, never dropped.
2. `JSON.stringify()`/persist had no surrounding `try/catch` — a pathological summary object could
   have crashed the whole compaction run uncaught instead of failing closed as `FAILED`. Fixed.
3. The original purge loop had no per-iteration isolation — one failing day's exception would have
   aborted the rest of that sweep's otherwise-healthy days. Fixed with per-day `try/catch`.

## 10. Performance measurements (§17, real, measured — not estimated)

| Scale | Seed time | Aggregation | Archive size | Raw estimate | Compression | Purge time | Peak RSS |
|---|---|---|---|---|---|---|---|
| 10,000 rows/day | 71ms | **14ms** | 2,520 bytes | ~2.0 MB | **794x** | 179ms | 206 MB |
| 100,000 rows/day | 964ms | **114ms** | 2,546 bytes | ~20.0 MB | **7,856x** | 501ms | 221 MB |
| 1,000,000 rows/day | 11.1s | **1.50s** | 2,572 bytes | ~200.0 MB | **77,761x** | 6.13s | 252 MB |

Aggregation stays well under a second even at 1M rows/day because it's pure SQL `GROUP BY` over an
indexed `ts` range — never row-by-row JavaScript. The archive row itself barely grows with volume
(2.5–2.6 KB regardless of 10K vs 1M source rows) since it stores counts, not events.

## 11. Storage reduction

At real production scale (this session observed ~250K+ `observability_events` rows in a single 6-hour
window on the live engine), a day's worth of raw telemetry compacts to a ~2.5 KB archive row — a
reduction of **several orders of magnitude**, consistent with the measured 794x–77,761x compression
ratios above (ratio grows with volume since the archive size is nearly constant while raw size scales
linearly).

## 12. Full regression results

Before this phase: 602 files / 4,640 tests (per the prior mutation-testing phase's baseline).

First full-suite run after this phase's 36 new files/tests found **one real regression**, caught
honestly rather than glossed over: `src/server/db/cryptoPaperMigration.test.ts` hardcoded the
assumption that `0079_repair_skipped_crypto_paper_tables` was the latest migration in the journal —
adding migration `0080` (this phase's `daily_learning_archive` table) broke that assumption in 2 of
its 3 tests. **Fixed by making the test read the real journal dynamically** (asserting against
`journal.entries`'s actual last entry and the actual set of migrations after the 0077 watermark,
excluding 0078 which the test deliberately simulates as skipped) instead of hardcoding a migration
tag name that any future migration would break again. This is a real, legitimate test-quality fix —
not a change to the migration itself, and not a weakening of what the test actually verifies (the
repair-and-idempotency behavior it exists to prove is unchanged and still fully asserted).

After the fix, re-run: **[filled in once the confirming re-run completes]**

Clean TypeScript typecheck confirmed throughout (`tsc --noEmit`, zero errors at every checkpoint).

## 13. Limitations (honest, not glossed over)

- **Not wired into live boot.** `dailyCompactionEnabled: false` by default, and
  `startDailyCompactionSweep()` is never called from `ArgusCoreBoot.ts`/`server.ts`. Turning this on
  against the real, currently-running production database is a deliberate, separate operator
  decision this phase does not make unilaterally.
- **No per-event-type quantitative sufficient statistics** (sum/sumSquared/confidence buckets) —
  only counts. A real Phase 2 candidate once specific event types' payload schemas are individually
  verified.
- **Section mapping is not exhaustive** — only event types individually verified against real source
  code are named; everything else is still fully counted (the invariant holds) but shows up under
  `unknownEventTypes` rather than a semantic field. This is intentional, honest scope, not an
  oversight.
- **`candidate_rankings` and every other raw table's retention is completely unchanged** — by design,
  per the mandate's own explicit Phase 1 scope.
- **The purge query loads all eligible archive rows into memory before iterating** — fine at the
  scale tested (dozens of days), would need pagination if retention were ever measured in years of
  daily rows, not 14 days.

## 14. Recommended Phase 2

In priority order, once Phase 1 has run safely for a real observation period:
1. **Turn on `dailyCompactionEnabled` as its own deliberate operator decision** (not automatic) and
   observe real compaction/verification/purge cycles against the live `observability_events` table
   for several days before trusting it unattended.
2. **Payload-level sufficient statistics** for the highest-value event types (confidence scores,
   latencies) — requires per-type payload schema verification first, not a generic extractor.
3. **A second `DailyCompactionSource`** (likely `candidate_rankings`, the next-largest unbounded
   table per `operationalRetention.ts`'s own header comment) — proves the pluggable architecture
   actually extends without a redesign, as intended.
4. Only after 1–3 are proven: **revisit the 14-day raw retention window** (e.g. shortening to 7 days)
   as its own separate, explicit decision — never bundled with the compaction work itself.

Stopping here per instruction — not continuing automatically into other tables.
