package io.argus.quantcore.institutional.ml;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class KNearestNeighborsRegressorTest {

    @Test
    void predictsTheExactValueOfAnIdenticalTrainingPointWithKEqualsOne() {
        double[][] x = { { 0, 0 }, { 10, 10 }, { 20, 20 } };
        double[] y = { 1, 2, 3 };
        var knn = KNearestNeighborsRegressor.fit(x, y);
        assertThat(knn).isNotNull();
        assertThat(knn.predict(new double[] { 10, 10 }, 1)).isEqualTo(2.0);
    }

    @Test
    void averagesTheThreeNearestNeighborsWhenKEqualsThree() {
        double[][] x = { { 0 }, { 1 }, { 2 }, { 100 } };
        double[] y = { 10, 20, 30, 1000 };
        var knn = KNearestNeighborsRegressor.fit(x, y);
        // Query point 1.5 -> three nearest are 0,1,2 (distances 1.5, 0.5, 0.5), far from 100.
        double prediction = knn.predict(new double[] { 1.5 }, 3);
        assertThat(prediction).isCloseTo(20.0, org.assertj.core.data.Offset.offset(0.01));
    }

    @Test
    void returnsNanRatherThanFabricatingWhenKExceedsTheTrainingSetSize() {
        double[][] x = { { 1 }, { 2 } };
        double[] y = { 1, 2 };
        var knn = KNearestNeighborsRegressor.fit(x, y);
        assertThat(knn.predict(new double[] { 1.5 }, 5)).isNaN();
    }

    @Test
    void returnsNullForMismatchedRowCounts() {
        double[][] x = { { 1 }, { 2 } };
        double[] y = { 1 };
        assertThat(KNearestNeighborsRegressor.fit(x, y)).isNull();
    }
}
