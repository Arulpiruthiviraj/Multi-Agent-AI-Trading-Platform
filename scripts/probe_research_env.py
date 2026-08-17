#!/usr/bin/env python3
"""Research environment probe — never places orders. Reports pyarrow/vectorbt availability honestly."""
from __future__ import annotations

import json
import sys


def main() -> int:
    out = {
        "ok": True,
        "python": sys.version.split()[0],
        "pyarrow": {"available": False, "version": None, "note": None},
        "vectorbt": {"available": False, "version": None, "note": None},
        "pandas": {"available": False, "version": None},
        "numpy": {"available": False, "version": None},
        "canWriteParquet": False,
        "researchOnly": True,
        "canPlaceOrders": False,
        "note": "Missing deps → UNAVAILABLE for parquet warehouse; trading path unaffected.",
    }
    try:
        import numpy as np  # type: ignore
        out["numpy"] = {"available": True, "version": getattr(np, "__version__", None)}
    except Exception as e:
        out["numpy"]["note"] = str(e)
    try:
        import pandas as pd  # type: ignore
        out["pandas"] = {"available": True, "version": getattr(pd, "__version__", None)}
    except Exception as e:
        out["pandas"]["note"] = str(e)
    try:
        import pyarrow as pa  # type: ignore
        out["pyarrow"] = {"available": True, "version": getattr(pa, "__version__", None), "note": None}
        out["canWriteParquet"] = True
    except Exception as e:
        out["pyarrow"]["note"] = f"UNAVAILABLE: {e}. pip install -r requirements-research.txt"
    try:
        import vectorbt as vbt  # type: ignore
        out["vectorbt"] = {"available": True, "version": getattr(vbt, "__version__", None), "note": "Research-only. Never places broker orders."}
    except Exception as e:
        out["vectorbt"]["note"] = f"UNAVAILABLE: {e}"
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
