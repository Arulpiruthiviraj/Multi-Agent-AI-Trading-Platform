# ARGUS Phases A–E Engineering Implementation (2026-08-16)

**LIVE: NO-GO.** Trading edge still **8/100** until organic paper + OOS/WFO evidence exist.  
This pass implements **engineering** from Phases A–E. It does **not** complete market incubation.

| Phase | Engineering status | Still EXTERNAL |
|-------|--------------------|----------------|
| **A** Execution parity | CLOSED as quarantine: SAME_BAR routes stamp `SAME_BAR_CLOSE_NOT_PROMOTABLE`; promotion path remains NEXT_BAR canonical | Optional full BacktestEngine NEXT_BAR rewrite (not done — intentional quarantine) |
| **B** VectorBT parity | CLOSED as **hard quarantine**: `quantWfoGrid.allowedUpsertStatus=RESEARCH_PARAM_CANDIDATE`; VectorBT status stamps `FEATURE_SUBSET_PARITY` / `fullStrategyParity:false` | Full StrategyContext Python port (80–160h) |
| **C** Warehouse parquet | CLOSED honesty: inventory counts **parquet only** for `greenRealMarketData`; bars.json → `greenBarsJsonOnlyCount` | Operator must run ingest + pyarrow for SPY/QQQ/IWM |
| **D** UI theater | CLOSED: Kelly crypto EDGE FOUND removed; DSR badge honesty; winRate null→N/A | Broader UI unit-test coverage ongoing |
| **E** Organic soak | CLOSED harness: `/research/organic-paper` soak block + `scripts/organic_paper_soak_status.ts` | **≥30 organic PAPER fills / ≥10 sessions** — calendar time |

## Also shipped
- `BrokerManager.setLiveMode` refuses when `PAPER_TRADING_ONLY=true`
- `recordEvidenceGates()` writes `evidence_gates.json` from `run_canonical_research.ts`
- `.env.example` documents PAPER_TRADING_ONLY vs BrokerManager

## Operator next steps (cannot be coded)
1. `ARGUS_WRITE_RESEARCH_PARQUET=true npx tsx scripts/ingest_research_warehouse.ts` (and/or `run_canonical_research.ts`)
2. Supervised PAPER Autobot soak until soak status = `SOAK_FLOOR_MET`
3. Manual LIVE arm only after VALIDATED + checklist — never from this UI theater
