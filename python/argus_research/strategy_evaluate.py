"""Python ports of Argus CORE StrategyContext.evaluate() on slim context snapshots.

Research-only. Mirrors TS condition checks + setupScore math. Not OMS/RiskEngine.
"""
from __future__ import annotations


def _score(met, total):
    if total == 0:
        return 0
    return round((met / total) * 100)


def _check(met_list, fail_list, name, ok):
    (met_list if ok else fail_list).append(name)


def _level(obj):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get("level")
    return None


def _pct(obj):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get("pct")
    return None


def evaluate_momentum_breakout(ctx, th):
    trend = ctx["trend"]
    momentum = ctx["momentum"]
    volatility = ctx["volatility"]
    volume = ctx["volume"]
    price_action = ctx["priceAction"]
    sr = ctx["supportResistance"]
    regime = ctx["regime"]
    market = ctx["marketContext"]
    rvol_th = th["rvolThreshold"]

    bull_break = trend["structure"]["event"] == "BOS_BULLISH"
    bear_break = trend["structure"]["event"] == "BOS_BEARISH"
    side = "SELL" if bear_break and not bull_break else "BUY"
    bullish = side == "BUY"
    met, fail, contradictions = [], [], []

    _check(met, fail, "Structural break in trade direction (BOS)", bull_break if bullish else bear_break)
    rvol = volume.get("relativeVolume")
    _check(met, fail, f"RVOL confirmation (>={rvol_th}x average volume)", rvol is not None and rvol >= rvol_th)
    _check(met, fail, "ATR expansion (volatility regime EXPANDING)", volatility.get("regime") == "EXPANDING")
    dist = (volume.get("vwap") or {}).get("distancePct")
    _check(
        met,
        fail,
        "Price above session VWAP" if bullish else "Price below session VWAP",
        dist is not None and ((dist > 0) if bullish else (dist < 0)),
    )
    _check(
        met,
        fail,
        "Favorable market regime",
        regime["regime"] == ("BULLISH_TREND" if bullish else "BEARISH_TREND"),
    )
    sector_reg = (((market.get("sector") or {}).get("trend") or {}).get("regime") or {}).get("regime")
    _check(
        met,
        fail,
        "Favorable sector regime",
        sector_reg is not None and sector_reg == ("BULLISH_TREND" if bullish else "BEARISH_TREND"),
    )
    rs = (market.get("relativeStrengthVsSPY") or {}).get("relativeStrengthPct")
    _check(
        met,
        fail,
        "Positive relative strength vs SPY" if bullish else "Negative relative strength vs SPY",
        rs is not None and ((rs > 0) if bullish else (rs < 0)),
    )
    roc = momentum.get("roc")
    _check(
        met,
        fail,
        "Positive momentum (ROC > 0)" if bullish else "Negative momentum (ROC < 0)",
        roc is not None and ((roc > 0) if bullish else (roc < 0)),
    )

    if bullish and momentum.get("rsi", 0) >= 80:
        contradictions.append("RSI extreme")
    if (not bullish) and momentum.get("rsi", 100) <= 20:
        contradictions.append("RSI extreme")
    if bullish and price_action.get("candlestick") == "SHOOTING_STAR":
        contradictions.append("candle")
    if (not bullish) and price_action.get("candlestick") == "HAMMER":
        contradictions.append("candle")

    total = len(met) + len(fail)
    setup = _score(len(met), total)
    broken = trend["structure"]["lastSwingHigh"] if bullish else trend["structure"]["lastSwingLow"]
    nearest = (sr.get("nearest") or {}).get("nearestResistance" if bullish else "nearestSupport")
    atr = volatility.get("atr")
    stop = None
    if broken is not None and atr:
        stop = broken - atr if bullish else broken + atr
    target = _level(nearest)
    if target is None and atr:
        target = ctx["currentPrice"] + (2 * atr if bullish else -2 * atr)
    return _pack("MOMENTUM_BREAKOUT", side, setup, met, fail, contradictions, stop, target)


