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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from chronos import ChronosPipeline

MODEL_NAME = os.environ.get("CHRONOS_MODEL", "amazon/chronos-t5-mini")
PORT = int(os.environ.get("LOCAL_AI_SERVICE_PORT", "8008"))
MIN_CONTEXT_LENGTH = 5

print(f"[local_ai_service] Loading {MODEL_NAME} (this happens once, at startup)...")
pipeline = ChronosPipeline.from_pretrained(MODEL_NAME, device_map="cpu", torch_dtype=torch.float32)
print(f"[local_ai_service] {MODEL_NAME} loaded and resident in memory.")


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/forecast":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            prices = body.get("prices")
            horizon = int(body.get("horizon", 5))

            if not isinstance(prices, list) or len(prices) < MIN_CONTEXT_LENGTH:
                self._send_json(400, {"error": f"'prices' must be a list of at least {MIN_CONTEXT_LENGTH} numbers"})
                return

            context = torch.tensor(prices, dtype=torch.float32)
            # num_samples=40 - enough to get a stable median/quantile spread without being slow
            # on CPU; this is a real sampled forecast distribution, not a single point guess.
            forecast = pipeline.predict(context, prediction_length=horizon, num_samples=40)[0]
            quantiles = torch.quantile(forecast, torch.tensor([0.1, 0.5, 0.9]), dim=0)

            self._send_json(200, {
                "model": MODEL_NAME,
                "low": quantiles[0].tolist(),
                "median": quantiles[1].tolist(),
                "high": quantiles[2].tolist(),
            })
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def log_message(self, format: str, *args) -> None:
        print(f"[local_ai_service] {format % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[local_ai_service] Listening on http://127.0.0.1:{PORT}")
    server.serve_forever()
