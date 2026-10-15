# ARGUS database storage redesign (working document, started 2026-10-15)

Status: **measurement phase**. Nothing here has been applied to the production database or engine. PAPER only; LIVE_NO_GO. Every figure below is from the Oct 14 post-close snapshot (read-only), sampled by rowid stride (1,200 rows per table; `docs/audits/oct14_evidence/json_payload_audit.cjs`, result `json_payload_audit.json`). Sampling error is not quantified; treat ratios as estimates.

## 1. Measured: where the bytes in the two wide tables are

`quant_assessments` (224,927 rows, avg 27.5 KB, zlib of a whole row 7.5 KB = 3.7x):

| Field | Avg bytes | zlib bytes | Repeats an earlier sampled row |
|---|---|---|---|
| strategy_evaluations | 17,120 | 4,538 | 26% |
| market_context | 7,773 | 2,442 | 13% (SPY/QQQ/IWM sub-objects: ~89% identical to another sampled row; breadth: 99.9%) |
| regime | 2,044 | 1,165 | 16% (deskSession 97%) |

`decision_provenance` (69,270 rows, avg 58.5 KB, zlib of a whole row 12.4 KB = 4.7x):

| Field | Avg bytes | zlib bytes | Repeats an earlier sampled row |
|---|---|---|---|
| bar_evidence_json | 24,648 | 2,655 (ratio 0.11) | 59% |
| evaluations_json | 17,481 | 4,568 | 42% |
| strategy_context_json | 14,137 | 4,072 | 22% (its `marketContext` is the same 7.7 KB object stored in `quant_assessments.market_context`) |
| strategy_versions_json, lifecycle_states_json | ~1,700 | ~650 | 58% |

Verified facts: (1) `bar_evidence_json` is highly redundant text (compresses ~9:1) and 59% of sampled rows repeat another sampled row's bars; (2) the market-wide context (SPY/QQQ/IWM, sector, breadth, desk session) is a per-minute fact stored again in every symbol's assessment and again inside provenance; (3) the same evaluations appear in both tables (`strategy_evaluations` 17 KB vs `evaluations_json` 17.5 KB). Not yet verified: the exact fraction of `bar_evidence_json` that duplicates rows already in `ohlcv_bars` (needs a bar-level join, next step), and the true duplicate rates over the full table (a 1,200-row stride sample understates repeats across adjacent minutes).

## 2. What this implies (estimates, not yet implemented)

* Compression alone, without changing any schema or reader semantics, would cut these two tables by roughly 3.7-4.7x on the sampled data. SQLite has no transparent column compression, so this needs an application-level compressed-blob column or an archive tier; it is a format change that needs reader compatibility tests.
* Content-addressed sharing of the per-minute market context (one row keyed by a hash/minute, referenced by every assessment and provenance row) removes the largest repeated structure. The saving depends on how many symbols share a minute; to be measured.
* `bar_evidence_json` by reference to `ohlcv_bars` ranges plus an immutable snapshot id only where bars are not otherwise retained.

These preserve the evidence: nothing is dropped unless the reference can be resolved and a replay reproduces the same decision.

## 3. Constraints on every step

No mass DELETE, VACUUM, schema change or retention change on the live database during trading; no second full backup on the same disk; the two Oct 14 snapshots stay; every change goes on a dev branch, is exercised on an isolated database, merges to main only when verified, and deploys only as a separately certified release. Required before any reader changes: replay parity (same decisions, risk outcomes, fills), lineage reconstructability, forensic-report compatibility.

## 4. Remaining sections (to be filled with measurements)

Grading throughput design and measured before/after; retention and archival design (SQLite core + compressed Parquet/DuckDB tier, with benchmarks of size, read latency, write cost); backup design; migration plan; rollback requirements; exact tests.