def evaluate_pullback_continuation(ctx, th):
    trend = ctx["trend"]
    momentum = ctx["momentum"]
    volume = ctx["volume"]
    price_action = ctx["priceAction"]
    sr = ctx["supportResistance"]
    regime = ctx["regime"]
    tol = th["pullbackTolerancePct"]
    rsi_min, rsi_max = th["healthyRsiMin"], th["healthyRsiMax"]

    bullish = trend["structure"]["trend"] == "UPTREND" or (
        trend["structure"]["trend"] != "DOWNTREND" and regime["regime"] == "BULLISH_TREND"
    )
    side = "BUY" if bullish else "SELL"
    met, fail, contradictions = [], [], []

    _check(
        met,
        fail,
        "Established uptrend (market structure + regime)" if bullish else "Established downtrend (market structure + regime)",
        (trend["structure"]["trend"] == "UPTREND" and regime["regime"] == "BULLISH_TREND")
        if bullish
        else (trend["structure"]["trend"] == "DOWNTREND" and regime["regime"] == "BEARISH_TREND"),
    )
    pvma20 = trend.get("priceVsSMA20")
    _check(
        met,
        fail,
        "Price pulled back to/near SMA20 without breaking decisively through it",
        pvma20 is not None
        and abs(pvma20["diffPct"]) <= tol
        and ((pvma20["diffPct"] > -tol) if bullish else (pvma20["diffPct"] < tol)),
    )
    _check(
        met,
        fail,
        "RSI in a healthy (non-extreme) pullback zone",
        rsi_min <= momentum["rsi"] <= rsi_max,
    )
    candle = price_action.get("candlestick")
    _check(
        met,
        fail,
        "Bullish reversal candlestick at the pullback low" if bullish else "Bearish reversal candlestick at the pullback high",
        candle in (("HAMMER", "BULLISH_ENGULFING") if bullish else ("SHOOTING_STAR", "BEARISH_ENGULFING")),
    )
    rvol = volume.get("relativeVolume")
    _check(met, fail, "Volume contracted during the pullback (below average - lack of opposing pressure)", rvol is not None and rvol < 1)
    _check(
        met,
        fail,
        "No structural reversal against the trend (no opposing CHoCH)",
        trend["structure"]["event"] != ("CHOCH_BEARISH" if bullish else "CHOCH_BULLISH"),
    )

    dmi = trend.get("dmi")
    if bullish and dmi and dmi["minusDI"] > dmi["plusDI"]:
        contradictions.append("dmi")
    if (not bullish) and dmi and dmi["plusDI"] > dmi["minusDI"]:
        contradictions.append("dmi")

    total = len(met) + len(fail)
    setup = _score(len(met), total)
    structural = trend["structure"]["lastSwingLow"] if bullish else trend["structure"]["lastSwingHigh"]
    ma = trend["movingAverages"].get("sma20")
    stop = structural if structural is not None else ma
    target_obj = (sr.get("nearest") or {}).get("nearestResistance" if bullish else "nearestSupport")
    return _pack("PULLBACK_CONTINUATION", side, setup, met, fail, contradictions, stop, _level(target_obj))


