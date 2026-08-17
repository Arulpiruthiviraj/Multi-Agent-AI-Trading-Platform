"""
Verify TS golden fixture indicators against Python equivalents (abs delta < 1e-4).
Research-only. Not StrategyContext.evaluate() byte-identity. Not an edge.

Usage:
  python python/argus_research/verify_feature_parity.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core_features import atr, detect_market_structure, keltner_channels, sma  # noqa: E402

TOL = 1e-4
FIXTURE = ROOT / "tests" / "fixtures" / "parity_golden_sample.json"

# Mirrors config/quantThresholds.json + tradingSafety.regimeMinBars for RegimeEngine votes.
THRESH = {
    "minMeaningfulAdx": 15,
    "minMeaningfulPriceVsMaPct": 0.1,
    "minMeaningfulSlopePct": 0.05,
    "minAdxTrending": 25,
    "minAdxRanging": 20,
    "volatilityPercentileHigh": 70,
    "volatilityPercentileLow": 30,
    "regimeMinBars": 60,
}


def rsi_wilder(prices, period=14):
    """Match RSIEngine.ts (neutral 50 when len <= period)."""
    if len(prices) <= period:
        return 50.0
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        diff = prices[i] - prices[i - 1]
        if diff > 0:
            avg_gain += diff
        else:
            avg_loss += abs(diff)
    avg_gain /= period
    avg_loss /= period
    for i in range(period + 1, len(prices)):
        diff = prices[i] - prices[i - 1]
        gain = diff if diff > 0 else 0.0
        loss = abs(diff) if diff < 0 else 0.0
        avg_gain = ((avg_gain * (period - 1)) + gain) / period
        avg_loss = ((avg_loss * (period - 1)) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def ema_from_first(prices, period):
    """Match MACDEngine.calcEMA (seed = prices[0], not SMA seed)."""
    if not prices:
        return []
    mult = 2 / (period + 1)
    out = [prices[0]]
    for i in range(1, len(prices)):
        out.append((prices[i] - out[i - 1]) * mult + out[i - 1])
    return out


def macd_engine(prices, short=12, long=26, signal=9):
    if len(prices) < long:
        return {"macd": 0.0, "signal": 0.0, "histogram": 0.0}
    short_e = ema_from_first(prices, short)
    long_e = ema_from_first(prices, long)
    macd_line = [s - l for s, l in zip(short_e, long_e)]
    signal_line = ema_from_first(macd_line, signal)
    m = macd_line[-1]
    s = signal_line[-1]
    return {"macd": m, "signal": s, "histogram": m - s}


def calculate_dmi(highs, lows, closes, period=14):
    if len(closes) < period * 2 + 1:
        return None
    plus_dm, minus_dm, trs = [], [], []
    for i in range(1, len(highs)):
        up = highs[i] - highs[i - 1]
        down = lows[i - 1] - lows[i]
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        trs.append(max(hl, hc, lc))

    def wilder_smooth(series):
        out = [sum(series[:period])]
        for i in range(period, len(series)):
            out.append(out[-1] - out[-1] / period + series[i])
        return out

    smooth_tr = wilder_smooth(trs)
    smooth_plus = wilder_smooth(plus_dm)
    smooth_minus = wilder_smooth(minus_dm)
    dx_series = []
    for i in range(len(smooth_tr)):
        if smooth_tr[i] == 0:
            dx_series.append(0.0)
            continue
        plus_di = 100 * (smooth_plus[i] / smooth_tr[i])
        minus_di = 100 * (smooth_minus[i] / smooth_tr[i])
        s = plus_di + minus_di
        dx_series.append(0.0 if s == 0 else (abs(plus_di - minus_di) / s) * 100)
    if len(dx_series) < period:
        return None
    adx = sum(dx_series[:period]) / period
    for i in range(period, len(dx_series)):
        adx = ((adx * (period - 1)) + dx_series[i]) / period
    last_tr = smooth_tr[-1]
    plus_di = 0.0 if last_tr == 0 else 100 * (smooth_plus[-1] / last_tr)
    minus_di = 0.0 if last_tr == 0 else 100 * (smooth_minus[-1] / last_tr)
    return {"plusDI": plus_di, "minusDI": minus_di, "adx": adx}


def stochastic_rsi(closes, rsi_period=14, stoch_period=14):
    """Match calculateStochasticRSI — only the trailing stochPeriod RSI windows."""
    min_required = rsi_period + stoch_period
    if len(closes) < min_required:
        return None
    rsi_series = []
    for end in range(len(closes) - stoch_period + 1, len(closes) + 1):
        rsi_series.append(rsi_wilder(closes[:end], rsi_period))
    hi = max(rsi_series)
    lo = min(rsi_series)
    if hi == lo:
        return None
    return ((rsi_series[-1] - lo) / (hi - lo)) * 100


def local_extrema(values, kind):
    idx = []
    for i in range(1, len(values) - 1):
        if kind == "low" and values[i] <= values[i - 1] and values[i] <= values[i + 1]:
            idx.append(i)
        if kind == "high" and values[i] >= values[i - 1] and values[i] >= values[i + 1]:
            idx.append(i)
    return idx


def macd_divergence_kind(closes):
    if len(closes) < 8:
        return None
    osc = []
    for i in range(len(closes)):
        osc.append(macd_engine(closes[: i + 1])["histogram"])
    p_lows = local_extrema(closes, "low")
    p_highs = local_extrema(closes, "high")
    bullish = False
    bearish = False
    if len(p_lows) >= 2:
        a, b = p_lows[-2], p_lows[-1]
        bullish = closes[b] < closes[a] and osc[b] > osc[a]
    if len(p_highs) >= 2:
        a, b = p_highs[-2], p_highs[-1]
        bearish = closes[b] > closes[a] and osc[b] < osc[a]
    if bullish and bearish:
        return "NONE"
    if bullish:
        return "BULLISH"
    if bearish:
        return "BEARISH"
    return "NONE"


def atr_percent(highs, lows, closes, period=14):
    if not closes:
        return None
    a = atr(highs, lows, closes, period)
    if a == 0:
        return None
    return (a / closes[-1]) * 100


def percentile_rank(values, current):
    if not values:
        return None
    below = sum(1 for v in values if v < current)
    return (below / len(values)) * 100


def volatility_percentile(bars, lookback=100, atr_period=14):
    if len(bars) < lookback + atr_period:
        return None
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    history = []
    start = len(bars) - lookback
    for i in range(start, len(bars)):
        pct = atr_percent(highs[: i + 1], lows[: i + 1], closes[: i + 1], atr_period)
        if pct is not None:
            history.append(pct)
    if not history:
        return None
    return percentile_rank(history[:-1], history[-1])


def detect_consolidation(bars, period=10, threshold_pct=3):
    if len(bars) < period:
        return False
    window = bars[-period:]
    hi = max(b["high"] for b in window)
    lo = min(b["low"] for b in window)
    avg = sum(b["close"] for b in window) / len(window)
    if avg == 0:
        return False
    return ((hi - lo) / avg) * 100 <= threshold_pct


def ma_slope_pct(closes, period=50, lookback=10):
    if len(closes) < period + lookback:
        return None
    now = sma(closes, period)
    then = sma(closes[:-lookback], period)
    if now is None or then is None or then == 0:
        return None
    return ((now - then) / then) * 100


def price_vs_ma(price, ma):
    if ma is None or ma == 0:
        return None
    diff = price - ma
    return {"diffPct": (diff / ma) * 100, "above": diff > 0}


def classify_regime(bars):
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    structure = detect_market_structure(bars)
    dmi = calculate_dmi(highs, lows, closes)
    px = closes[-1]
    sma50 = sma(closes, 50)
    sma200 = sma(closes, 200)
    pv50 = price_vs_ma(px, sma50)
    pv200 = price_vs_ma(px, sma200)
    slope = ma_slope_pct(closes)

    votes = []
    if structure["trend"] != "SIDEWAYS":
        votes.append(structure["trend"] == "UPTREND")
    else:
        votes.append(None)
    if dmi and dmi["adx"] >= THRESH["minMeaningfulAdx"]:
        votes.append(dmi["plusDI"] > dmi["minusDI"])
    else:
        votes.append(None)
    votes.append(pv50["above"] if pv50 and abs(pv50["diffPct"]) > THRESH["minMeaningfulPriceVsMaPct"] else None)
    votes.append(pv200["above"] if pv200 and abs(pv200["diffPct"]) > THRESH["minMeaningfulPriceVsMaPct"] else None)
    votes.append(slope > 0 if slope is not None and abs(slope) > THRESH["minMeaningfulSlopePct"] else None)

    real = [v for v in votes if v is not None]
    regime = "SIDEWAYS_RANGE"
    agreement = 0.0
    if len(real) >= 2:
        bull = sum(1 for v in real if v) / len(real)
        if bull >= 0.6:
            regime = "BULLISH_TREND"
            agreement = bull
        elif bull <= 0.4:
            regime = "BEARISH_TREND"
            agreement = 1 - bull
        else:
            regime = "SIDEWAYS_RANGE"
            agreement = 1 - abs(bull - 0.5) * 2
    completeness = len(real) / len(votes) if votes else 0
    confidence = round(agreement * completeness * 100) / 100
    adx = dmi["adx"] if dmi else 0
    trend_strength = round(min(100, max(0, adx * (0.5 + agreement * 0.5))))

    vp = volatility_percentile(bars)
    if vp is None:
        vol_label = "NORMAL"
    elif vp >= THRESH["volatilityPercentileHigh"]:
        vol_label = "HIGH"
    elif vp <= THRESH["volatilityPercentileLow"]:
        vol_label = "LOW"
    else:
        vol_label = "NORMAL"

    consolidating = detect_consolidation(bars)
    if dmi and dmi["adx"] >= THRESH["minAdxTrending"]:
        mkt = "TRENDING"
    elif dmi and dmi["adx"] < THRESH["minAdxRanging"] and consolidating:
        mkt = "RANGING"
    else:
        mkt = "CHOPPY"

    return {
        "regime": regime,
        "confidence": confidence,
        "trendStrength": trend_strength,
        "volatility": vol_label,
        "marketStructure": mkt,
        "insufficientData": len(bars) < THRESH["regimeMinBars"],
    }


def compute_features(bars):
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    structure = detect_market_structure(bars)
    return {
        "rsi": rsi_wilder(closes),
        "macd": macd_engine(closes),
        "dmi": calculate_dmi(highs, lows, closes),
        "stochasticRSI": stochastic_rsi(closes),
        "keltner": keltner_channels(highs, lows, closes),
        "structure": {"trend": structure["trend"], "event": structure["event"]},
        "macdDivergenceKind": macd_divergence_kind(closes),
        "regime": classify_regime(bars),
    }


def _delta(a, b):
    if a is None and b is None:
        return 0.0
    if a is None or b is None:
        return None
    if isinstance(a, bool) or isinstance(b, bool):
        return 0.0 if a == b else None
    if isinstance(a, str) or isinstance(b, str):
        return 0.0 if a == b else None
    return abs(float(a) - float(b))


def diff_table(expected, actual):
    rows = []

    def add(field, ts, py):
        d = _delta(ts, py)
        ok = d is not None and d <= TOL
        rows.append((field, ts, py, d, ok))

    add("rsi", expected["rsi"], actual["rsi"])
    add("macd.macd", expected["macd"]["macd"], actual["macd"]["macd"])
    add("macd.signal", expected["macd"]["signal"], actual["macd"]["signal"])
    add("macd.histogram", expected["macd"]["histogram"], actual["macd"]["histogram"])
    ed, ad = expected.get("dmi"), actual.get("dmi")
    add("dmi.plusDI", None if not ed else ed["plusDI"], None if not ad else ad["plusDI"])
    add("dmi.minusDI", None if not ed else ed["minusDI"], None if not ad else ad["minusDI"])
    add("dmi.adx", None if not ed else ed["adx"], None if not ad else ad["adx"])
    add("stochasticRSI", expected.get("stochasticRSI"), actual.get("stochasticRSI"))
    ek, ak = expected.get("keltner"), actual.get("keltner")
    add("keltner.middle", None if not ek else ek["middle"], None if not ak else ak["middle"])
    add("keltner.upper", None if not ek else ek["upper"], None if not ak else ak["upper"])
    add("keltner.lower", None if not ek else ek["lower"], None if not ak else ak["lower"])
    add("structure.trend", expected["structure"]["trend"], actual["structure"]["trend"])
    add("structure.event", expected["structure"]["event"], actual["structure"]["event"])
    add("macdDivergenceKind", expected.get("macdDivergenceKind"), actual.get("macdDivergenceKind"))
    er, ar = expected["regime"], actual["regime"]
    add("regime.regime", er["regime"], ar["regime"])
    add("regime.confidence", er["confidence"], ar["confidence"])
    add("regime.trendStrength", er["trendStrength"], ar["trendStrength"])
    add("regime.volatility", er["volatility"], ar["volatility"])
    add("regime.marketStructure", er["marketStructure"], ar["marketStructure"])
    add("regime.insufficientData", er["insufficientData"], ar["insufficientData"])
    return rows


def main():
    if not FIXTURE.exists():
        print(f"MISSING_FIXTURE {FIXTURE}")
        print("Generate with: npx tsx -e \"import { writeParityGoldenSample } from './src/server/research/strategyContextParity.ts'; writeParityGoldenSample();\"")
        return 1
    ds = json.loads(FIXTURE.read_text(encoding="utf-8"))
    actual = compute_features(ds["bars"])
    rows = diff_table(ds["expected"], actual)
    print(f"{'field':32} {'ts':18} {'py':18} {'delta':12} ok")
    print("-" * 90)
    failed = []
    for field, ts, py, d, ok in rows:
        print(f"{field:32} {str(ts)[:18]:18} {str(py)[:18]:18} {str(d)[:12]:12} {'PASS' if ok else 'FAIL'}")
        if not ok:
            failed.append(field)
    print("-" * 90)
    if failed:
        print(f"FAIL fields={failed}")
        return 1
    print("ok abs_delta<1e-4")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
