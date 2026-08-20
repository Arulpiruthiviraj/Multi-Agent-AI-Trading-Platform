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
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from chronos import ChronosPipeline
from transformers import pipeline as hf_pipeline

MODEL_NAME = os.environ.get("CHRONOS_MODEL", "amazon/chronos-t5-mini")
FINBERT_MODEL_NAME = os.environ.get("FINBERT_MODEL", "ProsusAI/finbert")
PORT = int(os.environ.get("LOCAL_AI_SERVICE_PORT", "8008"))
MIN_CONTEXT_LENGTH = 5

# Prefer CUDA, then Apple MPS, else CPU — never claim GPU when running on CPU/MPS.
if torch.cuda.is_available():
    DEVICE = "cuda"
elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"

LAST_INFERENCE_MS = 0.0


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


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        global LAST_INFERENCE_MS
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "sentimentModel": FINBERT_MODEL_NAME,
                "device": DEVICE,
                "memoryUsage": _memory_usage_label(),
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

            started = time.perf_counter()
            context = torch.tensor(prices, dtype=torch.float32)
            # num_samples=40 - enough to get a stable median/quantile spread without being slow
            # on CPU; this is a real sampled forecast distribution, not a single point guess.
            forecast = pipeline.predict(context, prediction_length=horizon, num_samples=40)[0]
            quantiles = torch.quantile(forecast, torch.tensor([0.1, 0.5, 0.9]), dim=0)
            LAST_INFERENCE_MS = round((time.perf_counter() - started) * 1000, 1)

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
            # avoids sending pathologically large payloads through the pipeline.
            result = sentiment_pipeline(text[:2000])[0]
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
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[local_ai_service] Listening on http://127.0.0.1:{PORT} device={DEVICE}")
    server.serve_forever()
