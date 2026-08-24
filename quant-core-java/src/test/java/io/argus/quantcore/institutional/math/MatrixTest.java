package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MatrixTest {

    @Test
    void invertsIdentityToItself() {
        double[][] identity = {{1, 0}, {0, 1}};
        double[][] inv = Matrix.invert(identity);
        assertThat(inv).isNotNull();
        assertThat(inv[0][0]).isEqualTo(1.0);
        assertThat(inv[1][1]).isEqualTo(1.0);
        assertThat(inv[0][1]).isEqualTo(0.0);
    }

    @Test
    void invertedMatrixTimesOriginalIsIdentity() {
        double[][] a = {{4, 7}, {2, 6}};
        double[][] inv = Matrix.invert(a);
        assertThat(inv).isNotNull();
        double[][] product = Matrix.multiply(a, inv);
        assertThat(product[0][0]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(product[1][1]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(product[0][1]).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(product[1][0]).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void returnsNullForSingularMatrix() {
        double[][] singular = {{1, 2}, {2, 4}};
        assertThat(Matrix.invert(singular)).isNull();
    }

    @Test
    void multiplyMatchesHandComputedResult() {
        double[][] a = {{1, 2}, {3, 4}};
        double[][] b = {{5, 6}, {7, 8}};
        double[][] c = Matrix.multiply(a, b);
        assertThat(c[0][0]).isEqualTo(19.0);
        assertThat(c[0][1]).isEqualTo(22.0);
        assertThat(c[1][0]).isEqualTo(43.0);
        assertThat(c[1][1]).isEqualTo(50.0);
    }

    @Test
    void transposeSwapsRowsAndColumns() {
        double[][] a = {{1, 2, 3}, {4, 5, 6}};
        double[][] t = Matrix.transpose(a);
        assertThat(t.length).isEqualTo(3);
        assertThat(t[0].length).isEqualTo(2);
        assertThat(t[2][1]).isEqualTo(6.0);
    }
}
