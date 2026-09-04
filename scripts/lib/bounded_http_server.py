"""
Bounded, connection-safe HTTP server building blocks for local_ai_service.py.

Real thread-accumulation mechanism found live (2026-09-04 readiness audit): the plain
http.server.ThreadingHTTPServer this service used spawns one thread per accepted connection with
no upper bound. The observed instance held 6,451 threads and 15,245.9 MB of committed (pagefile)
memory while having served ZERO inferences - RSS stayed low (Windows trims the working set of
threads whose stacks are reserved but idle) so the existing memory sampler read "NORMAL" the whole
time. torch.inference_mode() (a real, separate fix - it prevents autograd-graph retention on the
inference path) could not have addressed this, since the growth predated any inference call.

Kept deliberately independent of Chronos/FinBERT so it can be exercised by a fast, real test
(bounded_http_server_test.py) without loading either model - the model-loading time (15-30s) is
exactly why this repo does not have an existing test for local_ai_service.py's HTTP layer.

Three independent, composable defenses (any one alone would help; together they cover a mechanism
this investigation could not fully pin down from source reading alone, since Python's own
http.server connection-persistence logic is more subtle than it first appears):

1. BoundedThreadingHTTPServer - a real ceiling on concurrent connection-handling threads via a
   bounded semaphore. A connection beyond the ceiling waits at the OS accept-queue level instead of
   spawning an unbounded new thread.
2. force_close_after_response() - explicitly send `Connection: close` and set close_connection=True
   on every response, rather than relying on protocol-version/header inference to decide whether a
   connection may be kept alive. Removes ambiguity instead of reasoning about it.
3. A handler `timeout` (applied via BaseHTTPRequestHandler/StreamRequestHandler's own `self.timeout`
   class attribute) bounds how long any one connection - idle, slow, or malicious - can pin a thread
   before the socket read simply times out.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a hard ceiling on concurrent connection-handling threads.

    daemon_threads is already True on ThreadingHTTPServer (verified: cpython sets this at the class
    level) - handler threads never block process exit. This class adds the concurrency ceiling that
    stock ThreadingHTTPServer does not have at all.
    """

    def __init__(self, server_address, handler_class, max_concurrent_connections: int):
        # Validated before binding the listening socket (super().__init__()) - failing after
        # binding would leak an unclosed socket for a construction that never completed.
        if max_concurrent_connections < 1:
            raise ValueError("max_concurrent_connections must be >= 1")
        super().__init__(server_address, handler_class)
        self.max_concurrent_connections = max_concurrent_connections
        self._connection_semaphore = threading.BoundedSemaphore(max_concurrent_connections)

    def process_request(self, request, client_address):
        # Runs on the single accept-loop thread - blocks (bounded backpressure, not an error) once
        # the ceiling is reached, rather than spawning an unbounded new thread.
        self._connection_semaphore.acquire()
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        # Runs on the spawned per-connection thread. Released here (not in process_request, which
        # only launches the thread and returns immediately) so the slot is held for the connection's
        # real lifetime, not just the moment of acceptance.
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_semaphore.release()


def send_json_and_close(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    """Send a JSON response and force this connection closed, unambiguously - never left for
    protocol-version/header inference to decide whether it may be kept alive."""
    body = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.wfile.write(body)
    handler.close_connection = True


def start_graceful_shutdown(server: ThreadingHTTPServer) -> None:
    """server.shutdown() must be called from a thread OTHER than the one running serve_forever()
    (calling it from the same thread deadlocks, per the stdlib's own documented contract) - signal
    handlers run on the main thread, which is the same thread that calls serve_forever(), so this
    always hands the actual shutdown off to a short-lived daemon thread."""
    threading.Thread(target=server.shutdown, daemon=True).start()
