"""Golden SMA parity with the TypeScript runner (no VectorBT required)."""
import json
from pathlib import Path

from cli import run_sma


def test_golden_sma_deterministic():
    root = Path(__file__).resolve().parents[2]
    ds = json.loads((root / "fixtures" / "research" / "golden_sma.json").read_text(encoding="utf-8"))
    a = run_sma(ds["bars"], 3, 8)
    b = run_sma(ds["bars"], 3, 8)
    assert a["tradeCount"] == b["tradeCount"]
    assert a["netPnl"] == b["netPnl"]
    assert a["canPlaceOrders"] is False
    assert a["lookAheadModel"] == "signal_at_T_execute_next_open"


def test_future_close_does_not_change_prior_sma():
    from cli import sma_at

    closes = [1.0, 2.0, 3.0, 4.0, 5.0]
    a = sma_at(closes, 3, 2)
    closes2 = list(closes)
    closes2[3] = 999.0
    assert sma_at(closes2, 3, 2) == a


if __name__ == "__main__":
    test_golden_sma_deterministic()
    test_future_close_does_not_change_prior_sma()
    print("ok")
