package io.argus.quantcore.risk;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * MetaLabelSizingTest - verifies the S-curve bet-sizing primitive.
 *
 * size(p) = 2*Phi((p-0.5)/sqrt(p*(1-p))) - 1
 */
class MetaLabelSizingTest {

    @Test
    void noEdgeGivesZeroSize() {
        assertThat(MetaLabelSizing.size(0.5)).isCloseTo(0.0, within(1e-6));
    }

    @Test
    void positiveEdgeGivesPositiveSize() {
        assertThat(MetaLabelSizing.size(0.6)).isGreaterThan(0.0);
        assertThat(MetaLabelSizing.size(0.9)).isGreaterThan(MetaLabelSizing.size(0.6));
    }

    @Test
    void negativeEdgeGivesNegativeSizeSymmetric() {
        double up = MetaLabelSizing.size(0.6);
        double down = MetaLabelSizing.size(0.4);
        assertThat(down).isCloseTo(-up, within(1e-12));
    }

    @Test
    void sizeIsMonotonicInProbability() {
        double prev = MetaLabelSizing.size(0.01);
        for (double p = 0.05; p < 1.0; p += 0.05) {
            double cur = MetaLabelSizing.size(p);
            assertThat(cur).isGreaterThan(prev);
            prev = cur;
        }
    }

    @Test
    void sizeIsBoundedInUnitInterval() {
        // Extreme probabilities saturate at the bounds (CDF underflow) - still within [-1, 1].
        assertThat(MetaLabelSizing.size(0.001)).isBetween(-1.0, 0.0);
        assertThat(MetaLabelSizing.size(0.999)).isBetween(0.0, 1.0);
        // Near-certainty approaches the bounds.
        assertThat(MetaLabelSizing.size(0.9999)).isCloseTo(1.0, within(0.01));
        assertThat(MetaLabelSizing.size(0.0001)).isCloseTo(-1.0, within(0.01));
    }

    @Test
    void rejectsOutOfRangeProbabilities() {
        assertThatThrownBy(() -> MetaLabelSizing.size(0.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(1.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(-0.1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(1.1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(Double.NaN)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(Double.POSITIVE_INFINITY)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void maxFractionScalesCorrectly() {
        double base = MetaLabelSizing.size(0.7);
        assertThat(MetaLabelSizing.size(0.7, 0.5)).isCloseTo(base * 0.5, within(1e-12));
        assertThat(MetaLabelSizing.size(0.7, 1.0)).isCloseTo(base, within(1e-12));
    }

    @Test
    void rejectsInvalidMaxFraction() {
        assertThatThrownBy(() -> MetaLabelSizing.size(0.7, 0.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(0.7, 1.5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MetaLabelSizing.size(0.7, Double.NaN)).isInstanceOf(IllegalArgumentException.class);
    }
}
