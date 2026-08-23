package io.argus.quantcore.server;

import io.argus.quantcore.server.json.Json;
import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyContext.*;

import java.util.Map;

/**
 * Decodes the JSON body of {@code POST /api/v1/evaluate} into a {@link StrategyContext}. The
 * TypeScript side computes the real feature tree (RegimeEngine/trend/volume/priceAction/
 * supportResistance/MarketContext — none of which are ported to Java, see StrategyContext.java's
 * own header comment) and serializes it here so the Java strategies evaluate the SAME real
 * inputs the live TypeScript strategy would — this is what makes shadow-parity comparison of the
 * strategies' own decision logic (not their upstream feature computation) meaningful.
 */
final class StrategyContextCodec {

    private StrategyContextCodec() {
    }

    static StrategyContext decode(Map<String, Object> json) {
        Map<String, Object> trend = Json.asObject(json.get("trend"));
        Map<String, Object> momentum = Json.asObject(json.get("momentum"));
        Map<String, Object> volatility = Json.asObject(json.get("volatility"));
        Map<String, Object> volume = Json.asObject(json.get("volume"));
        Map<String, Object> priceAction = Json.asObject(json.get("priceAction"));
        Map<String, Object> supportResistance = Json.asObject(json.get("supportResistance"));
        Map<String, Object> regime = Json.asObject(json.get("regime"));
        Map<String, Object> marketContext = Json.asObject(json.get("marketContext"));

        return new StrategyContext(
            Json.asString(json.get("symbol")),
            Json.asDoublePrimitive(json.get("currentPrice"), 0),
            decodeTrend(trend),
            decodeMomentum(momentum),
            decodeVolatility(volatility),
            decodeVolume(volume),
            decodePriceAction(priceAction),
            decodeSupportResistance(supportResistance),
            decodeRegime(regime),
            decodeMarketContext(marketContext)
        );
    }

    private static TrendFeatures decodeTrend(Map<String, Object> t) {
        Map<String, Object> structure = Json.asObject(t.get("structure"));
        Map<String, Object> pvma20 = Json.asObject(t.get("priceVsSMA20"));
        Map<String, Object> pvma200 = Json.asObject(t.get("priceVsSMA200"));
        Map<String, Object> ma = Json.asObject(t.get("movingAverages"));
        Map<String, Object> dmi = t.get("dmi") == null ? null : Json.asObject(t.get("dmi"));

        return new TrendFeatures(
            new Structure(
                Json.asString(structure.get("event")),
                Json.asString(structure.get("trend")),
                Json.asDouble(structure.get("lastSwingHigh")),
                Json.asDouble(structure.get("lastSwingLow"))),
            pvma20 == null ? null : new PriceVsMa(Json.asDoublePrimitive(pvma20.get("diffPct"), 0), Boolean.TRUE.equals(pvma20.get("above"))),
            pvma200 == null ? null : new PriceVsMa(Json.asDoublePrimitive(pvma200.get("diffPct"), 0), Boolean.TRUE.equals(pvma200.get("above"))),
            new MovingAverages(Json.asDouble(ma.get("sma20")), Json.asDouble(ma.get("sma50")), Json.asDouble(ma.get("sma200"))),
            dmi == null ? null : new Dmi(Json.asDoublePrimitive(dmi.get("plusDI"), 0), Json.asDoublePrimitive(dmi.get("minusDI"), 0), Json.asDoublePrimitive(dmi.get("adx"), 0))
        );
    }

    private static MomentumFeatures decodeMomentum(Map<String, Object> m) {
        Map<String, Object> macdObj = Json.asObject(m.get("macd"));
        return new MomentumFeatures(
            Json.asDoublePrimitive(m.get("rsi"), 50),
            Json.asDouble(m.get("roc")),
            Json.asDouble(m.get("stochasticRSI")),
            new Macd(Json.asDoublePrimitive(macdObj.get("macd"), 0), Json.asDoublePrimitive(macdObj.get("signal"), 0))
        );
    }

    private static VolatilityFeatures decodeVolatility(Map<String, Object> v) {
        Map<String, Object> keltner = v.get("keltner") == null ? null : Json.asObject(v.get("keltner"));
        return new VolatilityFeatures(
            Json.asString(v.get("regime")),
            Json.asDoublePrimitive(v.get("atr"), 0),
            keltner == null ? null : new Keltner(
                Json.asDoublePrimitive(keltner.get("upper"), 0),
                Json.asDoublePrimitive(keltner.get("lower"), 0),
                Json.asDoublePrimitive(keltner.get("middle"), 0))
        );
    }

    private static VolumeFeatures decodeVolume(Map<String, Object> v) {
        Map<String, Object> vwap = Json.asObject(v.get("vwap"));
        return new VolumeFeatures(
            Json.asDouble(v.get("relativeVolume")),
            new Vwap(Json.asDouble(vwap.get("distancePct"))),
            Json.asDouble(v.get("cmf")),
            v.get("isSpike") == null ? null : Json.asBoolean(v.get("isSpike"))
        );
    }

    private static PriceActionFeatures decodePriceAction(Map<String, Object> p) {
        return new PriceActionFeatures(Json.asString(p.get("candlestick")), Boolean.TRUE.equals(p.get("consolidating")));
    }

    private static SupportResistanceFeatures decodeSupportResistance(Map<String, Object> sr) {
        Map<String, Object> nearest = Json.asObject(sr.get("nearest"));
        return new SupportResistanceFeatures(new Nearest(decodeLevel(nearest.get("nearestSupport")), decodeLevel(nearest.get("nearestResistance"))));
    }

    private static Level decodeLevel(Object raw) {
        if (raw == null) {
            return null;
        }
        Map<String, Object> obj = Json.asObject(raw);
        return new Level(Json.asDoublePrimitive(obj.get("level"), 0), Json.asDoublePrimitive(obj.get("pct"), 0));
    }

    private static RegimeResult decodeRegime(Map<String, Object> r) {
        return new RegimeResult(Json.asString(r.get("regime")), Json.asString(r.get("marketStructure")), Json.asDoublePrimitive(r.get("trendStrength"), 0));
    }

    private static MarketContextResult decodeMarketContext(Map<String, Object> mc) {
        Map<String, Object> sector = Json.asObject(mc.get("sector"));
        Object trendRaw = sector.get("trend");
        SectorTrend sectorTrend = null;
        if (trendRaw != null) {
            Map<String, Object> trendObj = Json.asObject(trendRaw);
            Object regimeRaw = trendObj.get("regime");
            sectorTrend = new SectorTrend(regimeRaw == null ? null : decodeRegime(Json.asObject(regimeRaw)));
        }
        Object rsRaw = mc.get("relativeStrengthVsSPY");
        RelativeStrength rs = rsRaw == null ? null : new RelativeStrength(Json.asDouble(Json.asObject(rsRaw).get("relativeStrengthPct")));
        return new MarketContextResult(new Sector(sectorTrend), rs);
    }
}
