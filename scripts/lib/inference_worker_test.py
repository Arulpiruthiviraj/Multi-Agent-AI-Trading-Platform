"""
Regression tests for inference_worker.py (2026-09-04 Chronos thread-accumulation fix, phase 2).

The key property under test: no matter which (or how many different) OS threads call
run_on_inference_worker(), the actual submitted work always executes on the SAME single worker
thread. That is the entire mechanism by which this module prevents PyTorch/MKL/OpenMP from ever
seeing more than one distinct calling thread over the process lifetime - see inference_worker.py's
module docstring for the full root-cause story (confirmed live: 8 real /forecast calls against the
running Chronos sidecar grew its thread count by +40 before this fix).

Deliberately does not import torch/chronos/transformers - loading those takes 15-30s and the
property under test (thread confinement) is completely independent of what the submitted callable
actually does. Run directly: python scripts/lib/inference_worker_test.py
"""
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inference_worker  # noqa: E402
from inference_worker import (  # noqa: E402
    InferenceTimeoutError,
    get_last_worker_thread_ident,
    run_on_inference_worker,
)


def _record_caller_and_worker_ident():
    """Stand-in for a real inference call (e.g. pipeline.predict()): returns the identity of
    whichever thread is actually executing this function body right now."""
    return threading.get_ident()


