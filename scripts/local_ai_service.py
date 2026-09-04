#!/usr/bin/env python3
"""
Persistent local inference service backing KronosInference.ts's real forecast calls.

Loads Chronos once at startup and keeps it resident in memory - the model is NOT
reloaded per request. Run this separately from the main app (like `ollama serve`):

    npm run ai:serve

The Node app polls GET /health periodically and treats it as unavailable (not fatal)
if this process isn't running - see KronosModelManager.ts.
"""
import json
import os
import signal
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from bounded_http_server import BoundedThreadingHTTPServer, send_json_and_close, start_graceful_shutdown  # noqa: E402
from inference_worker import run_on_inference_worker  # noqa: E402

MODEL_NAME = os.environ.get("CHRONOS_MODEL", "amazon/chronos-t5-mini")
FINBERT_MODEL_NAME = os.environ.get("FINBERT_MODEL", "ProsusAI/finbert")
PORT = int(os.environ.get("LOCAL_AI_SERVICE_PORT", "8008"))
MIN_CONTEXT_LENGTH = 5
# See scripts/lib/bounded_http_server.py's own header for the full rationale (2026-09-04 thread-
# accumulation fix): a real ceiling on concurrent connections, and a bound on how long any one
# connection may sit before its handler thread is forced to give it up.
MAX_CONCURRENT_CONNECTIONS = int(os.environ.get("LOCAL_AI_SERVICE_MAX_CONNECTIONS", "8"))
CONNECTION_TIMEOUT_SECONDS = int(os.environ.get("LOCAL_AI_SERVICE_CONNECTION_TIMEOUT_S", "30"))

# Readiness/reliability pass (2026-09-04): scripts/lib/chronosLauncher.ts already guards both
# official startup paths (npm run dev's ecosystem launcher and the headless engine daemon) with a
# health-check-first + file lock, so two *launchers* racing can't double-spawn this script. What
# that TS-side guard cannot see is a direct, manual `npm run ai:serve` (or any other bare
# invocation of this file) racing against one of those launchers - the exact sequence that
# produced a real, observed duplicate instance live on 2026-09-03 (an operator/incident-response
# `npm run ai:serve` overlapped with the engine daemon's own ensureChronosRunning(), and both spent
# ~15-30s loading a full copy of Chronos+FinBERT into memory before only one could bind the port).
# Checking health here, before either expensive model load begins, protects every invocation path,
# not just the two already-guarded ones - and costs one cheap HTTP call on the common "nothing else
# running yet" path.
def _already_healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


if _already_healthy(PORT):
    print(f"[local_ai_service] Another instance is already healthy on port {PORT} - not loading a second copy. Exiting.")
    sys.exit(0)

import torch
from chronos import ChronosPipeline
from transformers import pipeline as hf_pipeline

# Prefer CUDA, then Apple MPS, else CPU — never claim GPU when running on CPU/MPS.
if torch.cuda.is_available():
    DEVICE = "cuda"
elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"

LAST_INFERENCE_MS = 0.0


def _committed_memory_mb():
    """
    Best-effort COMMITTED (not resident) memory for this process, in MB, or None.

    Why this exists separately from _memory_usage_label()'s RSS (2026-09-04 readiness audit):
    the real Chronos failure mode observed on this Windows host is commit-charge growth, NOT
    working-set growth. Measured live during that audit: 15,245.9 MB of pagefile/commit charge
    while RSS was 469.9 MB - Windows had simply trimmed the working set. Any monitor watching RSS
    alone therefore reports a comfortable number for the exact condition that precedes host
    commit-limit exhaustion and the silent Node engine deaths that audit was chasing.
    psutil's memory_info().vms is the pagefile/commit charge on Windows and the virtual size on
    POSIX; both are the right "how much has this process actually committed" signal here. Honest
    None (never a fabricated 0) when psutil is unavailable - the Node side records it as null.
    """
    try:
        import psutil  # optional
        return psutil.Process(os.getpid()).memory_info().vms / (1024 * 1024)
    except Exception:
        return None


