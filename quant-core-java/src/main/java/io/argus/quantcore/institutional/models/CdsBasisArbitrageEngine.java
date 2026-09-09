package io.argus.quantcore.institutional.models;

/**
 * CDS basis arbitrage - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 5.14,
 * Eq. 417. A CDS makes a bond effectively risk-free, so its spread should equal the bond's own
 * yield spread over the risk-free rate; the difference (the "CDS basis") signals a relative-value
 * trade. Negative basis (bond spread too high, bond cheap relative to CDS) -&gt; buy the bond and
 * buy protection (the CDS). Positive basis in practice usually means unwinding an existing
 * position rather than a fresh short, per the paper's own note.
 */
public final class CdsBasisArbitrageEngine {

    private CdsBasisArbitrageEngine() {
    }

    public record Result(
        double basis,
        String signal // BUY_BOND_BUY_PROTECTION (negative basis), UNWIND_OR_NEUTRAL (positive/zero basis)
    ) {
    }

    public static Result evaluate(double cdsSpread, double bondSpread) {
        double basis = cdsSpread - bondSpread;
        String signal = basis < 0 ? "BUY_BOND_BUY_PROTECTION" : "UNWIND_OR_NEUTRAL";
        return new Result(basis, signal);
    }
}
