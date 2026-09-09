package io.argus.quantcore.institutional.models;

/**
 * FX triangular arbitrage - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 8.5.
 * Three currencies A, B, C: chain i) A-&gt;B-&gt;C-&gt;A gives overall exchange rate
 * R = Bid(A-&gt;B) * Bid(B-&gt;C) * (1/Ask(C-&gt;A)) (Eq. 453). R &gt; 1 is a genuine (if ephemeral)
 * risk-free-arbitrage opportunity. Chain ii) (A-&gt;C-&gt;B-&gt;A) is the same computation with B and C
 * swapped - both directions are checked here since the paper only derives the first explicitly
 * ("the second one is obtained by swapping B for C").
 */
public final class FxTriangularArbitrageEngine {

    private FxTriangularArbitrageEngine() {
    }

    public record Result(
        double chainAtoBtoCtoA,
        double chainAtoCtoBtoA,
        boolean arbitrageAvailable,
        String direction // "A_B_C_A", "A_C_B_A", or "NONE"
    ) {
    }

    /**
     * @param bidAB bid rate for exchanging A into B (units of B per unit of A).
     * @param bidBC bid rate for exchanging B into C.
     * @param askCA ask rate for exchanging C into A.
     * @param bidAC bid rate for exchanging A into C (for the reverse chain).
     * @param bidCB bid rate for exchanging C into B.
     * @param askBA ask rate for exchanging B into A.
     * @return null if any input rate is not positive.
     */
    public static Result evaluate(double bidAB, double bidBC, double askCA, double bidAC, double bidCB, double askBA) {
        if (bidAB <= 0 || bidBC <= 0 || askCA <= 0 || bidAC <= 0 || bidCB <= 0 || askBA <= 0) {
            return null;
        }
        double chain1 = bidAB * bidBC * (1.0 / askCA);
        double chain2 = bidAC * bidCB * (1.0 / askBA);

        boolean arb1 = chain1 > 1.0;
        boolean arb2 = chain2 > 1.0;
        String direction = arb1 ? "A_B_C_A" : arb2 ? "A_C_B_A" : "NONE";

        return new Result(chain1, chain2, arb1 || arb2, direction);
    }
}