def evaluate_mean_reversion(ctx, th):
    momentum = ctx["momentum"]
    volatility = ctx["volatility"]
    price_action = ctx["priceAction"]
    sr = ctx["supportResistance"]
    regime = ctx["regime"]
    px = ctx["currentPrice"]
    oversold = momentum["rsi"] <= th["rsiOversold"]
    overbought = momentum["rsi"] >= th["rsiOverbought"]
    bullish = False if overbought else True
    side = "BUY" if bullish else "SELL"
    met, fail, contradictions = [], [], []

    _check(
        met,
        fail,
        "Ranging / non-trending regime (not a real directional trend)",
        regime["marketStructure"] == "RANGING" or regime["regime"] == "SIDEWAYS_RANGE",
    )
    _check(
        met,
        fail,
        f"RSI oversold (<={th['rsiOversold']})" if bullish else f"RSI overbought (>={th['rsiOverbought']})",
        oversold if bullish else overbought,
    )
    k = volatility.get("keltner")
    _check(
        met,
        fail,
        "Price at/below the lower Keltner Channel" if bullish else "Price at/above the upper Keltner Channel",
        k is not None and ((px <= k["lower"]) if bullish else (px >= k["upper"])),
    )
    stoch = momentum.get("stochasticRSI")
    _check(
        met,
        fail,
        "Stochastic RSI confirming oversold (<=20)" if bullish else "Stochastic RSI confirming overbought (>=80)",
        stoch is not None
        and ((stoch <= th["stochRsiOversold"]) if bullish else (stoch >= th["stochRsiOverbought"])),
    )
    candle = price_action.get("candlestick")
    _check(
        met,
        fail,
        "Bullish reversal candlestick" if bullish else "Bearish reversal candlestick",
        candle in (("HAMMER", "BULLISH_ENGULFING") if bullish else ("SHOOTING_STAR", "BEARISH_ENGULFING")),
    )
    if bullish and regime["regime"] == "BEARISH_TREND":
        contradictions.append("regime")
    if (not bullish) and regime["regime"] == "BULLISH_TREND":
        contradictions.append("regime")

    total = len(met) + len(fail)
    setup = _score(len(met), total)
    stop_obj = (sr.get("nearest") or {}).get("nearestSupport" if bullish else "nearestResistance")
    target = (k or {}).get("middle") if k else None
    return _pack("MEAN_REVERSION", side, setup, met, fail, contradictions, _level(stop_obj), target)


def evaluate_trend_following(ctx, th):
    trend = ctx["trend"]
    momentum = ctx["momentum"]
    volume = ctx["volume"]
    regime = ctx["regime"]
    bullish = regime["regime"] != "BEARISH_TREND"
    side = "BUY" if bullish else "SELL"
    ma = trend["movingAverages"]
    met, fail, contradictions = [], [], []
    min_ts, min_adx = th["minTrendStrength"], th["minAdxTrending"]

    _check(
        met,
        fail,
        f"Strong {'BULLISH' if bullish else 'BEARISH'}_TREND regime (trendStrength >= {min_ts})",
        (regime["regime"] == ("BULLISH_TREND" if bullish else "BEARISH_TREND")) and regime["trendStrength"] >= min_ts,
    )
    _check(met, fail, "Market structure real TRENDING (not ranging/choppy)", regime["marketStructure"] == "TRENDING")
    _check(
        met,
        fail,
        "Moving averages ordered bullishly (SMA20 > SMA50 > SMA200)"
        if bullish
        else "Moving averages ordered bearishly (SMA20 < SMA50 < SMA200)",
        ma.get("sma20") is not None
        and ma.get("sma50") is not None
        and ma.get("sma200") is not None
        and (
            (ma["sma20"] > ma["sma50"] > ma["sma200"])
            if bullish
            else (ma["sma20"] < ma["sma50"] < ma["sma200"])
        ),
    )
    dmi = trend.get("dmi")
    _check(
        met,
        fail,
        "DMI +DI > -DI with real ADX trend strength" if bullish else "DMI -DI > +DI with real ADX trend strength",
        dmi is not None
        and dmi["adx"] >= min_adx
        and ((dmi["plusDI"] > dmi["minusDI"]) if bullish else (dmi["minusDI"] > dmi["plusDI"])),
    )
    macd = momentum["macd"]
    _check(
        met,
        fail,
        "MACD bullish (line above signal)" if bullish else "MACD bearish (line below signal)",
        (macd["macd"] > macd["signal"]) if bullish else (macd["macd"] < macd["signal"]),
    )
    cmf = volume.get("cmf")
    _check(
        met,
        fail,
        "Chaikin Money Flow confirming accumulation (CMF > 0)" if bullish else "Chaikin Money Flow confirming distribution (CMF < 0)",
        cmf is not None and ((cmf > 0) if bullish else (cmf < 0)),
    )
    pv200 = trend.get("priceVsSMA200")
    if bullish and pv200 is not None and not pv200.get("above"):
        contradictions.append("sma200")
    if (not bullish) and pv200 is not None and pv200.get("above"):
        contradictions.append("sma200")

    total = len(met) + len(fail)
    setup = _score(len(met), total)
    return _pack("TREND_FOLLOWING", side, setup, met, fail, contradictions, ma.get("sma50"), None)


