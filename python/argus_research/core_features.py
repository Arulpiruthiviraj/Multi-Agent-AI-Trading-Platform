"""Feature translations of Argus TS engines. Not SMA proxies. Research-only."""
from __future__ import annotations


def sma(values, period):
    if len(values) < period:
        return None
    window = values[-period:]
    return sum(window) / period


def ema(values, period):
    if len(values) < period:
        return values[-1] if values else 0.0
    e = sma(values[:period], period)
    mult = 2 / (period + 1)
    for i in range(period, len(values)):
        e = (values[i] - e) * mult + e
    return e


def atr(highs, lows, closes, period=14):
    if len(closes) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(closes)):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        trs.append(max(hl, hc, lc))
    a = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        a = ((a * (period - 1)) + trs[i]) / period
    return a


def relative_volume(volumes, period=20):
    if len(volumes) < period + 1:
        return None
    avg = sma(volumes[:-1], period)
    if avg is None or avg == 0:
        return None
    return volumes[-1] / avg


def keltner_channels(highs, lows, closes, ema_period=20, atr_period=10, multiplier=2):
    if len(closes) < max(ema_period, atr_period + 1):
        return None
    middle = ema(closes, ema_period)
    a = atr(highs, lows, closes, atr_period)
    return {"middle": middle, "upper": middle + multiplier * a, "lower": middle - multiplier * a}


def detect_swing_points(bars, lookback=2):
    points = []
    last_high = None
    last_low = None
    n = len(bars)
    for i in range(lookback, n - lookback):
        window_highs = [bars[j]["high"] for j in range(i - lookback, i + lookback + 1)]
        window_lows = [bars[j]["low"] for j in range(i - lookback, i + lookback + 1)]
        hi = bars[i]["high"]
        lo = bars[i]["low"]
        if hi == max(window_highs) and window_highs.count(hi) == 1:
            kind = None if last_high is None else ("HH" if hi > last_high else "LH")
            points.append({"index": i, "price": hi, "type": "high", "kind": kind})
            last_high = hi
        elif lo == min(window_lows) and window_lows.count(lo) == 1:
            kind = None if last_low is None else ("HL" if lo > last_low else "LL")
            points.append({"index": i, "price": lo, "type": "low", "kind": kind})
            last_low = lo
    return points


def detect_market_structure(bars, lookback=2):
    swings = detect_swing_points(bars, lookback)
    highs = [s for s in swings if s["type"] == "high"]
    lows = [s for s in swings if s["type"] == "low"]
    last_high = highs[-1] if highs else None
    last_low = lows[-1] if lows else None
    recent_high_kinds = [s["kind"] for s in highs[-2:]]
    recent_low_kinds = [s["kind"] for s in lows[-2:]]
    is_up = (
        len(recent_high_kinds) > 0
        and len(recent_low_kinds) > 0
        and all(k == "HH" for k in recent_high_kinds)
        and all(k == "HL" for k in recent_low_kinds)
    )
    is_down = (
        len(recent_high_kinds) > 0
        and len(recent_low_kinds) > 0
        and all(k == "LH" for k in recent_high_kinds)
        and all(k == "LL" for k in recent_low_kinds)
    )
    trend = "UPTREND" if is_up else "DOWNTREND" if is_down else "SIDEWAYS"
    last_close = bars[-1]["close"] if bars else None
    event = "NONE"
    if last_close is not None:
        if trend == "UPTREND":
            if last_high and last_close > last_high["price"]:
                event = "BOS_BULLISH"
            elif last_low and last_close < last_low["price"]:
                event = "CHOCH_BEARISH"
        elif trend == "DOWNTREND":
            if last_low and last_close < last_low["price"]:
                event = "BOS_BEARISH"
            elif last_high and last_close > last_high["price"]:
                event = "CHOCH_BULLISH"
    return {
        "trend": trend,
        "event": event,
        "lastSwingHigh": last_high["price"] if last_high else None,
        "lastSwingLow": last_low["price"] if last_low else None,
    }


def nearest_sr(current_price, candidate_levels):
    above = sorted([l for l in candidate_levels if l > current_price])
    below = sorted([l for l in candidate_levels if l < current_price], reverse=True)
    def dist(level):
        if level == 0:
            return None
        abs_d = current_price - level
        return {"level": level, "abs": abs_d, "pct": (abs_d / level) * 100}
    return {
        "nearestResistance": dist(above[0]) if above else None,
        "nearestSupport": dist(below[0]) if below else None,
    }


def parity_vector(bars):
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    volumes = [b["volume"] for b in bars]
    structure = detect_market_structure(bars)
    swings = detect_swing_points(bars)
    px = closes[-1] if closes else 0
    nearest = nearest_sr(px, [s["price"] for s in swings[-10:]])
    k = keltner_channels(highs, lows, closes)
    return {
        "structureEvent": structure["event"],
        "structureTrend": structure["trend"],
        "rvol": relative_volume(volumes),
        "keltner": k,
        "nearestSupport": nearest["nearestSupport"]["level"] if nearest["nearestSupport"] else None,
        "nearestResistance": nearest["nearestResistance"]["level"] if nearest["nearestResistance"] else None,
    }
