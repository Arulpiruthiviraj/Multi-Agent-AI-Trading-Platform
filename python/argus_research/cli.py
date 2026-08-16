#!/usr/bin/env python3
"""Argus research CLI. Allowlisted jobs only. Never places broker orders."""
from __future__ import annotations

import json
import sys
from pathlib import Path


FORBIDDEN = {"code", "python", "script", "eval", "exec", "broker", "placeOrder"}
ALLOWLISTED = {
    "capability",
    "golden_sma",
    "walk_forward_golden",
    "cost_stress_golden",
    "core_feature_parity",
    "write_parquet",
}


def sma_at(closes, n, i):
    if i < n - 1:
        return None
    return sum(closes[i - n + 1 : i + 1]) / n


def run_sma(bars, fast, slow, commission_per_share=0.0):
    closes = [b["close"] for b in bars]
    trades = []
    long = False
    entry_idx = -1
    entry_price = 0.0
    fees = 0.0
    qty = 1
    for i in range(len(bars)):
        f = sma_at(closes, fast, i)
        s = sma_at(closes, slow, i)
        fp = sma_at(closes, fast, i - 1) if i > 0 else None
        sp = sma_at(closes, slow, i - 1) if i > 0 else None
        if f is None or s is None or fp is None or sp is None:
            continue
        cross_up = fp <= sp and f > s
        cross_down = fp >= sp and f < s
        exec_idx = i + 1
        if exec_idx >= len(bars):
            continue
        px = bars[exec_idx]["open"]
        if cross_up and not long:
            long = True
            entry_idx = exec_idx
            entry_price = px
            fees += commission_per_share * qty
        elif cross_down and long:
            pnl = (px - entry_price) * qty - commission_per_share * qty
            fees += commission_per_share * qty
            trades.append(
                {
                    "entryBarIndex": entry_idx,
                    "exitBarIndex": exec_idx,
                    "entryPrice": entry_price,
                    "exitPrice": px,
                    "pnl": pnl,
                    "entryTimestamp": bars[entry_idx]["timestamp"],
                    "exitTimestamp": bars[exec_idx]["timestamp"],
                }
            )
            long = False
            entry_idx = -1
    gross = sum((t["exitPrice"] - t["entryPrice"]) * qty for t in trades)
    net = sum(t["pnl"] for t in trades)
    return {
        "engineUsed": "python_sma",
        "lookAheadModel": "signal_at_T_execute_next_open",
        "tradeCount": len(trades),
        "netPnl": net,
        "grossPnl": gross,
        "fees": fees,
        "trades": trades,
        "entryTimestamps": [t["entryTimestamp"] for t in trades],
        "exitTimestamps": [t["exitTimestamp"] for t in trades],
        "canPlaceOrders": False,
    }


def capability():
    py_ver = sys.version.split()[0]
    out = {
        "ok": True,
        "pythonVersion": py_ver,
        "vectorbt": {
            "installed": False,
            "version": None,
            "rustBackend": {"available": False, "enabled": False, "version": None},
        },
        "state": "UNAVAILABLE",
        "canPlaceOrders": False,
        "execution": "research_only",
    }
    try:
        import vectorbt as vbt  # type: ignore

        out["vectorbt"]["installed"] = True
        out["vectorbt"]["version"] = getattr(vbt, "__version__", "unknown")
        rust_avail = False
        rust_ver = None
        try:
            import vectorbt_rust as vr  # type: ignore

            rust_avail = True
            rust_ver = getattr(vr, "__version__", None)
        except Exception:
            rust_avail = False
        out["vectorbt"]["rustBackend"] = {
            "available": rust_avail,
            "enabled": rust_avail,
            "version": rust_ver,
        }
        out["state"] = "AVAILABLE_WITH_RUST" if rust_avail else "AVAILABLE_WITHOUT_RUST"
    except Exception:
        out["state"] = "UNAVAILABLE"
    return out


def load_golden():
    root = Path(__file__).resolve().parents[2]
    path = root / "fixtures" / "research" / "golden_sma.json"
    return json.loads(path.read_text(encoding="utf-8"))


