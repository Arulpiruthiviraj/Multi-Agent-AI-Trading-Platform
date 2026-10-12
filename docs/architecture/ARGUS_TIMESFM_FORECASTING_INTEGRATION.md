# TimesFM forecasting integration (SHADOW / RESEARCH, 2026-10-12)

Status: **scaffolding implemented and tested; the model is NOT installed and nothing is enabled.** No forecast has been produced, so no accuracy claim exists.

## Verified facts (official repo + Hugging Face pages, fetched 2026-10-12)
- Code: Apache-2.0. Weights up to 2.5: Apache-2.0. **TimesFM 3.0 weights (`google/timesfm-3.0-pytorch`, package `timesfm3`) are non-commercial / non-production** — not supported by this service (`MODEL_NOT_APPROVED`).
- TimesFM 2.5 (200M): `timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")`; the HF page says PyPI is "coming soon", so install from source. Returns a point forecast plus mean and 10th–90th percentiles.
- **Ollama:** no evidence of native support for this architecture; Ollama is NOT used. Runtime is a separate Python process.

## Not yet done (blocked on host resources)
- Install: this host had ~1.6 GB free RAM with the engine running, and the venv Python is 3.14 (PyTorch/timesfm wheel compatibility unverified). Install and benchmark must happen in an isolated window with the engine stopped, or on another machine, in a dedicated Python venv.
- Chronos/Kronos vs TimesFM vs naive/moving-average comparison (MAE, MASE, directional accuracy, interval coverage, pinball loss, latency, memory), point-in-time walk-forward, multiple symbols/regimes.
- Persistence of forecasts and outcomes (no table added yet) and dashboard fields.

## What exists
- `scripts/timesfm/timesfm_service.py` — loopback-only stdlib server; lazy single load; bounded concurrency/queue; validates input (≥32 bars, finite positive closes, strictly increasing timestamps, horizon bounds, constant series rejected); reports `MODEL_NOT_INSTALLED` instead of crashing; no Argus imports, no credentials, no DB. Tests: `python -I scripts/timesfm/test_timesfm_service.py` (12 pass).
- `src/server/engines/timesfm/TimesFmClient.ts` — disabled unless `TIMESFM_ENABLED=true`; typed results, never throws; look-ahead guard (bar after forecast origin rejected); duplicate/out-of-order/NaN/non-positive rejection; per-call deadline; bounded concurrency + queue; coalesces identical in-flight requests; loopback only; response validation (length, finite, monotonic quantiles). Output is marked `calibrated: false`. Tests: `TimesFmClient.test.ts` (8 pass).
- It does not implement `IForecastEngine` (that interface returns a BUY/SELL-style prediction; forcing probabilistic numeric output into it would be inaccurate) and is not wired to any caller, idea emitter, ChiefTrader, RiskEngine, OMS or broker.

## Gate before any influence on trading
Out-of-sample, point-in-time, after-cost improvement over Chronos/Kronos and baselines, calibrated intervals, bounded resource use during market hours, and a separate approved change through the normal Quant validation path.
