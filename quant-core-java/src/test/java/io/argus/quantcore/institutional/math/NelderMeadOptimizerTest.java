package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class NelderMeadOptimizerTest {

    @Test
    void minimizesASimpleConvexQuadratic() {
        // f(x,y) = (x-3)^2 + (y+2)^2, minimum at (3,-2), f=0.
        NelderMeadOptimizer.ObjectiveFunction f = p -> Math.pow(p[0] - 3, 2) + Math.pow(p[1] + 2, 2);
        double[] result = NelderMeadOptimizer.minimize(f, new double[]{0, 0}, 2000, 1e-12);
        assertThat(result[0]).isCloseTo(3.0, org.assertj.core.data.Offset.offset(1e-3));
        assertThat(result[1]).isCloseTo(-2.0, org.assertj.core.data.Offset.offset(1e-3));
    }

    @Test
    void handlesAnAlreadyOptimalStartingPoint() {
        NelderMeadOptimizer.ObjectiveFunction f = p -> p[0] * p[0];
        double[] result = NelderMeadOptimizer.minimize(f, new double[]{0}, 500, 1e-10);
        assertThat(Math.abs(result[0])).isLessThan(0.05);
    }
}
