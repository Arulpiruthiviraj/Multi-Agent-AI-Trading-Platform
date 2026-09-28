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

F37 (ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md) - task deadline + timeout-vs-cancellation:

`run_on_inference_worker()` previously called `future.result()` with no deadline at all. Because
this module's single worker thread processes its internal task queue strictly serially (that
seriality is the entire point - see above), a genuinely stuck native call (a pathological input,
a hung native library call, anything that never returns) does not just fail its own request: it
permanently blocks every *subsequent* call to this function for the remaining lifetime of the
process, since nothing else is ever allowed to run on that one thread. That is a full, silent,
unrecoverable denial of service for both /forecast and /sentiment, worse than a single slow
request.

A `future.result(timeout=...)` alone does not fix this. `Future.result(timeout=N)` raises
`TimeoutError` when the deadline passes, but the submitted callable keeps running on the worker
thread exactly as before - `Future.cancel()` only prevents a task that HAS NOT YET STARTED from
starting; it cannot interrupt one already executing (see concurrent.futures docs). Native
torch/MKL/OpenMP inference code is not a checkpointed Python loop that could poll a cancellation
flag either, so there is no cooperative-cancellation path available here. Treating a timeout as
"cancelled" would therefore be a lie: the computation may still be running and could still, in
principle, mutate shared state it was given a reference to.

The safe recovery this module implements is worker-tainting, not interruption: once a call times
out, the module (a) immediately raises `InferenceTimeoutError` back to the caller so the HTTP
handler can respond without waiting further, and (b) marks the CURRENT executor's sole thread as
tainted so no future request is ever queued behind it again - the next call transparently starts
a brand-new single-worker executor. The old thread is neither joined nor force-killed (Python has
no safe API to kill a running thread); it is abandoned to either finish naturally (its result is
then simply discarded - nothing reads it) or run forever consuming one thread's worth of
resources. This is a deliberate, disclosed trade-off: MKL/OpenMP will initialize a new per-thread
native pool the first time the replacement worker thread calls into torch - reintroducing, in a
strictly bounded way, the exact per-thread native-pool growth this module was originally built to
eliminate. That is only acceptable because it happens at most once per CONFIRMED-stuck event
(an operator-visible, rare occurrence - not a per-request cost), and a bounded, one-time thread-pool
increment is a far smaller failure than a permanently wedged sole worker refusing all future
inference for the rest of the process's life. Do not "fix" this by canceling/killing the old
thread (there is no safe way to do so without risking corrupted shared state or crashing the
interpreter) and do not remove the taint-and-replace step (that reintroduces the original
deadlock).
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutureTimeoutError
from typing import Callable, Optional, TypeVar

T = TypeVar("T")


class InferenceTimeoutError(RuntimeError):
    """Raised when a task submitted to run_on_inference_worker() does not complete within its
    deadline. This does NOT mean the underlying computation was cancelled or stopped - see this
    module's docstring, 'F37 ... timeout-vs-cancellation'. The stray computation may still be
    running in the background on an now-abandoned worker thread; its eventual result (or
    exception) is discarded, never surfaced to any caller."""


def _new_executor() -> ThreadPoolExecutor:
    # max_workers=1 is the entire point of this module - see the module docstring. Never raise
    # this; doing so reintroduces the exact per-thread native-pool leak this module exists to
    # eliminate.
    return ThreadPoolExecutor(max_workers=1, thread_name_prefix="inference-worker")


_executor_lock = threading.Lock()
_executor: ThreadPoolExecutor = _new_executor()
# Set the moment a task on the CURRENT `_executor` times out. While true, the next call to
# run_on_inference_worker() retires that executor (without waiting for or cancelling its
# in-flight task - see module docstring) and starts a fresh one, rather than ever queuing new
# work behind a thread that may still be permanently stuck.
_worker_tainted = False

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


def run_on_inference_worker(fn: Callable[..., T], *args, timeout_seconds: Optional[float] = None, **kwargs) -> T:
    """Run fn(*args, **kwargs) on the single dedicated inference worker thread and block until it
    completes or `timeout_seconds` elapses (None/omitted = wait forever, the pre-F37 behavior -
    callers handling untrusted/unbounded work should always pass a real deadline).

    Whatever thread calls this (e.g. a per-connection HTTP handler thread) never itself executes
    fn - only a persistent worker thread does. Exceptions raised by fn propagate to the caller
    unchanged. On a timeout, raises `InferenceTimeoutError` instead - see this module's docstring
    for why that is not the same as cancellation, and how the worker is safely retired/replaced so
    the timeout of one call can never permanently pin every future call behind it."""
    global _executor, _worker_tainted

    with _executor_lock:
        if _worker_tainted:
            # Do not wait for or cancel the old executor's in-flight task (see module docstring -
            # there is no safe way to interrupt native inference code). cancel_futures=True only
            # discards tasks that never started; it cannot touch the one currently running.
            _executor.shutdown(wait=False, cancel_futures=True)
            _executor = _new_executor()
            _worker_tainted = False
        exec_ref = _executor

    def _task() -> T:
        _record_and_get_thread_identity()
        return fn(*args, **kwargs)

    future = exec_ref.submit(_task)
    try:
        return future.result(timeout=timeout_seconds)
    except _FutureTimeoutError:
        with _executor_lock:
            if exec_ref is _executor:
                _worker_tainted = True
        raise InferenceTimeoutError(
            f"inference task did not complete within {timeout_seconds}s - the worker thread may "
            "still be running it in the background; its result will be discarded, and a fresh "
            "worker will handle subsequent requests"
        ) from None


def get_last_worker_thread_ident() -> Optional[int]:
    """Test/diagnostic hook: the OS thread identity the inference worker most recently ran on.
    None if no work has been submitted yet."""
    with _worker_thread_ident_lock:
        return _worker_thread_ident
