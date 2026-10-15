# ARGUS database storage redesign (working design, 2026-10-15)

Status: **measured design, not implemented in the engine.** Nothing here has been applied to the production database or the running PAPER engine (pinned at `32613911`). PAPER only; LIVE_NO_GO. Implementation work lives on branch `dev/storage-redesign` (worktree `argus-storage`) until certified; this document is the only part intended for `main` now.

Evidence: `docs/audits/storage_redesign_evidence/` (`storage_validation.json`, `storage_poc.json`; scripts `scripts/forensic/storageValidation.cjs`, `storagePoc.cjs`). All measurements use the Oct 14 post-close snapshot (SHA-256 verified), opened read-only; proof-of-concept databases are fresh temp files.

## 1. Where the space is (dbstat, Oct 14 snapshot, 24.85 GB file)

| Table | Size | Share | Rows | Avg row |
|---|---|---|---|---|
| observability_events | 7.07 GB | 28.4% | 11.18M | 632 B (14-day retention) |
| quant_assessments | 6.38 GB | 25.7% | 224,927 | 28.4 KB (30-day retention) |
| decision_provenance | 4.12 GB | 16.6% | 69,270 | 59.4 KB (90-day retention) |
| event_traces | 2.98 GB | 12.0% | 2.53M | 1.2 KB (permanent) |
| agent_reasoning_logs | 1.11 GB | 4.5% | 685k | 1.6 KB |
| everything else | ~3.2 GB | ~13% | | |

Market bars (0.1 GB) and predictions (0.5 GB) are small. Free pages are 29 MB, so VACUUM would reclaim almost nothing. Growth on Oct 14: the two wide tables added ~2.8 GB in one day; the live file grew ~4.4 GB overnight; headroom above the 15 GB floor is roughly 3-5 trading days at that rate.

## 2. Validated measurements (priority 1)

### 2.1 Compression, three independent sampling designs
Byte-weighted compressed/raw ratio of a whole row (800 rows per design; the bootstrap interval treats rows as independent, so it understates true uncertainty because adjacent rows are correlated - compare the three designs instead):

| Table | Random rowids | Adjacent time window | Stratified by symbol (8 symbols) | zstd-3 (random) |
|---|---|---|---|---|
| quant_assessments | 0.252 | 0.251 | 0.250 | 0.270 |
| decision_provenance | 0.194 | 0.196 | 0.194 | 0.197 |

The three designs agree within ~1 percentage point; the earlier stride-sample result (3.7x / 4.7x) is confirmed. zlib and zstd level 3 are within ~2 points of each other on this data; the choice is a CPU/latency decision, not a size decision.

### 2.2 Market-wide context is stored once per symbol instead of once per minute
Adjacent window of 6,000 consecutive assessments: 650 distinct `market_context` objects (89.2% duplicate). Distinct SPY / QQQ / IWM sub-objects across all 6,000 rows: 8 each; sector 60; breadth 1. The same object is also embedded in `decision_provenance.strategy_context_json.marketContext`.

### 2.3 What `bar_evidence_json` actually contains (corrects the earlier assumption)
It holds **references, not OHLCV values**: 250 entries of `{barId, barTimestamp, availableAtMs}` (0 of 300 sampled rows carry inline prices; all sampled rows are 1Day bars). `barId` is derivable (`symbol:timeframe:timestamp`). Findings from 300 random rows / 1,500 most-recent references:
* 1,500 of 1,500 references resolve in `ohlcv_bars` (sources: ibkr 1,026, alpaca 474).
* **95 of 1,500 (6.3%) of the referenced bars are marked `provisional`.** A provisional bar may later be revised and `ohlcv_bars` has no revision history, so the table alone cannot reproduce what a decision saw. Point-in-time reproducibility requires the evidence record to carry a content hash (or the values) of each referenced bar as of `availableAtMs`. Today it carries neither.
* Availability lag is exactly one day for every reference (p50 = p95 = 86,400,000 ms): the daily-bar availability stamp is a convention, not a measured arrival time.
* Compact reference encoding (symbol/timeframe once, base timestamp, deltas) is 5.9 KB as JSON and **0.93 KB after zstd, versus 24.6 KB today (26x smaller)** while still referencing the same bars.

Not yet measured: intraday-timeframe provenance rows (none sampled), and how `ohlcv_bars` revisions behave in practice (no revision log exists).

## 3. Isolated proof of concept (priorities 2 and 3)

Method: 3,000 consecutive `quant_assessments` + 3,000 consecutive `decision_provenance` rows (adjacent window, ~70% into the file) inserted one row per transaction into three fresh databases (WAL, synchronous=NORMAL), identical indexes. Afterwards every row was read back and every column compared with the original: **6,000 of 6,000 rows reconstruct byte-for-byte in all three variants** (a first run flagged mismatches because my DDL gave one integer column TEXT affinity - a harness bug, fixed and re-run).