def evaluate_range_reversion(ctx, th):
    trend = ctx["trend"]
    momentum = ctx["momentum"]
    volume = ctx["volume"]
    price_action = ctx["priceAction"]
    sr = ctx["supportResistance"]
    regime = ctx["regime"]
    nearest = sr.get("nearest") or {}
    ns, nr = nearest.get("nearestSupport"), nearest.get("nearestResistance")
    support_dist = abs(_pct(ns)) if ns is not None and _pct(ns) is not None else float("inf")
    resistance_dist = abs(_pct(nr)) if nr is not None and _pct(nr) is not None else float("inf")
    bullish = support_dist <= resistance_dist
    side = "BUY" if bullish else "SELL"
    near = ns if bullish else nr
    far = nr if bullish else ns
    met, fail, contradictions = [], [], []
    near_pct = th["nearBoundaryPct"]

    _check(
        met,
        fail,
        "Range regime confirmed (RANGING market structure + real consolidation)",
        regime["marketStructure"] == "RANGING" and bool(price_action.get("consolidating")),
    )
    _check(
        met,
        fail,
        "Price near the range support boundary" if bullish else "Price near the range resistance boundary",
        near is not None and _pct(near) is not None and abs(_pct(near)) <= near_pct,
    )
    _check(
        met,
        fail,
        "RSI showing weakness at the boundary (<=40)" if bullish else "RSI showing strength at the boundary (>=60)",
        (momentum["rsi"] <= 40) if bullish else (momentum["rsi"] >= 60),
    )
    _check(met, fail, "No real volume spike (a genuine breakout would show one)", volume.get("isSpike") is not True)
    _check(
        met,
        fail,
        "No real structural break in the fade direction (range still holding)",
        trend["structure"]["event"] != ("BOS_BEARISH" if bullish else "BOS_BULLISH"),
    )
    if near is None:
        contradictions.append("no boundary")
    if volume.get("isSpike") is True:
        contradictions.append("spike")

    total = len(met) + len(fail)
    setup = _score(len(met), total)
    return _pack("RANGE_REVERSION", side, setup, met, fail, contradictions, _level(near), _level(far))


def _pack(strategy, side, setup, met, fail, contradictions, stop, target):
    return {
        "strategy": strategy,
        "side": side,
        "setupScore": setup,
        "confidence": setup / 100,
        "conditionsMetCount": len(met),
        "conditionsFailedCount": len(fail),
        "contradictionsCount": len(contradictions),
        "stopPrice": stop,
        "targetPrice": target,
        "signalActive": (setup / 100) >= 0,
    }


EVALUATORS = {
    "MOMENTUM_BREAKOUT": evaluate_momentum_breakout,
    "PULLBACK_CONTINUATION": evaluate_pullback_continuation,
    "MEAN_REVERSION": evaluate_mean_reversion,
    "TREND_FOLLOWING": evaluate_trend_following,
    "RANGE_REVERSION": evaluate_range_reversion,
}


def evaluate_all(ctx, thresholds):
    return [EVALUATORS[sid](ctx, thresholds) for sid in EVALUATORS]