def _thread_count():
    """
    Live OS thread count, or None.

    Reported because it is the leading indicator of the dominant commit-growth mechanism found by
    the 2026-09-04 audit, and one this service could not previously surface at all: the same
    instance measured at 15,245.9 MB of commit was holding 6,451 threads while having served ZERO
    inferences (lastInferenceMs was null). ThreadingHTTPServer starts one thread per connection, so
    a client holding HTTP keep-alive connections open pins a thread each, and every thread costs
    its committed stack reservation - which accumulates as commit charge that RSS never shows. This
    is NOT addressed by the torch.inference_mode() change (that fixes autograd retention on the
    inference path, a real but separate mechanism). Surfacing the count makes the remaining
    mechanism measurable instead of inferred. Honest None when psutil is unavailable.
    """
    try:
        import psutil  # optional
        return psutil.Process(os.getpid()).num_threads()
    except Exception:
        return None


def _memory_usage_label() -> str:
    """Best-effort RSS; honest N/A (CPU/MPS) when telemetry is unavailable or non-CUDA."""
    mb = None
    try:
        import psutil  # optional
        mb = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
    except Exception:
        try:
            import resource
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # Linux: KB; macOS: bytes
            mb = (rss / (1024 * 1024)) if sys.platform == "darwin" else (rss / 1024)
        except Exception:
            mb = None

    if DEVICE in ("cpu", "mps"):
        if mb is not None and mb >= 1:
            return f"{mb:.0f} MB · N/A (CPU/MPS)"
        return "N/A (CPU/MPS)"
    if mb is not None and mb >= 1:
        return f"{mb:.0f} MB"
    return "unknown"


print(f"[local_ai_service] Loading {MODEL_NAME} on {DEVICE} (this happens once, at startup)...")
pipeline = ChronosPipeline.from_pretrained(
    MODEL_NAME,
    device_map="cpu" if DEVICE != "cuda" else "cuda",
    torch_dtype=torch.float32,
)
print(f"[local_ai_service] {MODEL_NAME} loaded and resident in memory.")

print(f"[local_ai_service] Loading {FINBERT_MODEL_NAME} (this happens once, at startup)...")
sentiment_pipeline = hf_pipeline("sentiment-analysis", model=FINBERT_MODEL_NAME)
print(f"[local_ai_service] {FINBERT_MODEL_NAME} loaded and resident in memory.")


def _run_forecast_inference(prices, horizon):
    """The actual torch/Chronos work for one /forecast call. Always invoked via
    run_on_inference_worker() below - NEVER called directly from an HTTP handler thread. See
    scripts/lib/inference_worker.py's module docstring for why: calling this directly from a
    per-connection handler thread is exactly the mechanism that was confirmed live on 2026-09-04 to
    leak one native MKL/OpenMP thread pool per HTTP connection (thread count +40 across 8 real
    /forecast calls, even with connection concurrency bounded to 8)."""
    started = time.perf_counter()
    # torch.inference_mode() - this service only ever does forward inference, never backprop.
    # Without it, every call builds and retains a full autograd graph it never needs; over many
    # hours of repeated calls (KronosForecastAgent: up to 1/symbol/60s during market hours) that is
    # a well-documented PyTorch memory-accumulation pattern. Real, measured impact: this process's
    # committed memory grew to ~42.8GB after ~5 hours of a live trading session - directly
    # correlated with contemporaneous Windows "low virtual memory" events and a silent engine death
    # in the same window.
    with torch.inference_mode():
        context = torch.tensor(prices, dtype=torch.float32)
        # num_samples=40 - enough to get a stable median/quantile spread without being slow on CPU;
        # this is a real sampled forecast distribution, not a single point guess.
        forecast = pipeline.predict(context, prediction_length=horizon, num_samples=40)[0]
        quantiles = torch.quantile(forecast, torch.tensor([0.1, 0.5, 0.9]), dim=0)
    latency_ms = round((time.perf_counter() - started) * 1000, 1)
    return quantiles, latency_ms


def _run_sentiment_inference(text):
    """The actual torch/FinBERT work for one /sentiment call. Always invoked via
    run_on_inference_worker() below - never directly from an HTTP handler thread, for the same
    thread-confinement reason as _run_forecast_inference above."""
    # FinBERT truncates internally at 512 tokens; the caller already hard-caps text length before
    # this is called. Same inference_mode() rationale - forward-only, no autograd needed.
    with torch.inference_mode():
        return sentiment_pipeline(text)[0]


