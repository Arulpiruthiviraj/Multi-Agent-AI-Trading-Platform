"""
Verify tests/fixtures/strategy_parity_golden.json against Python CORE evaluate ports.
Indicators + boolean signal / score equivalence with abs delta < 1e-4.

Usage:
  python python/argus_research/verify_strategy_parity.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from strategy_evaluate import evaluate_all  # noqa: E402
from verify_feature_parity import compute_features, diff_table  # noqa: E402

TOL = 1e-4
FIXTURE = ROOT / "tests" / "fixtures" / "strategy_parity_golden.json"


def _num_eq(a, b):
    if a is None and b is None:
        return True
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) <= TOL
    return a == b


def compare_evaluations(expected, actual):
    rows = []
    by_id = {e["strategy"]: e for e in expected}
    for a in actual:
        sid = a["strategy"]
        e = by_id.get(sid)
        if not e:
            rows.append((f"{sid}.present", False, None, a, None))
            continue
        for field in (
            "side",
            "setupScore",
            "confidence",
            "conditionsMetCount",
            "conditionsFailedCount",
            "stopPrice",
            "targetPrice",
            "signalActive",
        ):
            ts, py = e.get(field), a.get(field)
            ok = _num_eq(ts, py) if field not in ("side", "signalActive") else ts == py
            if field in ("conditionsMetCount", "conditionsFailedCount", "setupScore"):
                ok = ts == py
            delta = None
            if isinstance(ts, (int, float)) and isinstance(py, (int, float)):
                delta = abs(float(ts) - float(py))
            rows.append((f"{sid}.{field}", ok, ts, py, delta))
    return rows


def main():
    if not FIXTURE.exists():
        print(f"MISSING_FIXTURE {FIXTURE}")
        print("Generate: npx tsx tests/parity/generate_parity_golden.ts")
        return 1

    ds = json.loads(FIXTURE.read_text(encoding="utf-8"))
    print("=== INDICATORS (bars -> Python) ===")
    # Golden stores TS indicators under `indicators`; compare Python recompute from bars.
    ind_expected = {
        "rsi": ds["indicators"]["rsi"],
        "macd": ds["indicators"]["macd"],
        "dmi": ds["indicators"]["dmi"],
        "stochasticRSI": ds["indicators"]["stochasticRSI"],
        "keltner": ds["indicators"]["keltner"],
        "structure": ds["indicators"]["structure"],
        "macdDivergenceKind": ds["indicators"]["macdDivergenceKind"],
        "regime": ds["indicators"]["regime"],
    }
    ind_actual = compute_features(ds["bars"])
    ind_rows = diff_table(ind_expected, ind_actual)
    ind_fail = [r[0] for r in ind_rows if not r[4]]
    for field, ts, py, d, ok in ind_rows:
        print(f"{field:32} {'PASS' if ok else 'FAIL'} delta={d}")

    print("\n=== STRATEGY EVALUATE (slim context -> Python ports) ===")
    py_evals = evaluate_all(ds["context"], ds["thresholds"])
    eval_rows = compare_evaluations(ds["evaluations"], py_evals)
    eval_fail = [r[0] for r in eval_rows if not r[1]]
    print(f"{'field':40} {'ok':6} ts / py")
    print("-" * 90)
    for field, ok, ts, py, delta in eval_rows:
            print(f"{field:40} {'PASS' if ok else 'FAIL':6} {ts!r} / {py!r}" + (f" d={delta}" if delta is not None else ""))

    print("-" * 90)
    matrix = {
        "indicatorsPass": len(ind_fail) == 0,
        "evaluatePass": len(eval_fail) == 0,
        "failedIndicatorFields": ind_fail,
        "failedEvaluateFields": eval_fail,
        "strategies": [e["strategy"] for e in py_evals],
        "fullStrategyParityClaim": bool(ds.get("fullStrategyParity")),
        "absTolerance": TOL,
        "canPlaceOrders": False,
        "live": "NO-GO",
    }
    print(json.dumps(matrix, indent=2))
    if ind_fail or eval_fail:
        return 1
    print("ok strategy parity abs_delta<1e-4")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
