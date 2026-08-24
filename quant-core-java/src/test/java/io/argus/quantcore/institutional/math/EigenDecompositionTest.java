package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class EigenDecompositionTest {

    @Test
    void recoversTheKnownEigenvaluesOfAClassicTwoByTwoSymmetricMatrix() {
        // [[2,1],[1,2]] has eigenvalues 3 and 1 (well-known textbook example).
        double[][] m = { { 2, 1 }, { 1, 2 } };
        var result = EigenDecomposition.decompose(m);
        assertThat(result).isNotNull();
        assertThat(result.eigenvalues()[0]).isCloseTo(3.0, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(result.eigenvalues()[1]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void returnsTheDiagonalItselfForAnAlreadyDiagonalMatrix() {
        double[][] m = { { 5, 0, 0 }, { 0, 2, 0 }, { 0, 0, 9 } };
        var result = EigenDecomposition.decompose(m);
        // Sorted descending.
        assertThat(result.eigenvalues()).containsExactly(9.0, 5.0, 2.0);
    }

    @Test
    void eigenvectorsAreOrthonormalAndSatisfyAvEqualsLambdaV() {
        double[][] m = { { 4, 1 }, { 1, 3 } };
        var result = EigenDecomposition.decompose(m);
        double[] v0 = { result.eigenvectors()[0][0], result.eigenvectors()[1][0] };
        double norm = Math.sqrt(v0[0] * v0[0] + v0[1] * v0[1]);
        assertThat(norm).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-6));

        double[] av = Matrix.multiply(m, v0);
        double lambda = result.eigenvalues()[0];
        assertThat(av[0]).isCloseTo(lambda * v0[0], org.assertj.core.data.Offset.offset(1e-6));
        assertThat(av[1]).isCloseTo(lambda * v0[1], org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void returnsNullForANonSymmetricMatrix() {
        double[][] m = { { 1, 2 }, { 3, 4 } };
        assertThat(EigenDecomposition.decompose(m)).isNull();
    }
}