* **Baseline:** current layout (JSON text columns).
* **A, compressed envelopes:** each large column stored as `[format u8][algo u8][raw length u32][sha256 of original bytes][zstd-3 payload]`; reads verify length and SHA-256. Original text is preserved verbatim, so no canonicalisation is needed for exact reconstruction.
* **B, content-addressed shared evidence:** A plus `evidence_blobs(hash, payload, refs)`. The per-minute market context (the `quant_assessments.market_context` bytes and the provenance `marketContext` sub-object are the same bytes) is stored once; bar evidence uses the compact reference form and is re-expanded exactly (verified per row; non-round-tripping rows fall back to a full envelope - 0 fallbacks occurred).

| Variant | DB size (6,000 rows) | Bytes/row | vs baseline | Insert p50 / p95 / p99 (ms) | Read+reconstruct p50 / p95 / p99 (ms) | WAL peak | Write CPU (6k rows) | Report-style group-by (median ms) |
|---|---|---|---|---|---|---|---|---|
| baseline | 262.5 MB | 43,753 | 1.00 | 0.37 / 0.93 / 19.6 (checkpoint stall) | 0.12 / 0.21 / 0.32 | 4.2 MB | 1.2 s | 47 |
| A compressed | 70.6 MB | 11,762 | **0.269 (-73%)** | 0.75 / 1.61 / 3.98 | 0.42 / 0.76 / 1.57 | 4.2 MB | 5.0 s | 17 |
| B shared | 57.6 MB | 9,594 | **0.219 (-78%)** | 1.39 / 3.68 / 6.37 | 0.71 / 1.84 / 2.89 | 4.2 MB | 7.2 s | 50 |

Evidence blob store in B: 432 distinct blobs referenced 6,000 times (1.1 MB). Caveats: one run on a workstation that was also running the live engine (indicative, not a benchmark suite); the baseline p99 is a checkpoint pause; the report-style query touches only metadata columns, so it measures page-count effect, not decode cost; RSS ~700 MB is the harness holding the sample in memory.

**Reading the result:** compression (A) delivers most of the benefit (-73%). Sharing (B) adds ~5 further percentage points on this data at ~2x A's write latency and ~1.4x its write CPU, plus extra moving parts (second table, reference counting, a reference-integrity rule). The largest single field, `strategy_evaluations` (17 KB), is unique per row and is not helped by sharing. **Recommendation: ship A first, including the compact bar-reference encoding (the one B element worth keeping: 26x on the biggest provenance field); defer full content-addressed sharing until A is live and the remaining bytes are re-measured.** An engineering judgement from one run, not a proven optimum.

### Extrapolation to production (estimate, not measured on the full tables)
Applying the sampled ratios to table bytes (indexes excluded): quant_assessments + decision_provenance, 10.5 GB today -> ~2.6-2.8 GB with A (x0.25-0.27) -> ~2.3 GB with B (x0.22). Growth of those two tables (~2.8 GB/day on Oct 14) would fall to roughly 0.7-0.8 GB/day with A. The file does **not** shrink by itself (see §6).

## 4. Safety rules for the format (A and B)
* Evidence is never written by reference to something not yet durable: in B the blob is inserted in the same transaction as the referencing row (verified in the PoC; enforce with a nightly referential-integrity scan).
* Reads verify length and SHA-256 and fail loudly; a decode failure is never treated as "no evidence".
* The format version is the first byte; readers accept legacy uncompressed text and every known version (dual-format reading is what makes a no-rebuild migration possible).
* **Reader impact (counted in the code):** `decision_provenance` is read and written through one module (`src/server/replay/provenance/decisionProvenance.ts`) plus retention; `quant_assessments` has ~25 consumers (strategy scorecards, lineage report, observatory UI, CLI, retention, certification). Drizzle readers can be covered by a custom column type that decodes transparently; raw-SQL readers must be audited individually (no `json_extract` on these tables was found in `src/`).
* Compression runs synchronously on the event loop at ~0.4-1 ms per assessment (3.5-4 ms for the heaviest B path). Volumes are in the tens of thousands per day, so total cost is small, but a worker-thread option must be benchmarked before certification given the production event-loop lag.
* Trading-critical tables (orders, fills, positions, risk, lifecycle) are out of scope and unchanged; no critical write becomes asynchronous.

## 5. Historical research tier (priority 4) - design; benchmark pending
Keep SQLite for the trading core (orders, fills, positions, risk, reconciliation, lifecycle, calibration summaries): single node, one writer, WAL, already covered by safety/recovery tests. For finalized analytical evidence (assessments/provenance older than the operational window, bars, predictions/outcomes) the candidate is compressed Parquet (zstd, partitioned by month and data class, not per symbol) queried with DuckDB, with an `archive_manifest` (path, row count, min/max id and time, SHA-256, format version, source DB identity). Not yet done: a size/latency benchmark of Parquet+DuckDB against A on the same rows, and export/verify tooling. Splitting into several SQLite files on the same C: drive saves no space by itself; savings come from compact encoding, retention, and moving cold data to separate storage. Decision rule: adopt the research tier only if A plus retention cannot hold growth inside the storage budget, or if analytical query load measurably hurts the engine.

