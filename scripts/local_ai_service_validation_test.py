"""
F37 (ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md) regression tests for local_ai_service.py's request-
admission validation: bounded Content-Length, bounded/finite `prices`, bounded `horizon`.

local_ai_service.py has no pre-existing test file (checked before writing this one), and its
module-level code unconditionally loads torch/Chronos/FinBERT (15-30s, real model weights) unless
`_already_healthy(PORT)` short-circuits with `sys.exit(0)` first - exactly the guard the module
already uses to avoid double-loading when another instance is already serving. This test reuses
that SAME guard (by binding a lightweight dummy HTTP health responder on the target port before
importing) to reach the pure validation functions - defined earlier in the module than the torch
import - WITHOUT ever loading a real model, matching this audit's own explicit instruction to use
lightweight stub inference and never stress a real running service. Run directly:

    python scripts/local_ai_service_validation_test.py
"""
import http.server
import json
import os
import socket
import sys
import threading
import types
import unittest

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


_TEST_PORT = _free_port()
os.environ["LOCAL_AI_SERVICE_PORT"] = str(_TEST_PORT)
# Deliberately tight, deterministic limits for this test process only - does not affect any real
# running instance (separate process, separate environment).
os.environ["LOCAL_AI_SERVICE_MAX_CONTENT_LENGTH_BYTES"] = "1000"
os.environ["LOCAL_AI_SERVICE_MAX_CONTEXT_LENGTH"] = "10"
os.environ["LOCAL_AI_SERVICE_MAX_HORIZON"] = "30"


class _DummyHealthHandler(http.server.BaseHTTPRequestHandler):
    """Stands in for 'another instance is already healthy' so local_ai_service.py's own existing
    _already_healthy() short-circuit fires before it ever imports torch/chronos/transformers."""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, *args):
        pass


_dummy_server = http.server.HTTPServer(("127.0.0.1", _TEST_PORT), _DummyHealthHandler)
_dummy_thread = threading.Thread(target=_dummy_server.serve_forever, daemon=True)
_dummy_thread.start()

sys.path.insert(0, _THIS_DIR)
sys.path.insert(0, os.path.join(_THIS_DIR, "lib"))

# Deliberately NOT a normal `import local_ai_service`: when a module-level `sys.exit()` fires
# during a real `import` statement, Python does not leave a usable partial module behind in
# sys.modules (the ModuleSpec is torn down on the raised SystemExit) - there would be nothing to
# read `_validate_prices` etc. off of. Instead this execs the real, unmodified source into a fresh
# namespace directly, exactly the same code the real service runs, and simply lets the module's
# own `_already_healthy()` guard raise SystemExit at the same point it always does (proving
# torch/chronos/transformers, imported further down in the same file, are never reached) - the
# validator functions and exception classes, defined earlier in the file, are already present in
# that namespace by the time the guard fires.
_source_path = os.path.join(_THIS_DIR, "local_ai_service.py")
with open(_source_path, encoding="utf-8") as f:
    _source = f.read()

_namespace = {"__name__": "local_ai_service_under_test", "__file__": _source_path}
_IMPORTED_CLEANLY = True
try:
    exec(compile(_source, _source_path, "exec"), _namespace)  # noqa: S102
except SystemExit:
    _IMPORTED_CLEANLY = False
finally:
    _dummy_server.shutdown()
    _dummy_server.server_close()

_mod = types.SimpleNamespace(**_namespace)


class _FakeHandler:
    """Minimal stand-in for BaseHTTPRequestHandler's two attributes _read_bounded_json_body()
    actually uses - avoids spinning up a real HTTP connection for a pure function test."""

    def __init__(self, body_bytes: bytes, content_length=None):
        self._body = body_bytes
        self.headers = {"Content-Length": str(content_length if content_length is not None else len(body_bytes))}

    class _Rfile:
        def __init__(self, data):
            self._data = data

        def read(self, n):
            return self._data[:n]

    @property
    def rfile(self):
        return _FakeHandler._Rfile(self._body)


class LocalAiServiceModuleLoadTest(unittest.TestCase):
    def test_module_loaded_without_reaching_the_heavy_torch_chronos_import(self):
        self.assertFalse(_IMPORTED_CLEANLY, "expected the _already_healthy() dev guard to short-circuit import")
        self.assertNotIn("torch", sys.modules, "this test must never trigger a real torch import")


class ValidatePricesTest(unittest.TestCase):
    def test_accepts_a_valid_price_list(self):
        _mod._validate_prices([1.0, 2.0, 3.0, 4.0, 5.0])  # must not raise

    def test_rejects_non_list(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices("not a list")

    def test_rejects_below_minimum_length(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, 2.0])  # MIN_CONTEXT_LENGTH is 5

    def test_rejects_above_configured_maximum_length(self):
        # MAX_CONTEXT_LENGTH env-overridden to 10 above.
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0] * 11)

    def test_accepts_exactly_the_configured_maximum_length(self):
        _mod._validate_prices([1.0] * 10)  # must not raise

    def test_rejects_nan(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, 2.0, float("nan"), 4.0, 5.0])

    def test_rejects_infinity(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, 2.0, float("inf"), 4.0, 5.0])

    def test_rejects_negative_infinity(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, float("-inf"), 3.0, 4.0, 5.0])

    def test_rejects_non_numeric_element(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, 2.0, "three", 4.0, 5.0])

    def test_rejects_boolean_element_despite_bool_being_an_int_subclass(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, 2.0, True, 4.0, 5.0])

    def test_rejects_null_element(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_prices([1.0, 2.0, None, 4.0, 5.0])


class ValidateHorizonTest(unittest.TestCase):
    def test_accepts_a_valid_horizon(self):
        self.assertEqual(_mod._validate_horizon(5), 5)

    def test_accepts_numeric_string(self):
        self.assertEqual(_mod._validate_horizon("7"), 7)

    def test_rejects_zero(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_horizon(0)

    def test_rejects_negative(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_horizon(-1)

    def test_rejects_above_configured_maximum(self):
        # MAX_HORIZON env-overridden to 30 above.
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_horizon(31)

    def test_accepts_exactly_the_configured_maximum(self):
        self.assertEqual(_mod._validate_horizon(30), 30)

    def test_rejects_non_numeric(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_horizon("not a number")

    def test_rejects_none(self):
        with self.assertRaises(_mod.InvalidRequestError):
            _mod._validate_horizon(None)


class ReadBoundedJsonBodyTest(unittest.TestCase):
    def test_accepts_a_body_within_the_configured_limit(self):
        payload = json.dumps({"prices": [1, 2, 3]}).encode("utf-8")
        handler = _FakeHandler(payload)
        result = _mod._read_bounded_json_body(handler)
        self.assertEqual(result, {"prices": [1, 2, 3]})

    def test_rejects_a_declared_content_length_above_the_configured_maximum(self):
        # MAX_CONTENT_LENGTH_BYTES env-overridden to 1000 above.
        handler = _FakeHandler(b"{}", content_length=10_000)
        with self.assertRaises(_mod.RequestTooLargeError):
            _mod._read_bounded_json_body(handler)

    def test_malformed_content_length_header_is_treated_as_zero_not_unbounded(self):
        handler = _FakeHandler(b"", content_length="not-a-number")
        # Should not raise RequestTooLargeError; treated as an empty body -> json.loads(b"{}") -> {}
        result = _mod._read_bounded_json_body(handler)
        self.assertEqual(result, {})

    def test_negative_content_length_header_is_treated_as_zero(self):
        handler = _FakeHandler(b"", content_length=-5)
        result = _mod._read_bounded_json_body(handler)
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
