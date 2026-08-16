# Local AI Stack Setup

Argus can offload cheap, high-frequency inference (sentiment scoring, numerical
forecasting, direction classification) to models running entirely on your own
machine, instead of calling a paid frontier LLM on every market tick and news
headline. This is optional - without it, Argus runs on cloud providers alone,
same as before.

See the architecture note at the bottom for how these models are meant to fit
into the agent pipeline (TechnicalAgent, NewsEngine, KronosForecastAgent,
ChiefTraderAgent). This document only covers installing and warming up the
models themselves.

## Prerequisites

- **Ollama** (local LLM runtime) - [ollama.com/download](https://ollama.com/download)
- **Python 3.10+** with `pip` on PATH
- Disk space: ~18 GB for the four Ollama models below, plus ~1 GB for the
  Hugging Face models (FinBERT, Chronos-T5-mini)
- RAM: 8 GB minimum (for `llama3.2:1b` + FinBERT/Chronos); 16 GB+ recommended
  if you also run `0xroyce/plutus` or `fingpt` (7-8B parameter models)
- No GPU required - all models here run acceptably on CPU; a CUDA-capable GPU
  speeds up the Python ML models but `torch` will fall back to CPU automatically

## One-command setup

```bash
npm run setup:ai
```

This runs `scripts/bootstrap_models.py`, which:

1. Confirms Ollama is installed and its server is reachable on port 11434.
2. Installs the Python packages in `requirements-ai.txt` (`torch`,
   `transformers`, `gluonts`, `accelerate`, `xgboost`, `scikit-learn`,
   `pandas`, `yfinance`, `ta`, `neuralforecast`).
3. Pulls `llama3.2:latest`, `llama3.2:1b`, and `0xroyce/plutus:latest` via
   `ollama pull`.
4. Builds a local `fingpt` Ollama model from a GGUF file (see below) if one is
   present, otherwise skips with instructions.
5. Warms up the Hugging Face cache for `ProsusAI/finbert` and
   `amazon/chronos-t5-mini` so the first real request doesn't stall on a
   multi-hundred-MB download.

Re-running is safe - every step is idempotent (`ollama pull`/`ollama create`
no-op when the model already matches, and the Hugging Face warm-up uses the
cache once populated).

## FinGPT (manual step required)

There is no official single-file GGUF that `ollama pull` can fetch directly
for FinGPT - the published FinGPT repos on Hugging Face are LoRA adapters, not
a merged GGUF, and Ollama's `hf.co/...` pull path needs the exact
`huggingface.co` host (not the `hf.co` shortlink) pointed at a repo that
actually contains one. Rather than have the setup script guess a URL that
might not exist or point at an unverified source, you provide the file
yourself:

1. Obtain or convert a FinGPT GGUF file (e.g. merge a FinGPT LoRA adapter onto
   its base Llama model yourself and quantize it to GGUF with `llama.cpp`).
2. Place it at `models/fingpt.gguf` in the repo root (or set the
   `FINGPT_GGUF_PATH` environment variable to point at it elsewhere).
3. Re-run `npm run setup:ai` - it will generate the `Modelfile` and run
   `ollama create fingpt -f Modelfile` for you.

If you already have a `fingpt` model in `ollama list` from doing this by hand,
the setup script's `ollama create` step will simply confirm/recreate it - your
existing model is not affected.

## Verifying it worked

```bash
ollama list          # should show llama3.2:latest, llama3.2:1b, 0xroyce/plutus:latest, fingpt:latest
```

Start the app (`npm run dev`) and check the boot log for one of:

```
[LocalAI] Ollama reachable at http://localhost:11434 with all 4 expected local models.
[LocalAI] Ollama is running at http://localhost:11434 but missing model(s): ...
[LocalAI] Ollama not reachable at http://localhost:11434 (...)
```

This check is non-blocking - a missing or unreachable local stack only logs a
warning and never prevents the app from starting.

## Running the real Kronos/Chronos forecast (`npm run ai:serve`)

`KronosForecastAgent`/`KronosInference.ts` call a small persistent local
service instead of loading Chronos in-process:

```bash
npm run ai:serve
```

This runs `scripts/local_ai_service.py`, which loads `amazon/chronos-t5-mini`
once via the real `chronos-forecasting` package's `ChronosPipeline` (not a
bare `transformers` model - Chronos needs its own mean-scale-and-quantize
tokenizer to turn a numeric series into something the underlying model can
forecast from) and serves it on `http://localhost:8008`:

- `GET /health` - readiness check, polled by `KronosModelManager.ts` every 30s.
- `POST /forecast` - `{ "prices": number[], "horizon": number }` → sampled
  quantile forecast (`low`/`median`/`high`).

Leave this running (or just use `npm run dev`, which now starts the same process unless
`ARGUS_SKIP_CHRONOS=true`). If it isn't running, `KronosForecastAgent` stays honestly
reported as unavailable (matching `KRONOS_UNAVAILABLE`) rather than crashing or fabricating
a forecast.

`KronosForecastAgent` needs a real rolling window (30+ ticks) for a given
symbol before it calls this service at all, and caps itself to one call per
symbol per 60 seconds - a numeric forecast on a handful of points is noise,
and every call has real (if small) CPU latency.

## Architecture: where each model fits

- **FinBERT** - real numerical sentiment score for news articles/clusters in
  NewsEngine, replacing an LLM call for a task a small classifier is both
  cheaper and more consistent at.
- **XGBoost** - a same-tick numerical direction-probability input alongside
  TechnicalAgent's existing RSI/MACD/Bollinger signals - a real learned signal,
  not a replacement for the deterministic rules.
- **Chronos (amazon/chronos-t5-mini)** - real numerical multi-step price
  forecasting. This is the natural real implementation for the currently-dead
  `KronosForecastAgent`/`KronosInference.ts` (see `CLAUDE.md`'s Known
  Broken/Non-Functional Components list).
- **Llama 3.2 / Plutus / FinGPT (via Ollama)** - registered in `AIRouter` as an
  OpenAI-compatible local provider (`http://localhost:11434/v1`, the same
  integration point already used for other OpenAI-compatible endpoints). Used
  for the qualitative reasoning/debate steps that still need a language model,
  at zero marginal cost, before falling through to a paid cloud model.
- **Cloud LLMs (Claude/OpenAI/etc via AIRouter)** - reserved for
  `ChiefTraderAgent`'s final consensus debate, and only triggered when the
  local ensemble's combined confidence lands in a genuinely uncertain band -
  see the cost-saving ensemble design discussed alongside this setup.
