package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.NormalDistribution;

/**
 * Black-Scholes-Merton European option pricing and Greeks (with continuous dividend yield q) -
 * the standard closed-form model (Black &amp; Scholes 1973, Merton 1973), not a trading strategy
 * itself but the pricing framework several genuine strategies in this catalog need: comparing a
 * quoted premium to a model price (is it cheap/expensive relative to a volatility estimate),
 * computing Greeks as portfolio-construction signals, and estimating a remaining option leg's
 * value at a future date (the missing piece that made Calendar/Diagonal spreads non-computable
 * earlier this session without a pricing model).
 *
 * <p>d1 = [ln(S/K) + (r-q+sigma^2/2)T] / (sigma*sqrt(T)); d2 = d1 - sigma*sqrt(T). Vega is
 * returned per unit (1.00 = 100 percentage points) of volatility, not per 1% - divide by 100 for
 * the conventional "per vol point" quoting convention if needed. Theta is returned per YEAR, not
 * per day - divide by 365 for the conventional "per day" quoting convention if needed. Neither
 * conversion is baked in, to avoid silently picking a convention the caller didn't ask for.
 */
public final class BlackScholesEngine {

    private BlackScholesEngine() {
    }

    public record Result(
        double price,
        double delta,
        double gamma,
        double vega,  // per unit (1.00) of volatility
        double theta  // per year
    ) {
    }

    /**
     * @param spot         S, current underlying price.
     * @param strike       K.
     * @param riskFreeRate r (continuously compounded, annualized).
     * @param dividendYield q (continuously compounded, annualized); pass 0 for a non-dividend-paying underlying.
     * @param volatility   sigma (annualized).
     * @param timeToExpiryYears T, in years.
     * @return null if any of spot/strike/volatility/timeToExpiryYears is not positive.
     */
    public static Result call(double spot, double strike, double riskFreeRate, double dividendYield, double volatility, double timeToExpiryYears) {
        if (spot <= 0 || strike <= 0 || volatility <= 0 || timeToExpiryYears <= 0) {
            return null;
        }
        double sqrtT = Math.sqrt(timeToExpiryYears);
        double d1 = (Math.log(spot / strike) + (riskFreeRate - dividendYield + volatility * volatility / 2.0) * timeToExpiryYears) / (volatility * sqrtT);
        double d2 = d1 - volatility * sqrtT;

        double discountedSpot = spot * Math.exp(-dividendYield * timeToExpiryYears);
        double discountedStrike = strike * Math.exp(-riskFreeRate * timeToExpiryYears);

        double price = discountedSpot * NormalDistribution.cdf(d1) - discountedStrike * NormalDistribution.cdf(d2);
        double delta = Math.exp(-dividendYield * timeToExpiryYears) * NormalDistribution.cdf(d1);
        double gamma = Math.exp(-dividendYield * timeToExpiryYears) * NormalDistribution.pdf(d1) / (spot * volatility * sqrtT);
        double vega = discountedSpot * NormalDistribution.pdf(d1) * sqrtT;
        double theta = -(discountedSpot * NormalDistribution.pdf(d1) * volatility) / (2 * sqrtT)
            - riskFreeRate * discountedStrike * NormalDistribution.cdf(d2)
            + dividendYield * discountedSpot * NormalDistribution.cdf(d1);

        return new Result(price, delta, gamma, vega, theta);
    }

    /** Put price/Greeks via put-call symmetry of N(-d1)/N(-d2). Same preconditions/return contract as {@link #call}. */
    public static Result put(double spot, double strike, double riskFreeRate, double dividendYield, double volatility, double timeToExpiryYears) {
        if (spot <= 0 || strike <= 0 || volatility <= 0 || timeToExpiryYears <= 0) {
            return null;
        }
        double sqrtT = Math.sqrt(timeToExpiryYears);
        double d1 = (Math.log(spot / strike) + (riskFreeRate - dividendYield + volatility * volatility / 2.0) * timeToExpiryYears) / (volatility * sqrtT);
        double d2 = d1 - volatility * sqrtT;

        double discountedSpot = spot * Math.exp(-dividendYield * timeToExpiryYears);
        double discountedStrike = strike * Math.exp(-riskFreeRate * timeToExpiryYears);

        double price = discountedStrike * NormalDistribution.cdf(-d2) - discountedSpot * NormalDistribution.cdf(-d1);
        double delta = -Math.exp(-dividendYield * timeToExpiryYears) * NormalDistribution.cdf(-d1);
        double gamma = Math.exp(-dividendYield * timeToExpiryYears) * NormalDistribution.pdf(d1) / (spot * volatility * sqrtT);
        double vega = discountedSpot * NormalDistribution.pdf(d1) * sqrtT;
        double theta = -(discountedSpot * NormalDistribution.pdf(d1) * volatility) / (2 * sqrtT)
            + riskFreeRate * discountedStrike * NormalDistribution.cdf(-d2)
            - dividendYield * discountedSpot * NormalDistribution.cdf(-d1);

        return new Result(price, delta, gamma, vega, theta);
    }
}
