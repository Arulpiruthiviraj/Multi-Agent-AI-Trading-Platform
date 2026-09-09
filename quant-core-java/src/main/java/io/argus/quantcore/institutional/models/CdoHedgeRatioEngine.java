package io.argus.quantcore.institutional.models;

/**
 * CDO tranche hedge ratios - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections
 * 11.2-11.5. All four hedging variants (equity tranche hedged with the index, senior/mezzanine
 * tranche hedged with the index, tranche hedged with another tranche, tranche hedged with a
 * single-name CDS) reduce to the SAME formula, Eq. 487: Delta = D / D_hedge, the ratio of the
 * position's own risky duration to the hedging instrument's risky duration - Eq. 488-489 are just
 * that formula with different duration inputs. One method, not four near-identical copies.
 */
public final class CdoHedgeRatioEngine {

    private CdoHedgeRatioEngine() {
    }

    /**
     * @param positionRiskyDuration D, the risky duration (Eq. 486) of the tranche/position being hedged.
     * @param hedgeInstrumentRiskyDuration D_hedge, the risky duration of the hedging instrument
     *                                     (CDS index, another tranche, or a single-name CDS - Eq.
     *                                     487/488/489 all use this same ratio, just a different
     *                                     hedge instrument).
     * @return null if the hedge instrument's duration is not positive.
     */
    public static Double evaluate(double positionRiskyDuration, double hedgeInstrumentRiskyDuration) {
        if (hedgeInstrumentRiskyDuration <= 0) {
            return null;
        }
        return positionRiskyDuration / hedgeInstrumentRiskyDuration;
    }
}