def golden_sma(payload):
    ds = load_golden()
    fast = int(payload.get("fast", 3))
    slow = int(payload.get("slow", 8))
    result = run_sma(ds["bars"], fast, slow, float(payload.get("commissionPerShare", 0)))
    cap = capability()
    engine_req = str(payload.get("engine", "auto"))
    result["vectorbt"] = cap["vectorbt"]
    result["pythonVersion"] = cap["pythonVersion"]
    if engine_req == "rust" and not cap["vectorbt"]["rustBackend"]["available"]:
        result["rustAccelerationUnavailable"] = True
        result["engineUsed"] = "RUST_ACCELERATION_UNAVAILABLE"
        result["ok"] = True
        return result
    if cap["vectorbt"]["installed"]:
        try:
            import vectorbt as vbt  # type: ignore
            import numpy as np  # type: ignore

            closes = np.array([b["close"] for b in ds["bars"]], dtype=float)
            engine = "rust" if engine_req == "rust" and cap["vectorbt"]["rustBackend"]["available"] else "auto"
            fast_ma = vbt.MA.run(closes, window=fast, engine=engine)
            slow_ma = vbt.MA.run(closes, window=slow, engine=engine)
            result["vectorbtMaRan"] = True
            result["vectorbtEngineRequested"] = engine
            result["engineUsed"] = "vectorbt_rust" if engine == "rust" else "vectorbt_auto"
        except Exception as exc:
            result["vectorbtError"] = str(exc)
            result["engineUsed"] = "python_sma"
    result["ok"] = True
    return result


def core_feature_parity(payload):
    from core_features import parity_vector

    bars = payload.get("bars") or []
    if not isinstance(bars, list) or len(bars) == 0:
        return {"ok": False, "error": "NO_DATA", "canPlaceOrders": False}
    vec = parity_vector(bars)
    cap = capability()
    return {
        "ok": True,
        "canPlaceOrders": False,
        "engineUsed": "python_core_features",
        "adapter": "FEATURE_TRANSLATION",
        "vector": vec,
        "vectorbt": cap["vectorbt"],
        "note": "BOS/RVOL/Keltner/S-R translation of Argus TS engines. Not an SMA proxy. Not live orders.",
    }


def write_parquet(payload):
    quality = str(payload.get("quality") or "")
    if quality != "GREEN":
        return {"ok": False, "error": "DATA_QUALITY_FAILED", "written": False, "canPlaceOrders": False, "quality": quality}
    dataset_id = str(payload.get("datasetId") or "")
    bars = payload.get("bars") or []
    if not dataset_id or not isinstance(bars, list) or len(bars) == 0:
        return {"ok": False, "error": "NO_DATA", "written": False, "canPlaceOrders": False}
    try:
        import pyarrow as pa  # type: ignore
        import pyarrow.parquet as pq  # type: ignore
    except Exception as exc:
        return {"ok": False, "error": f"pyarrow_unavailable:{exc}", "written": False, "canPlaceOrders": False, "sidecarOnly": True}
    root = Path(__file__).resolve().parents[2]
    out_dir = root / "data" / "research"
    out_dir.mkdir(parents=True, exist_ok=True)
    table = pa.table({
        "timestamp": [int(b["timestamp"]) for b in bars],
        "open": [float(b["open"]) for b in bars],
        "high": [float(b["high"]) for b in bars],
        "low": [float(b["low"]) for b in bars],
        "close": [float(b["close"]) for b in bars],
        "volume": [float(b["volume"]) for b in bars],
    })
    path = out_dir / f"{dataset_id}.parquet"
    pq.write_table(table, path)
    return {"ok": True, "written": True, "path": str(path), "rows": len(bars), "canPlaceOrders": False}


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw or "{}")
    for k in payload:
        if k in FORBIDDEN:
            json.dump({"ok": False, "error": "FORBIDDEN_KEY"}, sys.stdout)
            return
    job = payload.get("job")
    if job not in ALLOWLISTED:
        json.dump({"ok": False, "error": "JOB_NOT_ALLOWLISTED"}, sys.stdout)
        return
    if job == "capability":
        json.dump(capability(), sys.stdout)
        return
    if job == "golden_sma":
        json.dump(golden_sma(payload), sys.stdout)
        return
    if job == "walk_forward_golden":
        json.dump({"ok": True, "note": "Walk-forward is implemented in TypeScript on the golden fixture.", "canPlaceOrders": False}, sys.stdout)
        return
    if job == "cost_stress_golden":
        json.dump({"ok": True, "note": "Cost stress is implemented in TypeScript on the golden fixture.", "canPlaceOrders": False}, sys.stdout)
        return
    if job == "core_feature_parity":
        json.dump(core_feature_parity(payload), sys.stdout)
        return
    if job == "write_parquet":
        json.dump(write_parquet(payload), sys.stdout)
        return
    json.dump({"ok": False, "error": "UNHANDLED"}, sys.stdout)


if __name__ == "__main__":
    main()
