"""
Isolated TimesFM forecasting service (SHADOW / RESEARCH only).

Loopback-only stdlib HTTP server; no Argus imports, no broker credentials, no DB access.
The model is loaded lazily ONCE and only if `timesfm` is installed in this venv; otherwise the
service stays up and reports MODEL_NOT_INSTALLED (readiness false) rather than crashing or retrying
a failing load forever. Pinned target: google/timesfm-2.5-200m-pytorch (Apache-2.0 weights).
TimesFM 3.0 weights are non-commercial/non-production and are intentionally NOT supported here.

  GET  /health        liveness
  GET  /ready         readiness (model loaded)
  GET  /model-info    versions, device, limits
  POST /forecast      {symbol, timeframe, origin, horizon, closes:[...], timestamps:[...]} -> point + quantiles
"""
import json
import math
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("TIMESFM_HOST", "127.0.0.1")
PORT = int(os.environ.get("TIMESFM_PORT", "8011"))
MODEL_ID = os.environ.get("TIMESFM_MODEL_ID", "google/timesfm-2.5-200m-pytorch")
MAX_CONTEXT = int(os.environ.get("TIMESFM_MAX_CONTEXT", "1024"))
MAX_HORIZON = int(os.environ.get("TIMESFM_MAX_HORIZON", "64"))
MAX_BODY = int(os.environ.get("TIMESFM_MAX_BODY_BYTES", str(2_000_000)))
MAX_CONCURRENT = int(os.environ.get("TIMESFM_MAX_CONCURRENT", "1"))
MAX_QUEUE = int(os.environ.get("TIMESFM_MAX_QUEUE", "4"))
APPROVED_MODELS = {"google/timesfm-2.5-200m-pytorch"}

_gate = threading.Semaphore(MAX_CONCURRENT)
_queued = 0
_queued_lock = threading.Lock()
_state = {"status": "NOT_LOADED", "error": None, "model": None, "load_seconds": None, "device": "cpu", "forecasts": 0, "failures": 0}
_load_lock = threading.Lock()
_load_attempted = False


def _load_model():
    """One load attempt per process. A failed load is remembered; no automatic retry loop."""
    global _load_attempted
    with _load_lock:
        if _load_attempted:
            return
        _load_attempted = True
        if MODEL_ID not in APPROVED_MODELS:
            _state.update(status="MODEL_NOT_APPROVED", error=f"{MODEL_ID} is not an approved (Apache-2.0) checkpoint")
            return
        try:
            import numpy as np  # noqa: F401
            import timesfm
        except Exception as e:  # not installed
            _state.update(status="MODEL_NOT_INSTALLED", error=f"{type(e).__name__}: {e}")
            return
        try:
            t0 = time.time()
            m = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
            m.compile(timesfm.ForecastConfig(
                max_context=MAX_CONTEXT, max_horizon=MAX_HORIZON, normalize_inputs=True,
                use_continuous_quantile_head=True, force_flip_invariance=True,
                infer_is_positive=True, fix_quantile_crossing=True))
            _state.update(status="READY", model=m, load_seconds=round(time.time() - t0, 2), error=None)
        except Exception as e:
            _state.update(status="LOAD_FAILED", error=f"{type(e).__name__}: {e}")


def validate_request(body):
    """Pure validation, unit-testable without the model. Returns (clean, error)."""
    if not isinstance(body, dict):
        return None, "body must be an object"
    closes, ts = body.get("closes"), body.get("timestamps")
    horizon = body.get("horizon")
    if not isinstance(closes, list) or not isinstance(ts, list) or len(closes) != len(ts):
        return None, "closes and timestamps must be equal-length arrays"
    if not isinstance(horizon, int) or isinstance(horizon, bool) or not (1 <= horizon <= MAX_HORIZON):
        return None, f"horizon must be an integer in [1,{MAX_HORIZON}]"
    if len(closes) < 32:
        return None, "insufficient history (need >= 32 observations)"
    if len(closes) > MAX_CONTEXT:
        closes, ts = closes[-MAX_CONTEXT:], ts[-MAX_CONTEXT:]
    for c in closes:
        if isinstance(c, bool) or not isinstance(c, (int, float)) or not math.isfinite(c) or c <= 0:
            return None, "closes must be finite positive numbers"
    for a, b in zip(ts, ts[1:]):
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or not b > a:
            return None, "timestamps must be strictly increasing (no duplicates / out-of-order)"
    if len(set(closes)) == 1:
        return None, "constant series carries no forecastable information"
    return {"closes": [float(c) for c in closes], "timestamps": ts, "horizon": horizon}, None


def forecast(clean):
    import numpy as np
    m = _state["model"]
    t0 = time.time()
    point, q = m.forecast(horizon=clean["horizon"], inputs=[np.asarray(clean["closes"], dtype="float32")])
    point, q = np.asarray(point)[0], np.asarray(q)[0]
    if not (np.isfinite(point).all() and np.isfinite(q).all()):
        raise ValueError("non-finite forecast output")
    return {
        "point": [float(x) for x in point],
        "quantiles": {
            "levels": ["mean", 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
            "values": [[float(v) for v in row] for row in q],
        },
        "latencyMs": round((time.time() - t0) * 1000, 1),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):  # keep stdout quiet
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "ok"})
        if self.path == "/ready":
            _load_model()
            ready = _state["status"] == "READY"
            return self._send(200 if ready else 503, {"ready": ready, "status": _state["status"], "error": _state["error"]})
        if self.path == "/model-info":
            return self._send(200, {
                "modelId": MODEL_ID, "status": _state["status"], "device": _state["device"],
                "loadSeconds": _state["load_seconds"], "maxContext": MAX_CONTEXT, "maxHorizon": MAX_HORIZON,
                "maxConcurrent": MAX_CONCURRENT, "forecasts": _state["forecasts"], "failures": _state["failures"],
                "pid": os.getpid()})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        global _queued
        if self.path != "/forecast":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(413, {"error": "body size out of bounds"})
        try:
            body = json.loads(self.rfile.read(n))
        except Exception:
            return self._send(400, {"error": "invalid json"})
        clean, err = validate_request(body)
        if err:
            return self._send(422, {"error": err, "code": "INVALID_INPUT"})
        _load_model()
        if _state["status"] != "READY":
            return self._send(503, {"error": _state["error"], "code": _state["status"]})
        with _queued_lock:
            if _queued >= MAX_QUEUE:
                return self._send(429, {"error": "queue full", "code": "QUEUE_FULL"})
            _queued += 1
        try:
            with _gate:
                out = forecast(clean)
            _state["forecasts"] += 1
            out.update(modelId=MODEL_ID, symbol=body.get("symbol"), timeframe=body.get("timeframe"), origin=body.get("origin"),
                       horizon=clean["horizon"], inputCutoff=clean["timestamps"][-1], traceId=str(uuid.uuid4()), device=_state["device"])
            self._send(200, out)
        except Exception as e:
            _state["failures"] += 1
            self._send(500, {"error": f"{type(e).__name__}: {e}", "code": "INFERENCE_FAILED"})
        finally:
            with _queued_lock:
                _queued -= 1


if __name__ == "__main__":
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        sys.exit("TimesFM service binds loopback only")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[timesfm] listening on {HOST}:{PORT} model={MODEL_ID} (lazy load)", flush=True)
    srv.serve_forever()
