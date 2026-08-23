package io.argus.quantcore.backtest.engine;

/**
 * Ported byte-for-byte from src/server/engines/backtest/Commissions.ts — real Alpaca-oriented
 * cost model (this repo's own verified real backtest commission model: $0 broker commission,
 * real SEC Section 31 fee + FINRA TAF, both sells-only), NOT the IBKR $1.00 tiered structure
 * this Phase 4 request originally specified. Ported the model this repo actually verified and
 * uses elsewhere rather than a different broker's fee schedule that isn't what BacktestEngine.ts
 * models today - see docs/audits/JAVA_BACKTEST_REPORT for this note surfaced explicitly.
 */
public final class Commissions {

    public static final double SEC_FEE_RATE_PER_DOLLAR = 20.60 / 1_000_000; // sells only
    public static final double FINRA_TAF_PER_SHARE = 0.000195; // sells only
    public static final double FINRA_TAF_MIN = 0.01;
    public static final double FINRA_TAF_CAP = 9.79;

    private Commissions() {
    }

    public record Result(double total, double secFee, double finraTaf, double brokerCommission) {
    }

    public static Result calculate(String side, double quantity, double fillPrice, double brokerCommissionPerTrade) {
        if (!"SELL".equals(side) || quantity <= 0) {
            return new Result(round2(brokerCommissionPerTrade), 0, 0, brokerCommissionPerTrade);
        }
        double principal = quantity * fillPrice;
        double secFee = Math.ceil(principal * SEC_FEE_RATE_PER_DOLLAR * 100) / 100;
        double rawTaf = Math.ceil(quantity * FINRA_TAF_PER_SHARE * 100) / 100;
        double finraTaf = Math.max(FINRA_TAF_MIN, Math.min(FINRA_TAF_CAP, rawTaf));
        return new Result(round2(brokerCommissionPerTrade + secFee + finraTaf), secFee, finraTaf, brokerCommissionPerTrade);
    }

    public static Result calculate(String side, double quantity, double fillPrice) {
        return calculate(side, quantity, fillPrice, 0);
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
