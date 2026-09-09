package io.argus.quantcore.institutional.models;

/**
 * CDO tranche mark-to-market waterfall - Kakushadze &amp; Serur, "151 Trading Strategies" (2018),
 * Section 11.1, Eq. 481-486. Computes the premium leg P, contingent (default) leg C, mark-to-market
 * value M = P - C, and risky duration D of a CDO tranche, GIVEN a caller-supplied expected-loss
 * schedule L(t) (Eq. 481's own pα(t)/ℓα default-probability model is explicitly "model-dependent" -
 * the paper does not specify it, so this class does not fabricate one; L(t) must come from the
 * caller's own credit model). This is a real, fully-specified deterministic waterfall given that
 * input - not a full CDO pricing library, which the source material itself does not provide.
 */
public final class CdoTrancheWaterfallEngine {

    private CdoTrancheWaterfallEngine() {
    }

    public record PremiumPaymentDate(double discountFactor, double yearFraction, double expectedLoss) {
    }

    public record Result(
        double premiumLeg,
        double contingentLeg,
        double markToMarket,
        double riskyDuration,
        double fairSpread // S* such that markToMarket == 0
    ) {
    }

    /**
     * @param spread          S, the tranche's contractual premium spread.
     * @param attachmentPct   a, the tranche's attachment point (e.g. 0.03 for a 3% attach).
     * @param detachmentPct   d, the tranche's detachment point (e.g. 0.08 for an 8% detach).
     * @param cdoNotional     M_CDO, the total CDO notional in dollars.
     * @param paymentDates    per-payment-date discount factor, year-fraction (delta_i), and the
     *                        caller-supplied expected loss L(t_i) at that date (Eq. 481, already
     *                        computed externally - not by this class).
     * @return null if fewer than 1 payment date is supplied, detachment &lt;= attachment, or
     *         the payment schedule can't determine a fair spread (risky duration is zero).
     */
    public static Result evaluate(double spread, double attachmentPct, double detachmentPct, double cdoNotional, PremiumPaymentDate[] paymentDates) {
        if (paymentDates == null || paymentDates.length < 1 || detachmentPct <= attachmentPct || cdoNotional <= 0) {
            return null;
        }
        double trancheNotional = (detachmentPct - attachmentPct) * cdoNotional;

        double premiumLeg = 0;
        for (PremiumPaymentDate pd : paymentDates) {
            premiumLeg += pd.discountFactor() * pd.yearFraction() * (trancheNotional - pd.expectedLoss());
        }
        premiumLeg *= spread;

        double contingentLeg = 0;
        double previousLoss = 0;
        for (PremiumPaymentDate pd : paymentDates) {
            contingentLeg += pd.discountFactor() * (pd.expectedLoss() - previousLoss);
            previousLoss = pd.expectedLoss();
        }

        double markToMarket = premiumLeg - contingentLeg;

        double riskyDuration = 0;
        for (PremiumPaymentDate pd : paymentDates) {
            riskyDuration += pd.discountFactor() * pd.yearFraction() * (trancheNotional - pd.expectedLoss());
        }
        if (riskyDuration == 0) {
            return null;
        }
        double fairSpread = contingentLeg / riskyDuration;

        return new Result(premiumLeg, contingentLeg, markToMarket, riskyDuration, fairSpread);
    }
}
