"""
Single dedicated inference-worker thread (2026-09-04 Chronos thread-accumulation fix, phase 2).

Phase 1 (bounded_http_server.py, same day) fixed the HTTP-layer symptom: an unbounded
ThreadingHTTPServer spawning one connection thread per client with no ceiling. That fix was real
but insufficient. Confirmed live against the actual running Chronos sidecar on 2026-09-04: 8 real
sequential POST /forecast calls grew its OS thread count from 1913 to 1953 (+40, i.e. ~5 threads
per call) and its committed (pagefile) memory by ~214MB, even with BoundedThreadingHTTPServer
capping concurrent connections to 8 the entire time.

Root cause: ThreadingHTTPServer (even bounded to N concurrent) still hands each accepted
connection a BRAND NEW `threading.Thread` object - never a thread drawn from a fixed, reused pool.
The first time any given OS thread calls into PyTorch/MKL/OpenMP-backed code (pipeline.predict()
inside torch.inference_mode(), or FinBERT's sentiment_pipeline()), those native backends
initialize a per-calling-thread native worker-thread pool. That native pool is cached at the
process level, keyed by the originating thread, and is NEVER torn down when the calling Python
thread later exits. Because every new HTTP connection is, by construction, the first (and only)
caller on its own brand-new handler thread, every single connection that reaches /forecast or
/sentiment leaks one more native thread pool - a mechanism completely independent of the bounded
semaphore on how many connections may be concurrently open (that bound limits concurrency, not the
number of distinct threads that have ever called into torch over the process lifetime).

The fix: confine every torch/pipeline/sentiment call in the whole process to ONE single,
long-lived worker thread, created once at import time and never replaced or recreated. Every HTTP
handler thread submits its inference work to this executor and blocks on the result - it never
calls pipeline.predict()/sentiment_pipeline() directly itself. MKL/OpenMP then only ever observes
ONE calling thread for the entire lifetime of the process, so its native pool is created at most
once and never grows again regardless of how many HTTP connections/handler threads come and go.

Kept deliberately independent of Chronos/FinBERT (like bounded_http_server.py) so it can be
exercised by a fast, real test without loading either model - the property under test (thread
confinement) has nothing to do with what the submitted work actually does.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional, TypeVar

T = TypeVar("T")

# max_workers=1 is the entire point of this module - see the module docstring. Never raise this;
# doing so reintroduces the exact per-thread native-pool leak this module exists to eliminate.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="inference-worker")

# Populated every time the worker thread actually runs a submitted task. Exposed so tests (and
# forensic/diagnostic code) can assert that every inference call really did run on the same OS
# thread, rather than merely trusting that max_workers=1 implies it.
_worker_thread_ident: Optional[int] = None
_worker_thread_ident_lock = threading.Lock()


def _record_and_get_thread_identity() -> int:
    global _worker_thread_ident
    ident = threading.get_ident()
    with _worker_thread_ident_lock:
        _worker_thread_ident = ident
    return ident


def run_on_inference_worker(fn: Callable[..., T], *args, **kwargs) -> T:
    """Run fn(*args, **kwargs) on the single dedicated inference worker thread and block until it
    completes. Whatever thread calls this (e.g. a per-connection HTTP handler thread) never itself
    executes fn - only the one persistent worker thread does. Exceptions raised by fn propagate
    to the caller unchanged (concurrent.futures.Future.result() re-raises transparently)."""

    def _task() -> T:
        _record_and_get_thread_identity()
        return fn(*args, **kwargs)

    future = _executor.submit(_task)
    return future.result()


def get_last_worker_thread_ident() -> Optional[int]:
    """Test/diagnostic hook: the OS thread identity the inference worker most recently ran on.
    None if no work has been submitted yet."""
    with _worker_thread_ident_lock:
        return _worker_thread_ident
