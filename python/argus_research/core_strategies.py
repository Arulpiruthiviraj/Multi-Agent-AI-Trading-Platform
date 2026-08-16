"""Parity-subset CORE signals for research grids. Not full TS StrategyContext evaluate().

fullStrategyParity is False: missing VWAP, DMI, MACD, CMF, sector, RS, candles, StochRSI, RegimeEngine.
WFO results must not overlay live Quant thresholds.
Fills use researchSafety.json costs (same formula as canonicalNextBarEngine.ts).
"""
from __future__ import annotations

import json
from pathlib import Path

from core_features import detect_market_structure, keltner_channels, relative_volume, sma


CORE_IDS = [
    "MOMENTUM_BREAKOUT",
    "PULLBACK_CONTINUATION",
    "MEAN_REVERSION",
    "TREND_FOLLOWING",
    "RANGE_REVERSION",
]


def load_research_costs():
    """Fail closed if cost keys missing — never silently default to zero."""
    root = Path(__file__).resolve().parents[2]
    cfg = json.loads((root / "config" / "researchSafety.json").read_text(encoding="utf-8"))
    for key in ("commissionPerShare", "spreadBps", "slippageBps"):
        if key not in cfg:
            raise ValueError(f"researchSafety.json missing required cost key: {key}")
    return {
        "commissionPerShare": float(cfg["commissionPerShare"]),
        "spreadBps": float(cfg["spreadBps"]),
        "slippageBps": float(cfg["slippageBps"]),
        "qty": float(cfg.get("researchQtyShares", 1)),
        "zeroCostBlocksPromotion": bool(cfg.get("zeroCostBlocksPromotion", True)),
    }


def is_theoretical_zero_cost(costs):
    return (
        costs["commissionPerShare"] == 0
        and costs["spreadBps"] == 0
        and costs["slippageBps"] == 0
    )


def buy_fill_price(open_px, costs):
    return open_px * (1 + (costs["spreadBps"] + costs["slippageBps"]) / 10000)


def sell_fill_price(open_px, costs):
    return open_px * (1 - (costs["spreadBps"] + costs["slippageBps"]) / 10000)


def _series(bars):
    return (
        [b["high"] for b in bars],
        [b["low"] for b in bars],
        [b["close"] for b in bars],
        [b["volume"] for b in bars],
    )


def signal_at(strategy_id, bars, params):
    """Long-only BUY at last bar or None. Subset of live CORE conditions."""
    if strategy_id not in CORE_IDS or not bars:
        return None
    highs, lows, closes, volumes = _series(bars)
    rvol_th = float(params.get("rvolThreshold", 1.5))
    k_mult = float(params.get("keltnerMultiplier", 2.0))
    structure = detect_market_structure(bars)
    rvol = relative_volume(volumes)
    k = keltner_channels(highs, lows, closes, multiplier=k_mult)
    px = closes[-1]
    sma20 = sma(closes, 20)

    if strategy_id == "MOMENTUM_BREAKOUT":
        if structure["event"] == "BOS_BULLISH" and rvol is not None and rvol >= rvol_th:
            return "BUY"
        return None
    if strategy_id == "PULLBACK_CONTINUATION":
        if structure["trend"] == "UPTREND" and sma20 is not None and abs(px - sma20) / sma20 * 100 <= 3:
            if rvol is not None and rvol < 1:
                return "BUY"
        return None
    if strategy_id == "MEAN_REVERSION":
        if k and px <= k["lower"] and structure["trend"] == "SIDEWAYS":
            return "BUY"
        return None
    if strategy_id == "TREND_FOLLOWING":
        if structure["trend"] == "UPTREND":
            return "BUY"
        return None
    if strategy_id == "RANGE_REVERSION":
        if structure["trend"] == "SIDEWAYS" and k and px <= k["lower"]:
            return "BUY"
        return None
    return None


def buy_mask(strategy_id, bars, params):
    mask = []
    for i in range(len(bars)):
        mask.append(signal_at(strategy_id, bars[: i + 1], params) == "BUY")
    return mask


def next_bar_open_stats(bars, buy_at_index, costs=None):
    """NEXT_BAR_OPEN with researchSafety costs. Matches canonicalNextBarEngine fill helpers."""
    costs = costs or load_research_costs()
    qty = costs["qty"]
    long = False
    entry = 0.0
    entry_commission = 0.0
    trade_count = 0
    net_pnl = 0.0
    gross_pnl = 0.0
    fees = 0.0
    pnls = []
    for i in range(len(bars) - 1):
        exec_px_raw = bars[i + 1]["open"]
        if buy_at_index[i] and not long:
            long = True
            entry = buy_fill_price(exec_px_raw, costs)
            entry_commission = costs["commissionPerShare"] * qty
            fees += entry_commission
        elif not buy_at_index[i] and long:
            exit_px = sell_fill_price(exec_px_raw, costs)
            exit_commission = costs["commissionPerShare"] * qty
            fees += exit_commission
            gross = (exit_px - entry) * qty
            pnl = gross - entry_commission - exit_commission
            net_pnl += pnl
            gross_pnl += gross
            pnls.append(pnl)
            trade_count += 1
            long = False
            entry_commission = 0.0
    zero = is_theoretical_zero_cost(costs)
    return {
        "tradeCount": trade_count,
        "netPnl": net_pnl,
        "grossPnl": gross_pnl,
        "fees": fees,
        "pnls": pnls,
        "costModel": "THEORETICAL_ZERO_COST" if zero else "CONFIG",
        "rejection": "THEORETICAL_ZERO_COST" if (zero and costs["zeroCostBlocksPromotion"]) else None,
        "canPlaceOrders": False,
        "promotable": False if zero and costs["zeroCostBlocksPromotion"] else False,
    }
