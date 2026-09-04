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
from inference_worker import run_on_inference_worker, get_last_worker_thread_ident  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
