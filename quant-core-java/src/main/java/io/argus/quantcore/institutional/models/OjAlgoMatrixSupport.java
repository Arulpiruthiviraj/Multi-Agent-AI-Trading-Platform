package io.argus.quantcore.institutional.models;

import org.ojalgo.matrix.MatrixR064;
import org.ojalgo.structure.Factory2D;

/**
 * Shared ojAlgo {@link MatrixR064} construction helpers (extracted 2026-09-23 from
 * {@link OjAlgoPortfolioRiskEngine}, roadmap Priority #6, so {@link PortfolioOptimizationEngine}
 * reuses the identical, already-tested conversion rather than a second private copy - "single
 * authoritative path per calculation" applied to plain data-marshalling code, not just quant math).
 */
final class OjAlgoMatrixSupport {

    private OjAlgoMatrixSupport() {
    }

    static MatrixR064 toMatrix(double[][] values) {
        int n = values.length;
        Factory2D.Builder<MatrixR064> builder = MatrixR064.FACTORY.newDenseBuilder(n, n);
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                builder.set(i, j, values[i][j]);
            }
        }
        return builder.build();
    }

    static MatrixR064 toColumnVector(double[] values) {
        Factory2D.Builder<MatrixR064> builder = MatrixR064.FACTORY.newDenseBuilder(values.length, 1);
        for (int i = 0; i < values.length; i++) {
            builder.set(i, 0, values[i]);
        }
        return builder.build();
    }
}
