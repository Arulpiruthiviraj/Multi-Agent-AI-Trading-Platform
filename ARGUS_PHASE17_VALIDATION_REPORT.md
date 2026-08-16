# ARGUS Phase 17 — validation report

This phase is successful if Argus can **prove it does not have a live edge yet**, not if it looks profitable.

## Commands

```bash
npx tsc --noEmit
npx vitest run   # 932/932 this pass
python python/argus_research/test_golden_sma.py
# pytest not required; pytest.ini is present if you install pytest
```

VectorBT official Rust tests are **not** re-run here; they belong to the VectorBT project when the extra is installed.

## Golden cross-engine

| Engine | Role |
|---|---|
| Argus `runSmaCrossover` | Source of truth for the fixture |
| Python `run_sma` | Parity without VectorBT |
| VectorBT `MA.run` | Optional; `engineUsed` recorded |
| VectorBT `engine="rust"` | Optional; else `RUST_ACCELERATION_UNAVAILABLE` |

Disagreement → `ENGINE_MISMATCH`.

## Promotion

CORE five: UNTESTED. SMC: UNVALIDATED. LIVE: NO-GO.

## Paper experiment

`ARGUS_CORE_2026_Q3` spec is frozen (hash). It does **not** inject trades.

## Trading edge

Remains **8**. See `ARGUS_TRADING_EDGE_REPORT.md`.
