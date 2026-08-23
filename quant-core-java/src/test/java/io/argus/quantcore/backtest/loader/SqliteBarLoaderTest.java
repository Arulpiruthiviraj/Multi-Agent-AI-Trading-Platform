package io.argus.quantcore.backtest.loader;

import io.argus.quantcore.backtest.engine.Bar;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Reads the REAL data/argus.db (read-only) - not a synthetic fixture. Skips itself (rather than
 * failing) if that file isn't present in whatever environment runs this suite, since it's a real
 * runtime artifact, not something committed to the repo.
 */
class SqliteBarLoaderTest {

    private static final String DB_PATH = "../data/argus.db";

    @Test
    void loadsRealDailyBarsForAKnownLiquidSymbol() throws Exception {
        assumeTrue(new File(DB_PATH).exists(), "data/argus.db not present in this environment - skipping real-data test");

        try (SqliteBarLoader loader = new SqliteBarLoader(DB_PATH)) {
            List<Bar> bars = loader.loadBars("SPY", "1Day", 0L, System.currentTimeMillis());
            assertThat(bars).isNotEmpty();
            // Chronologically ascending, matching the loader's own ORDER BY timestamp ASC.
            for (int i = 1; i < bars.size(); i++) {
                assertThat(bars.get(i).timestampMs()).isGreaterThanOrEqualTo(bars.get(i - 1).timestampMs());
            }
            assertThat(bars.get(0).close()).isGreaterThan(0);
        }
    }

    @Test
    void listSymbolsReturnsOnlySymbolsMeetingTheMinBarsFloor() throws Exception {
        assumeTrue(new File(DB_PATH).exists(), "data/argus.db not present in this environment - skipping real-data test");

        try (SqliteBarLoader loader = new SqliteBarLoader(DB_PATH)) {
            List<String> symbols = loader.listSymbols("1Day", 2000);
            assertThat(symbols).contains("SPY", "AAPL", "NVDA");
            assertThat(symbols).doesNotContain("TLT"); // known thin symbol, ~64 daily bars
        }
    }

    @Test
    void returnsEmptyForAnUnknownSymbol() throws Exception {
        assumeTrue(new File(DB_PATH).exists(), "data/argus.db not present in this environment - skipping real-data test");

        try (SqliteBarLoader loader = new SqliteBarLoader(DB_PATH)) {
            List<Bar> bars = loader.loadBars("NOT_A_REAL_SYMBOL_XYZ", "1Day", 0L, System.currentTimeMillis());
            assertThat(bars).isEmpty();
        }
    }
}