## 6. Migration without a live 28 GB rebuild (priority 6)
Constraints: live file ~29 GB, ~28 GB free, safety floor 15 GB, no external volume, 29 MB of free pages.
* **A full VACUUM or rebuild-into-new-file needs roughly the live size again** (~29 GB temporary for VACUUM; a compacted new file ~20 GB plus the old file for a copy-rebuild). Neither fits above the 15 GB floor here, so **a shrink-the-file migration is not possible during PAPER on this machine**; it needs an external volume of at least 64 GB or a quiet window with verified space.
* **Recommended path, no rebuild (stop growth, do not shrink):**
  1. Release R1, in two steps: first a read-compatible release (readers accept both formats), then the writer switched on behind a flag. New rows use format A; legacy rows are untouched.
  2. Retention sweeps (already batched, no long locks) delete old legacy rows; SQLite reuses the freed pages for new inserts, so the file stops growing near its current size while holding ~4x more history per byte. Retention windows are then sized from measured bytes/row; until A is live `decision_provenance`'s 90 days is not sustainable (config-only change, needs restart and certification).
  3. Optional later: a one-time offline rebuild when external space exists, returning the file to ~12-15 GB.
* Extra disk for R1: ~0 beyond normal WAL (PoC WAL peak 4.2 MB). The optional rebuild needs ~1.0x live size on a separate volume.
* Backup: a 40 MB critical-state export is not a full backup. A restorable full backup of a 29 GB file needs a target with >= 64 GB free plus a restore test. Not available today; no same-disk full-backup retries.
* Verification before any deploy: replay parity (decisions, risk outcomes, fills, accounting), shadow-reader check (decode every new row to the legacy text and compare SHA-256), lineage reconstruction, forensic-report parity, restart battery, soak on an isolated DB.
* Rollback: R1 is reversible without data loss because legacy rows are untouched and readers accept both formats. Rolling back to a release that cannot read format A would strand new compact rows, which is why the read-compatible release must ship (and soak) before the writer flag is ever enabled. No destructive step is part of R1.

## 7. Prediction grading and retention (priority 5) - design; implementation on `dev/calibration-grading`
Confirmed facts (earlier audit): ~82k predictions/day generated, ~2k graded/day; the grader walks oldest-first and only reaches rows at the 30-day retention edge; 99.5% of Kronos predictions are ungraded; grading stalled Sep 10-Oct 12; graded outcomes live 90 days and survive deletion of the raw prediction.
Design:
1. **Durable due-time queue:** each prediction gets a `due_at` (prediction time + horizon + data-availability lag); the grader selects `due_at <= now` by a bounded age-aware priority (expiring-soon first, then newest within cluster) - not blind newest-first (starves old rows) or oldest-first (reaches only the retention edge).
2. **Event clustering:** one representative per (symbol, horizon, 10-minute event window) is graded as the calibration sample and carries a cluster weight (effective sample count); non-representatives get a documented terminal disposition (`CLUSTERED_NOT_GRADED`), never silent disappearance. Calibration uses effective n, not raw n.
3. **Local data first:** grade from `ohlcv_bars` when the window is covered; bounded provider backfills otherwise; a failed fetch records `DATA_UNAVAILABLE`.
4. **Retention-before-grading guard:** retention must not delete an in-horizon ungraded prediction without recording a disposition (`EXPIRED_UNGRADED`) in an aggregate counter table.
5. **Throughput target:** demonstrate on an isolated database that grading keeps pace with the cluster-representative count (not the raw 82k/day) with a stable backlog; if it cannot, publish the sampling policy and its justification. **Not yet implemented or measured.** Sampling must follow a pre-declared rule independent of outcome or consensus, so calibration sees successes and failures alike.
No confidence is raised artificially; honest calibration for the measured out-of-sample skill sits near chance.

## 8. Tests required before any release candidate
* Unit: envelope seal/open round trip incl. corrupt payload, wrong SHA, unknown format version, empty/null columns, non-JSON text, very large payloads.
* Property: random JSON text -> store -> read returns identical bytes; bar-evidence compact/expand exactness incl. irregular or non-canonical lists (fallback path).
* Integration (isolated DB): dual-format reader over a mixed legacy/compact table; retention delete + page reuse keeps file size bounded under a synthetic day of writes; WAL behavior under checkpoint.
* Parity: full synthetic certification before/after - identical decisions, risk outcomes, fills, accounting; lineage oracle; discovery report equality.
* Performance: insert/read p95/p99 and event-loop lag with compression on the engine thread vs a worker thread, at representative daily volume.
* Architecture: no new write path into RiskEngine/OMS/BrokerManager; critical tables untouched.

## 9. Not yet done (honest list)
Parquet/DuckDB benchmark; worker-thread compression benchmark; full-table (not sampled) duplicate/compression measurement; intraday-bar provenance sample; grading scheduler implementation and throughput measurement; effective-sample calibration implementation; point-in-time hashing of provisional bars in provenance; external-volume / full-backup procedure; disk-growth alert thresholds.
