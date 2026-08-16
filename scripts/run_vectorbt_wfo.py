"""
Walk-forward + DSR on CORE parity-subset signals. Research-only. Never placeOrder.

Loads GREEN parquet under data/research/{datasetId}.parquet when present.
UNIT_FIXTURE / missing warehouse: run capability logs, upsert nothing.
Survivors upsert status=RESEARCH_PARAM_CANDIDATE only. LIVE_CANDIDATE/VALIDATED/PAPER_TESTING-as-lifecycle are forbidden.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python" / "argus_research"))

from core_strategies import CORE_IDS, buy_mask, next_bar_open_stats  # noqa: E402
from stats import deflated_sharpe, permutation_positive_expectancy, sharpe_from_pnls  # noqa: E402

FORBIDDEN = {"LIVE_CANDIDATE", "VALIDATED", "LIVE_APPROVED", "LIVE", "PAPER_TESTING"}
ALLOWED_STATUS = "RESEARCH_PARAM_CANDIDATE"


def load_json(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def load_bars_from_parquet(dataset_id):
    path = ROOT / "data" / "research" / f"{dataset_id}.parquet"
    sidecar = ROOT / "data" / "research" / f"{dataset_id}.quality.json"
    if not path.exists():
        return None, "NO_DATA"
    quality = "UNKNOWN"
    provenance = "UNKNOWN"
    if sidecar.exists():
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
        quality = str(meta.get("quality") or "UNKNOWN")
        provenance = str(meta.get("provenance") or "UNKNOWN")
    if quality != "GREEN":
        return None, "DATA_QUALITY_NOT_GREEN"
    try:
        import pyarrow.parquet as pq
    except Exception as exc:
        return None, f"pyarrow_unavailable:{exc}"
    table = pq.read_table(path)
    cols = {name: table.column(name).to_pylist() for name in table.column_names}
    bars = []
    n = len(cols.get("timestamp") or [])
    for i in range(n):
        bars.append({
            "timestamp": int(cols["timestamp"][i]),
            "open": float(cols["open"][i]),
            "high": float(cols["high"][i]),
            "low": float(cols["low"][i]),
            "close": float(cols["close"][i]),
            "volume": float(cols["volume"][i]),
        })
    return {"bars": bars, "quality": quality, "provenance": provenance, "datasetId": dataset_id}, None


def load_golden_fixture():
    ds = load_json("fixtures/research/golden_core_parity.json")
    return {
        "bars": ds["bars"],
        "quality": "UNIT_FIXTURE",
        "provenance": ds.get("provenance", "UNIT_FIXTURE"),
        "datasetId": "golden_core_parity",
    }


def grid_params(cfg):
    out = []
    for r in cfg["rvolThresholds"]:
        for k in cfg["keltnerMultipliers"]:
            out.append({"rvolThreshold": r, "keltnerMultiplier": k, "fullStrategyParity": bool(cfg.get("fullStrategyParity"))})
    return out


def run_wfo(bars, strategy_id, params, cfg, min_oos):
    train_n = int(cfg["trainBars"])
    val_n = int(cfg["validateBars"])
    test_n = int(cfg["testBars"])
    embargo = int(load_json("config/researchSafety.json").get("wfoEmbargoBars", 5))
    n = len(bars)
    folds = []
    start = 0
    while start + train_n + val_n + embargo + test_n <= n:
        train = bars[start : start + train_n]
        val = bars[start + train_n : start + train_n + val_n]
        test = bars[start + train_n + val_n + embargo : start + train_n + val_n + embargo + test_n]
        tr = next_bar_open_stats(train, buy_mask(strategy_id, train, params))
        va = next_bar_open_stats(val, buy_mask(strategy_id, val, params))
        te = next_bar_open_stats(test, buy_mask(strategy_id, test, params))
        folds.append({"train": tr, "val": va, "test": te})
        start += test_n
    return folds


def upsert_paper_testing(db_path, row):
    if row["status"] in FORBIDDEN or row["status"] != ALLOWED_STATUS:
        raise SystemExit("structurally forbidden status")
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_configurations (
              id TEXT PRIMARY KEY,
              strategy_id TEXT NOT NULL,
              regime TEXT NOT NULL,
              params_json TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('RESEARCH_PARAM_CANDIDATE', 'PAPER_TESTING')),
              ev_oos REAL,
              dsr_train REAL,
              permutation_pass INTEGER NOT NULL,
              dataset_id TEXT,
              full_strategy_parity INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO strategy_configurations
            (id, strategy_id, regime, params_json, status, ev_oos, dsr_train, permutation_pass, dataset_id, full_strategy_parity, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                row["id"],
                row["strategy_id"],
                row["regime"],
                row["params_json"],
                ALLOWED_STATUS,
                row["ev_oos"],
                row["dsr_train"],
                1 if row["permutation_pass"] else 0,
                row["dataset_id"],
                1 if row["full_strategy_parity"] else 0,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def main():
    cfg = load_json("config/quantWfoGrid.json")
    safety = load_json("config/researchSafety.json")
    min_oos = int(safety.get("minOosTrades", 30))
    alpha = float(safety.get("permutationAlpha", 0.05))
    argv = sys.argv[1:]
    use_golden = "--fixture" in argv or "--golden" in argv
    dataset_id = "golden_core_parity"
    if "--dataset" in argv:
        dataset_id = argv[argv.index("--dataset") + 1]

    payload = None
    err = None
    if use_golden:
        payload = load_golden_fixture()
        err = "SYNTHETIC_NOT_PROMOTABLE"
    else:
        payload, err = load_bars_from_parquet(dataset_id)

    report = {
        "ok": True,
        "canPlaceOrders": False,
        "engine": "python_core_features_subset",
        "fullStrategyParity": False,
        "executionModel": "NEXT_BAR_OPEN",
        "datasetId": dataset_id,
        "error": err,
        "upserted": [],
        "skipped": [],
        "note": "Parity-subset WFO. Not live Quant evaluate(). Not an edge. QUANT_ENGINE_ENABLED unchanged.",
    }

    if payload is None:
        report["ok"] = err == "NO_DATA"
        print(json.dumps(report, indent=2))
        return

    n_trials = len(CORE_IDS) * len(grid_params(cfg))
    db_path = os.environ.get("ARGUS_DB_PATH") or str(ROOT / "data" / "argus.db")
    allow_upsert = err is None and payload.get("quality") == "GREEN"

    for sid in CORE_IDS:
        for params in grid_params(cfg):
            folds = run_wfo(payload["bars"], sid, params, cfg, min_oos)
            if len(folds) < int(safety.get("minWalkForwardWindows", 3)):
                report["skipped"].append({"strategyId": sid, "reason": "INSUFFICIENT_SAMPLE", "foldCount": len(folds)})
                continue
            train_pnls = [p for f in folds for p in f["train"]["pnls"]]
            test_pnls = [p for f in folds for p in f["test"]["pnls"]]
            sr = sharpe_from_pnls(train_pnls)
            dsr = deflated_sharpe(sr, len(train_pnls), n_trials) if sr is not None else None
            ev = (sum(test_pnls) / len(test_pnls)) if test_pnls else None
            perm = permutation_positive_expectancy(test_pnls, alpha) if test_pnls else False
            if not allow_upsert:
                report["skipped"].append({"strategyId": sid, "reason": err or "UPSERT_BLOCKED", "dsrTrain": dsr, "evOos": ev})
                continue
            if ev is None or ev <= 0 or not perm or dsr is None:
                report["skipped"].append({"strategyId": sid, "reason": "OOS_OR_DSR_OR_PERM_FAIL", "dsrTrain": dsr, "evOos": ev, "permutationPass": perm})
                continue
            row = {
                "id": f"{sid}:ANY",
                "strategy_id": sid,
                "regime": "ANY",
                "params_json": json.dumps(params),
                "status": ALLOWED_STATUS,
                "ev_oos": ev,
                "dsr_train": dsr,
                "permutation_pass": perm,
                "dataset_id": payload["datasetId"],
                "full_strategy_parity": False,
            }
            upsert_paper_testing(db_path, row)
            report["upserted"].append({"strategyId": sid, "status": ALLOWED_STATUS, "evOos": ev, "dsrTrain": dsr})

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