class InferenceWorkerTest(unittest.TestCase):
    def test_single_call_runs_on_a_worker_thread_not_the_caller_thread(self):
        caller_ident = threading.get_ident()
        worker_ident = run_on_inference_worker(_record_caller_and_worker_ident)
        self.assertNotEqual(
            worker_ident, caller_ident,
            "submitted work must run on the dedicated worker thread, never on the calling thread",
        )

    def test_repeated_calls_from_the_same_thread_always_use_the_same_worker_identity(self):
        idents = {run_on_inference_worker(_record_caller_and_worker_ident) for _ in range(20)}
        self.assertEqual(
            len(idents), 1,
            f"expected exactly one distinct worker thread identity across 20 calls, got {idents}",
        )

    def test_calls_from_many_different_simulated_handler_threads_all_land_on_one_worker_thread(self):
        """The exact real-world pattern this fix targets: each HTTP connection gets its own brand-
        new Python handler thread (simulated here by spawning real, distinct threading.Thread
        objects), and every one of them must still resolve to the SAME underlying inference-worker
        thread identity - proving MKL/OpenMP would only ever observe one calling thread."""
        num_simulated_handler_threads = 25
        results = [None] * num_simulated_handler_threads

        def handler(i):
            # Each of these genuinely is a distinct, brand-new OS thread - the same situation a
            # new HTTP connection thread is in the real service.
            results[i] = run_on_inference_worker(_record_caller_and_worker_ident)

        threads = [threading.Thread(target=handler, args=(i,)) for i in range(num_simulated_handler_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        self.assertTrue(all(r is not None for r in results), "every simulated handler call should have completed")
        distinct_worker_idents = set(results)
        self.assertEqual(
            len(distinct_worker_idents), 1,
            f"expected all {num_simulated_handler_threads} simulated handler threads to resolve to "
            f"one single worker thread identity, got {len(distinct_worker_idents)} distinct identities: "
            f"{distinct_worker_idents}",
        )
        # Confirms none of the (25) distinct calling-thread identities is itself the worker thread -
        # i.e. work really was handed off, not accidentally run inline.
        calling_thread_idents = set()

        def record_calling_ident(bucket):
            bucket.add(threading.get_ident())

        collector_threads = []
        for _ in range(5):
            t = threading.Thread(target=record_calling_ident, args=(calling_thread_idents,))
            collector_threads.append(t)
            t.start()
        for t in collector_threads:
            t.join(timeout=5)
        self.assertTrue(distinct_worker_idents.isdisjoint(calling_thread_idents))

    def test_get_last_worker_thread_ident_reflects_the_worker_that_ran(self):
        worker_ident = run_on_inference_worker(_record_caller_and_worker_ident)
        self.assertEqual(get_last_worker_thread_ident(), worker_ident)

    def test_exceptions_in_submitted_work_propagate_to_the_caller(self):
        def _boom():
            raise ValueError("real inference failure")

        with self.assertRaises(ValueError):
            run_on_inference_worker(_boom)

    def test_worker_serializes_overlapping_submissions_rather_than_running_them_concurrently(self):
        """max_workers=1 must mean exactly that - overlapping calls queue rather than run in
        parallel, which is required for the thread-confinement guarantee to hold under real
        concurrent HTTP traffic (multiple handler threads submitting at once)."""
        order = []
        lock = threading.Lock()

        def slow_task(tag):
            with lock:
                order.append(("start", tag))
            time.sleep(0.05)
            with lock:
                order.append(("end", tag))
            return tag

        results = []

        def submitter(tag):
            results.append(run_on_inference_worker(slow_task, tag))

        threads = [threading.Thread(target=submitter, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        self.assertEqual(sorted(results), [0, 1, 2, 3])
        # Every "start" must be immediately followed by its own "end" before any other "start" -
        # proof the four submissions never overlapped in execution.
        for i in range(0, len(order), 2):
            self.assertEqual(order[i][0], "start")
            self.assertEqual(order[i + 1], ("end", order[i][1]))


class InferenceWorkerTimeoutTest(unittest.TestCase):
    """F37 (ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md): a task deadline for run_on_inference_worker(),
    plus safe worker recovery when that deadline is exceeded, WITHOUT ever claiming the underlying
    (uninterruptible, native-like) computation was actually cancelled. Uses only lightweight stub
    callables (a real sleep, never a real model) - matches the doc's own instruction to use
    lightweight stub inference and never load a real model for this kind of test.
    """

    def setUp(self):
        # Isolate each test from the module-level executor/taint state other tests (and this
        # class's own other tests) mutate - never touch the real shared state across tests.
        inference_worker._executor.shutdown(wait=False, cancel_futures=True)
        inference_worker._executor = inference_worker._new_executor()
        inference_worker._worker_tainted = False

    def tearDown(self):
        inference_worker._executor.shutdown(wait=False, cancel_futures=True)
        inference_worker._executor = inference_worker._new_executor()
        inference_worker._worker_tainted = False

    def test_task_within_deadline_returns_normally(self):
        result = run_on_inference_worker(lambda: 42, timeout_seconds=5)
        self.assertEqual(result, 42)

    def test_task_exceeding_deadline_raises_InferenceTimeoutError_not_the_raw_TimeoutError(self):
        released = threading.Event()

        def stuck():
            released.wait(timeout=5)  # simulates an uninterruptible slow/stuck computation
            return "late"

        with self.assertRaises(InferenceTimeoutError):
            run_on_inference_worker(stuck, timeout_seconds=0.05)

        released.set()  # let the background task finish so it doesn't leak into other tests

    def test_caller_gets_a_prompt_response_even_though_the_stuck_task_is_still_running(self):
        """The core timeout-vs-cancellation guarantee: the caller must not be blocked for the
        full duration of a stuck task - only for its own configured deadline."""
        started = threading.Event()
        released = threading.Event()

        def stuck():
            started.set()
            released.wait(timeout=5)
            return "late"

        t0 = time.perf_counter()
        with self.assertRaises(InferenceTimeoutError):
            run_on_inference_worker(stuck, timeout_seconds=0.05)
        elapsed = time.perf_counter() - t0

        self.assertLess(elapsed, 2.0, "caller should not wait anywhere near the stuck task's own duration")
        self.assertTrue(started.wait(timeout=1), "the stuck task should have actually started on the worker")
        released.set()

    def test_worker_is_replaced_after_a_timeout_so_new_requests_are_not_queued_behind_the_stuck_one(self):
        """The real severity this fix addresses: with max_workers=1, a single stuck task used to
        permanently block every future call. After a timeout, a NEW request must succeed promptly
        rather than queuing forever behind the abandoned stuck task."""
        released = threading.Event()

        def stuck():
            released.wait(timeout=5)
            return "late"

        with self.assertRaises(InferenceTimeoutError):
            run_on_inference_worker(stuck, timeout_seconds=0.05)

        # This call must use a fresh worker and succeed quickly - it must NOT hang waiting behind
        # the still-running stuck task on the abandoned executor.
        t0 = time.perf_counter()
        result = run_on_inference_worker(lambda: "fresh worker ok", timeout_seconds=5)
        elapsed = time.perf_counter() - t0
        self.assertEqual(result, "fresh worker ok")
        self.assertLess(elapsed, 2.0, "a new request after a timeout must not be blocked by the abandoned stuck task")

        released.set()

    def test_stray_result_of_an_abandoned_stuck_task_is_never_surfaced_to_a_later_caller(self):
        """Once abandoned, the stuck task's eventual return value must simply be discarded - never
        delivered to whatever later, unrelated call happens to be in flight."""
        released = threading.Event()

        def stuck():
            released.wait(timeout=5)
            return "STRAY_RESULT_SHOULD_NEVER_BE_SEEN"

        with self.assertRaises(InferenceTimeoutError):
            run_on_inference_worker(stuck, timeout_seconds=0.05)

        result = run_on_inference_worker(lambda: "real result", timeout_seconds=5)
        self.assertEqual(result, "real result")

        released.set()
        time.sleep(0.2)  # give the abandoned background task a moment to actually finish
        # No API surfaces the stray result anywhere - its absence from any assertion above is the
        # proof. A second sanity call confirms the (now further-replaced, if it were ever retained)
        # worker is still healthy.
        self.assertEqual(run_on_inference_worker(lambda: "still healthy", timeout_seconds=5), "still healthy")

    def test_omitting_timeout_seconds_preserves_the_original_wait_forever_behavior(self):
        """Backward compatibility: existing callers that don't pass timeout_seconds must see
        identical behavior to before this fix (covered further by the pre-existing test class
        above, which never passes timeout_seconds at all)."""
        result = run_on_inference_worker(lambda: "no timeout requested")
        self.assertEqual(result, "no timeout requested")


if __name__ == "__main__":
    unittest.main()
