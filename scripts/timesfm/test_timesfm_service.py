import importlib.util
import math
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("svc", pathlib.Path(__file__).with_name("timesfm_service.py"))
svc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(svc)


def ok(n=64):
    return {"closes": [100 + math.sin(i / 5) for i in range(n)], "timestamps": list(range(n)), "horizon": 8}


class Validate(unittest.TestCase):
    def test_valid(self):
        c, e = svc.validate_request(ok())
        self.assertIsNone(e)
        self.assertEqual(len(c["closes"]), 64)

    def test_short(self):
        self.assertIn("insufficient", svc.validate_request(ok(10))[1])

    def test_nan(self):
        b = ok()
        b["closes"][3] = float("nan")
        self.assertIn("finite", svc.validate_request(b)[1])

    def test_inf(self):
        b = ok()
        b["closes"][3] = float("inf")
        self.assertIn("finite", svc.validate_request(b)[1])

    def test_none(self):
        b = ok()
        b["closes"][3] = None
        self.assertIsNotNone(svc.validate_request(b)[1])

    def test_nonpositive(self):
        b = ok()
        b["closes"][3] = 0
        self.assertIsNotNone(svc.validate_request(b)[1])

    def test_constant(self):
        b = ok()
        b["closes"] = [100.0] * 64
        self.assertIn("constant", svc.validate_request(b)[1])

    def test_duplicate_timestamps(self):
        b = ok()
        b["timestamps"][5] = b["timestamps"][4]
        self.assertIn("increasing", svc.validate_request(b)[1])

    def test_bad_horizon(self):
        for h in (0, -1, svc.MAX_HORIZON + 1, 2.5, True, "8"):
            b = ok()
            b["horizon"] = h
            self.assertIsNotNone(svc.validate_request(b)[1], h)

    def test_length_mismatch(self):
        b = ok()
        b["timestamps"] = b["timestamps"][:-1]
        self.assertIsNotNone(svc.validate_request(b)[1])

    def test_context_truncated_to_max(self):
        c, e = svc.validate_request(ok(svc.MAX_CONTEXT + 50))
        self.assertIsNone(e)
        self.assertEqual(len(c["closes"]), svc.MAX_CONTEXT)

    def test_unapproved_model_never_loads(self):
        svc.MODEL_ID = "google/timesfm-3.0-pytorch"
        svc._load_attempted = False
        svc._load_model()
        self.assertEqual(svc._state["status"], "MODEL_NOT_APPROVED")


if __name__ == "__main__":
    unittest.main()