class Handler(BaseHTTPRequestHandler):
    # Bounds how long any one connection (idle keep-alive, slow client, or worse) may pin a handler
    # thread before the socket read simply times out - BaseHTTPRequestHandler (via
    # socketserver.StreamRequestHandler.setup()) applies this to the connection automatically.
    # Defense-in-depth alongside the explicit Connection: close below and the bounded thread pool
    # in scripts/lib/bounded_http_server.py - see that module's own header for the full rationale.
    timeout = CONNECTION_TIMEOUT_SECONDS

    def _send_json(self, status: int, payload: dict) -> None:
        send_json_and_close(self, status, payload)

    def do_GET(self) -> None:
        global LAST_INFERENCE_MS
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "sentimentModel": FINBERT_MODEL_NAME,
                "device": DEVICE,
                "memoryUsage": _memory_usage_label(),
                # Additive field (2026-09-04). Numeric, not a display label, so the Node side never
                # has to regex a human string for the one number that actually predicts the failure.
                # Null when psutil is unavailable - never a fabricated value. See
                # _committed_memory_mb() for why RSS alone is not sufficient on this host.
                "committedMemoryMb": _committed_memory_mb(),
                "threadCount": _thread_count(),
                "gpuUsage": "N/A (CPU/MPS)" if DEVICE in ("cpu", "mps") else "cuda",
                "lastInferenceMs": LAST_INFERENCE_MS if LAST_INFERENCE_MS > 0 else None,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/sentiment":
            self._handle_sentiment()
            return
        if self.path != "/forecast":
            self._send_json(404, {"error": "not found"})
            return
        global LAST_INFERENCE_MS
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            prices = body.get("prices")
            horizon = int(body.get("horizon", 5))

            if not isinstance(prices, list) or len(prices) < MIN_CONTEXT_LENGTH:
                self._send_json(400, {"error": f"'prices' must be a list of at least {MIN_CONTEXT_LENGTH} numbers"})
                return

            # Routed through the single dedicated inference-worker thread (2026-09-04 phase 2
            # fix) - this handler thread (a brand-new thread per HTTP connection) never itself
            # calls into torch/Chronos. See _run_forecast_inference's docstring and
            # scripts/lib/inference_worker.py for why: calling torch directly from here was
            # confirmed live to leak a native MKL/OpenMP thread pool per connection.
            quantiles, latency_ms = run_on_inference_worker(_run_forecast_inference, prices, horizon)
            LAST_INFERENCE_MS = latency_ms

            self._send_json(200, {
                "model": MODEL_NAME,
                "low": quantiles[0].tolist(),
                "median": quantiles[1].tolist(),
                "high": quantiles[2].tolist(),
                "latencyMs": LAST_INFERENCE_MS,
                "device": DEVICE,
            })
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _handle_sentiment(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = body.get("text")
            if not isinstance(text, str) or not text.strip():
                self._send_json(400, {"error": "'text' must be a non-empty string"})
                return

            # FinBERT truncates internally at 512 tokens; a hard character cap here just
            # avoids sending pathologically large payloads through the pipeline. Routed through
            # the single dedicated inference-worker thread for the same reason as /forecast above
            # - this handler thread never itself calls into torch/FinBERT.
            result = run_on_inference_worker(_run_sentiment_inference, text[:2000])
            label = result["label"].lower()
            score = float(result["score"])
            signed_score = score if label == "positive" else (-score if label == "negative" else 0.0)

            self._send_json(200, {
                "model": FINBERT_MODEL_NAME,
                "label": label,
                "score": score,
                "signedScore": signed_score,
            })
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def log_message(self, format: str, *args) -> None:
        print(f"[local_ai_service] {format % args}")


if __name__ == "__main__":
    server = BoundedThreadingHTTPServer(("127.0.0.1", PORT), Handler, MAX_CONCURRENT_CONNECTIONS)

    # Graceful shutdown (2026-09-04 reliability pass): previously this process had no signal
    # handling at all - the only way it stopped was an OS-level kill, leaving no chance to close
    # the listening socket or in-flight connections cleanly and contributing to "no orphan
    # sidecars" being merely hoped for rather than enforced.
    def _handle_shutdown_signal(signum, _frame):
        print(f"[local_ai_service] Received signal {signum} - shutting down cleanly.")
        start_graceful_shutdown(server)

    signal.signal(signal.SIGTERM, _handle_shutdown_signal)
    signal.signal(signal.SIGINT, _handle_shutdown_signal)

    print(
        f"[local_ai_service] Listening on http://127.0.0.1:{PORT} device={DEVICE} "
        f"(max {MAX_CONCURRENT_CONNECTIONS} concurrent connections, "
        f"{CONNECTION_TIMEOUT_SECONDS}s connection timeout)"
    )
    server.serve_forever()
