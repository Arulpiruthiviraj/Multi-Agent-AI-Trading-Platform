"""CORE parity vector vs TypeScript UNIT_FIXTURE. Not an edge."""
import json
from pathlib import Path

from core_features import parity_vector, vectors_match, try_indicator_factory


def test_golden_core_parity_matches_ts_fixture():
    root = Path(__file__).resolve().parents[2]
    ds = json.loads((root / "fixtures" / "research" / "golden_core_parity.json").read_text(encoding="utf-8"))
    vec = parity_vector(ds["bars"])
    expected = ds["expectedTsVector"]
    assert vectors_match(vec, expected), (vec, expected)
    assert ds["provenance"] == "UNIT_FIXTURE"
    assert ds["fullStrategyParity"] is False


def test_indicator_factory_optional():
    info = try_indicator_factory()
    assert "available" in info


if __name__ == "__main__":
    test_golden_core_parity_matches_ts_fixture()
    test_indicator_factory_optional()
    print("ok")
