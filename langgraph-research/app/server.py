#!/usr/bin/env python3
"""
LangGraph research service - isolated advisory companion
(docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md). Run this separately from the main Argus
process, exactly like `npm run ai:serve` (Chronos) or the Java Quant Core jar:

    python langgraph-research/app/server.py

or via scripts/lib/langGraphLauncher.ts when LANGGRAPH_RESEARCH_ENABLED=true.

Deliberately minimal HTTP surface (stdlib http.server, same convention as
scripts/local_ai_service.py - no Flask/FastAPI dependency added for this):

    GET  /health                                  - liveness + capability info
    POST /v1/strategy-graduation-recommendation    - the one real workflow

No other endpoint exists. No arbitrary Python execution, no arbitrary tool execution, no
filesystem access, no database access, no shell execution is reachable through this API - the only
outbound calls this process ever makes are (a) one read-only GET to Argus's own
research/strategy-evidence route, and (b) local Ollama chat completions. Binds to 127.0.0.1 only.
"""
from __future__ import annotations

import json
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pydantic import ValidationError

from . import config
from .graph import run_strategy_graduation_graph
from .logging_setup import log_event
from .schemas import HealthResponse, StrategyGraduationRequest

CAPABILITIES = ["strategy-graduation-recommendation"]


def _run_graph_bounded(strategy_id: str, correlation_id: str) -> dict:
    """Runs the graph on a worker thread and enforces config.MAX_GRAPH_EXECUTION_S at the HTTP
    layer - if the graph itself hangs (e.g. a stuck local model call somehow ignoring its own
    requests timeout), the HTTP response still returns on time rather than blocking forever. The
    worker thread is a daemon thread; if it never returns, it is abandoned (no side effects to
    clean up - nothing this graph does writes anywhere itself)."""
    result_holder: dict = {}

    def _target():
        result_holder["value"] = run_strategy_graduation_graph(strategy_id, correlation_id)

    started = time.monotonic()
    worker = threading.Thread(target=_target, daemon=True)
    worker.start()
    worker.join(timeout=config.MAX_GRAPH_EXECUTION_S)
    if "value" in result_holder:
        return result_holder["value"]

    duration_ms = (time.monotonic() - started) * 1000
    return {
        "runId": str(uuid.uuid4()),
        "correlationId": correlation_id,
        "strategyId": strategy_id,
        "graphVersion": config.GRAPH_VERSION,
        "status": "FAILED",
        "result": None,
        "error": "GRAPH_EXECUTION_TIMEOUT",
        "durationMs": duration_ms,
        "nodesExecuted": [],
        "providerModel": None,
    }


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away - nothing left to do

    def do_GET(self) -> None:
        if self.path == "/health":
            payload = HealthResponse(status="ok", service="langgraph-research", version=config.GRAPH_VERSION, capabilities=CAPABILITIES)
            self._send_json(200, payload.model_dump())
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/strategy-graduation-recommendation":
            self._send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 8192:  # this request body is two short strings - no legitimate payload is large
                self._send_json(413, {"error": "PAYLOAD_TOO_LARGE"})
                return
            raw = self.rfile.read(length) or b"{}"
            body = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "MALFORMED_JSON"})
            return

        try:
            req = StrategyGraduationRequest.model_validate(body)
        except ValidationError as e:
            self._send_json(400, {"error": "INVALID_REQUEST", "detail": str(e)})
            return

        log_event("run_started", correlation_id=req.correlationId, strategy_id=req.strategyId)
        result = _run_graph_bounded(req.strategyId, req.correlationId)
        log_event(
            "run_completed", correlation_id=req.correlationId, strategy_id=req.strategyId,
            status=result.get("status"), duration_ms=result.get("durationMs"),
            nodes_executed=result.get("nodesExecuted"),
        )
        self._send_json(200, result)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - matches BaseHTTPRequestHandler's own signature
        print(f"[langgraph-research] {format % args}")


def main() -> None:
    httpd = ThreadingHTTPServer(("127.0.0.1", config.PORT), Handler)
    httpd.daemon_threads = True

    def _graceful_shutdown(signum, frame):  # noqa: ARG001
        print(f"[langgraph-research] Received signal {signum}, shutting down.")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _graceful_shutdown)
    signal.signal(signal.SIGTERM, _graceful_shutdown)

    print(f"[langgraph-research] Listening on http://127.0.0.1:{config.PORT} model={config.OLLAMA_MODEL}")
    httpd.serve_forever()
    httpd.server_close()
    print("[langgraph-research] Stopped.")


if __name__ == "__main__":
    main()
