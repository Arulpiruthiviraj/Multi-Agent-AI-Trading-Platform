# ARGUS VectorBT integration

**VectorBT is research-only. It cannot place orders.**

```
Research Result → Strategy Evidence → (optional) TRADE_IDEA_GENERATED → ChiefTrader → RiskEngine → OMS → Broker
```

Never: `VectorBT → Broker`.

## Installation

```bash
pip install -r requirements-research.txt
pip install -U "vectorbt[rust]"   # optional
```

Official extra: `vectorbt[rust]` (PyPI package `vectorbt-rust`). Do not invent a separate Argus Rust backtester. Prefer `engine="auto"` or `engine="rust"` on VectorBT public APIs. Do not import `vectorbt_rust` in strategy code; capability detection may probe the extra.

## Capability states

`AVAILABLE` · `AVAILABLE_WITHOUT_RUST` · `AVAILABLE_WITH_RUST` · `UNAVAILABLE` · `FAILED`

If Rust is missing, VectorBT/Numba fallback remains valid. Jobs that **require** Rust report `RUST_ACCELERATION_UNAVAILABLE` rather than pretending Rust ran.

`GET /api/v2/research/vectorbt/status` reports `canPlaceOrders: false`.

## Python boundary

`python/argus_research/cli.py` accepts JSON on stdin. Allowlisted jobs only (`config/researchSafety.json`). Keys `code` / `python` / `eval` / `broker` / `placeOrder` are rejected.

Node spawns this CLI via `VectorBTService`. Timeout from `researchSafety.pythonTimeoutMs`.

## Engine used

Every result records `engineUsed`. Values include `python_sma`, `vectorbt_auto`, `vectorbt_rust`, `RUST_ACCELERATION_UNAVAILABLE`, `unavailable`.

## CORE strategies

Adapters are **proxies**. `POST /api/v2/research/vectorbt/backtest` with a CORE or experimental id returns `UNTESTED` and `inventedResults: false`. Feature engines (BOS, RVOL, VWAP context) are not SMA. SMC remains **UNVALIDATED**.

## Golden fixture

`fixtures/research/golden_sma.json` — Argus TypeScript SMA vs Python SMA (and VectorBT MA if installed). Mismatch → `ENGINE_MISMATCH`. Never pick the better PnL.

## Fallback

Argus remains usable without VectorBT, Rust, or even Python. Research routes return honest UNAVAILABLE / python_sma results.

## Versions observed on this machine (2026-08-16)

- VectorBT `1.1.0`
- `vectorbt_rust` `1.1.0` (import succeeds)
- Vitest does **not** spawn the Python CLI (`VITEST=true`) so the suite cannot hang on Windows Python. Server `GET /api/v2/research/vectorbt/status` probes for real.
