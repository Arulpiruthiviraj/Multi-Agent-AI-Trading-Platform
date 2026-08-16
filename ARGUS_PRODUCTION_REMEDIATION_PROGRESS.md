# ARGUS Production Remediation Progress — Loop Continuation

**Date:** 2026-08-16 (continued)  
**Prior:** `ARGUS_PRODUCTION_REMEDIATION_PROGRESS.md` (Phase 25 honesty) + Phase 24 replay

---

## Explicit decisions (unchanged)

| Gate | Status |
|------|--------|
| **LIVE** | **NO-GO** |
| **Trading edge** | **8/100** |
| **Organic paper** | **NOT_ESTABLISHED** |
| **Canadian execution** | **BLOCKED** |
| **Historical Replay** | **GO** (simulation; warehouse opt-in) |

---

## Implemented this loop (Phase 26)

### 1. Alpaca `client_order_id` on `orders()`
- `src/brokers/AlpacaBroker.ts` — list mapper now includes `clientOrderId` so OMS inbound reconcile can match Argus rows (avoids false EXTERNAL_MANUAL).

### 2. Research warehouse parquet honesty
- `parquetStore.ts` — `markParquetBytesWritten()` + sidecar `parquetBytesWritten` flag after successful write.
- `ingestAlpacaWarehouse.ts` — requires `ARGUS_WRITE_RESEARCH_PARQUET=true`; updates sidecar when Python write succeeds.
- `HistoricalDataProviderRegistry.ts` — Alpaca replay fetch persists when env flag set.
- `scripts/ingest_research_warehouse.ts` — sets write flag and `writeParquet: true`.

### 3. MODE B SPY benchmark (no fabrication)
- `FullArgusReplayEngine.ts` — loads PIT SPY bars when provider can; golden fixture leaves **UNAVAILABLE**.

### 4. Canonical robustness → promotion gates
- `coreRobustness.ts` — returns `gates.{monteCarloPass,permutationPass,sensitivityPass,costStressPass}` + `applyRobustnessGates()`.
- Route `/research/canonical/robustness` exposes `evidenceGates` (still LIVE NO-GO without paper/manual).

### 5. Vector parity labeling
- Python `core_feature_parity` → `FEATURE_VECTOR_PARITY_ESTABLISHED` + `strategyParity: FEATURE_SUBSET_PARITY`.

### 6. Secret redaction expansion
- `SecretRedaction.ts` — AUTH_PASSWORD, DeepSeek, Nvidia, OpenAlice URL, IBKR/Questrade/Coinbase secrets.

### 7. Tests
- `src/server/research/phase26.remediation.test.ts`

---

## Tests executed

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | **PASS** |
| Targeted vitest (phase22/25/26 + SecretRedaction + ingest + replay) | **45 passed** |
| Full `npx vitest run` | _(see below)_ |

---

## Files changed (this loop)

- `src/brokers/AlpacaBroker.ts`
- `src/server/research/parquetStore.ts`
- `src/server/research/ingestAlpacaWarehouse.ts`
- `src/server/replay/HistoricalDataProviderRegistry.ts`
- `scripts/ingest_research_warehouse.ts`
- `src/server/replay/FullArgusReplayEngine.ts`
- `src/server/research/coreRobustness.ts`
- `src/server/routes/researchRoutes.ts`
- `python/argus_research/cli.py`
- `src/server/core/SecretRedaction.ts`
- `src/server/research/phase26.remediation.test.ts`

---

## Remaining EXTERNAL blockers only

1. Operator Alpaca credentials + `ARGUS_WRITE_RESEARCH_PARQUET=true` for GREEN multi-year parquet
2. Organic PAPER fills (cannot fabricate)
3. Full StrategyContext ↔ Python feature port (still FEATURE_SUBSET_PARITY)
4. Historical news/fundamentals/macro PIT corpora
5. Canadian broker + compliance
6. Manual LIVE arm after evidence

---

## Scores

- **Technical readiness:** improved again (reconcile, warehouse, robustness gates, secrets)
- **Trading edge:** **8/100**
- **LIVE:** **NO-GO**
