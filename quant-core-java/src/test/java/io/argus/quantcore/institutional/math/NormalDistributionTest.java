package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class NormalDistributionTest {

    @Test
    void cdfAtZero_isOneHalf() {
        assertThat(NormalDistribution.cdf(0)).isCloseTo(0.5, within(1e-9));
    }

    @Test
    void cdfIsSymmetric_aroundZero() {
        assertThat(NormalDistribution.cdf(1.0) + NormalDistribution.cdf(-1.0)).isCloseTo(1.0, within(1e-7));
    }

    @Test
    void cdfMatchesWellKnownStandardNormalTableValues() {
        // Standard normal table: N(1.96) ~ 0.9750, N(-1.96) ~ 0.0250.
        assertThat(NormalDistribution.cdf(1.96)).isCloseTo(0.9750, within(1e-4));
        assertThat(NormalDistribution.cdf(-1.96)).isCloseTo(0.0250, within(1e-4));
    }

    @Test
    void pdfAtZero_matchesOneOverSqrtTwoPi() {
        assertThat(NormalDistribution.pdf(0)).isCloseTo(1.0 / Math.sqrt(2 * Math.PI), within(1e-9));
    }

    @Test
    void pdfIsSymmetric_aroundZero() {
        assertThat(NormalDistribution.pdf(1.5)).isCloseTo(NormalDistribution.pdf(-1.5), within(1e-9));
    }
}
