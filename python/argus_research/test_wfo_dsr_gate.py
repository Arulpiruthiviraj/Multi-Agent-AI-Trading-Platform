"""DSR selection gate for the vectorbt WFO (2026-10-04 audit fix).

The WFO used to compute DSR and store it, but the promotion decision only rejected
`dsr is None` - any defined DSR passed. These tests pin the real gate: a candidate
promotes only with positive OOS expectancy, a passed permutation test, AND a DSR at
or above the configured multiple-testing-adjusted confidence bar.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from run_vectorbt_wfo import promotion_decision  # noqa: E402


def test_promotes_when_all_gates_pass():
    ok, reason = promotion_decision(ev=1.5, perm=True, dsr=0.97, dsr_min=0.95)
    assert ok is True
    assert reason == "PASS"


def test_rejects_dsr_below_threshold():
    ok, reason = promotion_decision(ev=1.5, perm=True, dsr=0.90, dsr_min=0.95)
    assert ok is False
    assert reason == "DSR_BELOW_THRESHOLD"


def test_boundary_dsr_equal_to_threshold_promotes():
    ok, _ = promotion_decision(ev=0.01, perm=True, dsr=0.95, dsr_min=0.95)
    assert ok is True


def test_rejects_undefined_dsr():
    ok, reason = promotion_decision(ev=1.5, perm=True, dsr=None, dsr_min=0.95)
    assert ok is False
    assert reason == "DSR_UNDEFINED"


def test_rejects_nonpositive_oos_expectancy():
    ok, reason = promotion_decision(ev=0.0, perm=True, dsr=0.99, dsr_min=0.95)
    assert ok is False
    assert reason == "OOS_EXPECTANCY_FAIL"


def test_rejects_failed_permutation():
    ok, reason = promotion_decision(ev=1.5, perm=False, dsr=0.99, dsr_min=0.95)
    assert ok is False
    assert reason == "PERMUTATION_FAIL"


def test_gate_order_reports_first_failure():
    # OOS expectancy is evaluated before DSR - the reported reason is the first failure.
    ok, reason = promotion_decision(ev=-2.0, perm=False, dsr=0.10, dsr_min=0.95)
    assert ok is False
    assert reason == "OOS_EXPECTANCY_FAIL"


if __name__ == "__main__":
    test_promotes_when_all_gates_pass()
    test_rejects_dsr_below_threshold()
    test_boundary_dsr_equal_to_threshold_promotes()
    test_rejects_undefined_dsr()
    test_rejects_nonpositive_oos_expectancy()
    test_rejects_failed_permutation()
    test_gate_order_reports_first_failure()
    print("wfo dsr gate tests passed")
