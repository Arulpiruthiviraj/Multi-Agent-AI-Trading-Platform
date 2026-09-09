package io.argus.quantcore.institutional.math;

/**
 * Standard normal distribution CDF/PDF, needed by Black-Scholes and related option-pricing math.
 * CDF uses the Abramowitz &amp; Stegun 7.1.26 rational approximation to the error function
 * (published, accurate to ~1.5e-7 absolute error) - a real, well-known numerical method, not an
 * invented shortcut.
 */
public final class NormalDistribution {

    private NormalDistribution() {
    }

    private static final double A1 = 0.254829592;
    private static final double A2 = -0.284496736;
    private static final double A3 = 1.421413741;
    private static final double A4 = -1.453152027;
    private static final double A5 = 1.061405429;
    private static final double P = 0.3275911;

    /** Standard normal PDF: n(x) = (1/sqrt(2*pi)) * exp(-x^2/2). */
    public static double pdf(double x) {
        return Math.exp(-x * x / 2.0) / Math.sqrt(2.0 * Math.PI);
    }

    /** Standard normal CDF: N(x) = 0.5 * (1 + erf(x/sqrt(2))), via the A&amp;S 7.1.26 erf approximation. */
    public static double cdf(double x) {
        int sign = x < 0 ? -1 : 1;
        double ax = Math.abs(x) / Math.sqrt(2.0);

        double t = 1.0 / (1.0 + P * ax);
        double y = 1.0 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * Math.exp(-ax * ax);

        return 0.5 * (1.0 + sign * y);
    }
}
