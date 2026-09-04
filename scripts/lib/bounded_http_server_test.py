"""
Regression tests for bounded_http_server.py (2026-09-04 thread-accumulation fix).

Deliberately uses a trivial dummy handler, never Chronos/FinBERT - loading those models takes
15-30s (measured live) and would make this test far too slow to run routinely; the behavior under
test is the HTTP/threading layer, which is completely independent of what the handler does with a
request once it has one.

Run directly: python scripts/lib/bounded_http_server_test.py
(stdlib unittest only - no new test framework dependency for one script's supporting module.)
"""
import http.client
import os
import sys
import threading
import time
import unittest

try:
    import psutil
except ImportError:
    psutil = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bounded_http_server import BoundedThreadingHTTPServer, send_json_and_close, start_graceful_shutdown  # noqa: E402
from http.server import BaseHTTPRequestHandler  # noqa: E402


class EchoHandler(BaseHTTPRequestHandler):
    """Minimal handler standing in for local_ai_service.py's real one - same connection lifecycle,
    trivial body, so these tests exercise exactly the threading/connection behavior under test."""
    timeout = 5

    def do_GET(self):
        if self.path == "/slow":
            time.sleep(0.3)  # simulates a real /forecast call's non-trivial handling time
        send_json_and_close(self, 200, {"ok": True, "path": self.path})

    def log_message(self, format, *args):
        pass  # keep test output quiet


def _own_thread_count() -> int:
    if psutil is None:
        return threading.active_count()  # coarser fallback, still meaningful for these assertions
    return psutil.Process(os.getpid()).num_threads()


class BoundedThreadingHTTPServerTest(unittest.TestCase):
    def setUp(self):
        self.server = BoundedThreadingHTTPServer(("127.0.0.1", 0), EchoHandler, max_concurrent_connections=4)
        self.port = self.server.server_address[1]
        self.serve_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.serve_thread.start()

    def tearDown(self):
        start_graceful_shutdown(self.server)
        self.serve_thread.join(timeout=5)
        self.server.server_close()

    def _get(self, path="/health"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            resp.read()
            return resp.status
        finally:
            conn.close()

    def test_repeated_sequential_requests_do_not_grow_thread_count(self):
        """The exact real-world pattern that caused the original leak: repeated polling
        (KronosModelManager.ts's /health loop) over time, one request after another."""
        baseline = _own_thread_count()
        for _ in range(60):
            status = self._get("/health")
            self.assertEqual(status, 200)
        time.sleep(0.5)  # let any transient handler threads fully wind down
        after = _own_thread_count()
        # A real leak would show growth roughly proportional to request count (60+); a small,
        # bounded delta here is normal thread-pool churn, not accumulation.
        self.assertLess(after - baseline, 10, f"thread count grew from {baseline} to {after} after 60 sequential requests")

    def test_concurrent_requests_stay_within_the_configured_bound(self):
        """20 concurrent slow requests against a max_concurrent_connections=4 server must never
        let more than a small bounded number of SERVER-SIDE handler threads run at once - the
        client side of this same test necessarily spawns its own 20 threads too (it is a same-
        process test), so those are accounted for explicitly rather than conflated with the
        server's own thread count."""
        baseline = _own_thread_count()
        results = []
        client_threads_spawned = 20

        def worker():
            results.append(self._get("/slow"))

        threads = [threading.Thread(target=worker) for _ in range(client_threads_spawned)]
        for t in threads:
            t.start()
        time.sleep(0.15)  # let the burst actually contend for the bound mid-flight
        peak = _own_thread_count()
        for t in threads:
            t.join(timeout=10)

        self.assertTrue(all(s == 200 for s in results), "every request should still eventually succeed, just queued")
        # peak includes: baseline + all 20 client-side test threads (known, expected, not what is
        # under test) + whatever server-side handler threads are concurrently running. Subtracting
        # the known client-side count isolates the server's own thread growth, which must stay near
        # the configured bound of 4 (a small margin covers legitimate interpreter/accept-loop
        # bookkeeping, not unbounded per-connection growth).
        server_side_delta = peak - baseline - client_threads_spawned
        self.assertLess(server_side_delta, 4 + 4, f"server-side thread count grew by {server_side_delta} (peak {peak}, baseline {baseline}, {client_threads_spawned} known client threads) during a 20-request burst against a bound of 4")

    def test_server_shuts_down_cleanly_and_releases_the_listening_socket(self):
        port = self.port
        self.assertEqual(self._get("/health"), 200)
        start_graceful_shutdown(self.server)
        self.serve_thread.join(timeout=5)
        self.assertFalse(self.serve_thread.is_alive(), "serve_forever's thread must actually exit on shutdown")
        self.server.server_close()
        # A closed server must not still be answering.
        with self.assertRaises(Exception):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            conn.request("GET", "/health")
            conn.getresponse()

    def test_max_concurrent_connections_must_be_at_least_one(self):
        with self.assertRaises(ValueError):
            BoundedThreadingHTTPServer(("127.0.0.1", 0), EchoHandler, max_concurrent_connections=0)


if __name__ == "__main__":
    unittest.main()
