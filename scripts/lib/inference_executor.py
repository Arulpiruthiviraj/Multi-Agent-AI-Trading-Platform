"""
Single-threaded inference executor for local_ai_service.py.

WHY THIS EXISTS (measured live, 2026-09-04 missed-opportunity forensic audit)
----------------------------------------------------------------------------
bounded_http_server.py (same-day, earlier fix) correctly bounded *connection-handling* threads,
and that part demonstrably works: 5 bare /health requests against the live sidecar moved its
thread count by exactly 0. But the leak continued anyway - the live instance still climbed from
~26 threads at startup to 1,613 threads / 15,811 MB committed in ~70 minutes.

An isolation experiment against the live process pinned the real mechanism precisely:

    5 sequential bare  /health   connections  -> +0 threads   (HTTP layer is clean)
    3 sequential real  /forecast inferences   -> +5 threads EACH, deterministically

+5 is not a coincidence: this host has 6 physical cores, so torch's CPU parallel backend builds a
worker team of (6 - 1) = 5 threads for the thread that enters a parallel region. Those teams are
pooled PER CALLING THREAD and are never reclaimed when that calling thread dies. ThreadingHTTPServer
hands every request to a brand-new thread, so every single inference call minted a fresh, permanently
orphaned 5-thread team. Bounding *concurrency* (8 at a time) cannot help, because the leak is driven
by how many DISTINCT threads have ever run a tensor op, not by how many run at once.

This also explains the otherwise-confusing RSS/commit split the earlier pass could not account for:
each orphaned thread reserves stack address space (commit) that Windows trims out of the working set
(RSS), which is why RSS read ~390 MB while commit was ~15.8 GB.

THE FIX
-------
Run every tensor op on ONE long-lived worker thread. Then exactly one thread ever enters a parallel
region, exactly one worker team is ever created, and total thread count is bounded for the life of
the process no matter how many inferences are served. Serializing is also the right call on its own
merits here: CPU inference already saturates all cores internally, so concurrent forecasts would
merely oversubscribe the same cores.

Kept torch-free and dependency-free so it can be exercised by a fast real test
(inference_executor_test.py) without paying the 15-30s Chronos+FinBERT model load - the same reason
bounded_http_server.py is a separate module.

SAFETY: this is a sidecar-local concurrency change. It touches no trading code, holds no broker
credentials, and cannot place, size, or approve an order. Chronos remains advisory-only input to
KronosForecastAgent, behind ChiefTrader -> RiskEngine -> OMS exactly as before.
"""
from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeoutError


class InferenceTimeout(Exception):
    """Raised when an inference exceeds its bounded wall-clock budget.

    Distinct from a generic Exception so the HTTP layer can answer 503 (busy/degraded, retry later)
    rather than 500 (this request was malformed) - a stuck model is a service-health condition, and
    KronosForecastAgent's documented contract is to report Chronos unavailable rather than to
    fabricate a forecast.
    """


class SingleThreadInferenceExecutor:
    """Serializes every inference onto one long-lived worker thread.

    A ThreadPoolExecutor with max_workers=1 creates its worker lazily on first submit and then
    reuses that exact same thread forever - which is the whole point here: the invariant that
    matters is not "only one at a time" but "only ever ONE distinct thread runs tensor ops", since
    torch's per-calling-thread worker teams are never reclaimed.
    """

    def __init__(self, timeout_seconds: float, thread_name: str = "inference") -> None:
        # Validated before the executor exists so a misconfiguration fails loudly at startup rather
        # than turning into an instant timeout on the first real forecast of a trading session.
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        self._timeout_seconds = timeout_seconds
        # Not daemon-configurable: ThreadPoolExecutor threads are non-daemon and joined at
        # interpreter exit, so an in-flight inference finishes instead of being torn out mid-tensor.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=thread_name)
        self._worker_thread_ids: set[int] = set()
        self._lock = threading.Lock()

    def run(self, fn, *args, **kwargs):
        """Run `fn` on the dedicated inference thread and return its result.

        Propagates whatever `fn` raises (so callers keep their existing error handling), except that
        exceeding the time budget raises InferenceTimeout.
        """
        future: Future = self._executor.submit(self._record_thread_and_call, fn, *args, **kwargs)
        try:
            return future.result(timeout=self._timeout_seconds)
        except FutureTimeoutError as exc:
            # The work itself keeps running on the worker thread - cancelling a running future is
            # not possible in Python, and killing a thread mid-tensor-op would corrupt torch state.
            # Answering "unavailable" now while it drains is the honest, safe behavior; the next
            # request simply queues behind it.
            raise InferenceTimeout(
                f"inference exceeded {self._timeout_seconds}s budget"
            ) from exc

    def _record_thread_and_call(self, fn, *args, **kwargs):
        with self._lock:
            self._worker_thread_ids.add(threading.get_ident())
        return fn(*args, **kwargs)

    @property
    def distinct_worker_thread_count(self) -> int:
        """How many distinct threads have ever executed work here.

        This is the invariant the whole fix rests on, so it is observable (and assertable in tests)
        rather than merely asserted in a comment. It must stay 1 for the life of the process.
        """
        with self._lock:
            return len(self._worker_thread_ids)

    def shutdown(self, wait: bool = True) -> None:
        self._executor.shutdown(wait=wait)
