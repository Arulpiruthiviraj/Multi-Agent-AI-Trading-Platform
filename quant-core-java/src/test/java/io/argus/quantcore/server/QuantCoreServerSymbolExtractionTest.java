package io.argus.quantcore.server;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regression tests for the 2026-10-10 Java defect hunt fix: path-param symbol extraction must
 * split the RAW (still percent-encoded) path BEFORE decoding. The JDK's built-in HttpServer
 * decodes {@code %2F} before {@code getPath()} returns it, so the old
 * {@code getPath().substring(lastIndexOf('/') + 1)} pattern silently truncated any symbol
 * containing a slash (crypto {@code "BTC/USD"}, sent by the TS bridge as {@code BTC%2FUSD},
 * was read as just {@code "USD"}). Same root cause as the 2026-09-21
 * {@code handleInstitutionalStrategy} fix, which only covered the strategy dispatcher.
 */
class QuantCoreServerSymbolExtractionTest {

    @Test
    void keepsPlainEquitySymbolsUnchanged() {
        assertThat(QuantCoreServer.trailingSymbolFromRawPath("/api/v1/indicators/AAPL")).isEqualTo("AAPL");
        assertThat(QuantCoreServer.trailingSymbolFromRawPath("/api/v1/institutional/volatility/MSFT")).isEqualTo("MSFT");
    }

    @Test
    void keepsEncodedSlashInsideCryptoSymbols() {
        // What the JDK HttpServer hands us as the raw path when the TS bridge calls
        // /api/v1/indicators/BTC%2FUSD - the whole point of splitting before decoding.
        assertThat(QuantCoreServer.trailingSymbolFromRawPath("/api/v1/indicators/BTC%2FUSD")).isEqualTo("BTC/USD");
        assertThat(QuantCoreServer.trailingSymbolFromRawPath("/api/v1/institutional/regime/ETH%2FUSD")).isEqualTo("ETH/USD");
    }

    @Test
    void decodesOtherPercentEncodedCharactersInSymbols() {
        assertThat(QuantCoreServer.trailingSymbolFromRawPath("/api/v1/indicators/BRK%2EB")).isEqualTo("BRK.B");
    }

    @Test
    void quantStrategySplitKeepsSlashedSymbolAsOneSegment() {
        // Mirrors handleCoreStrategyAssessment's split("/", 2) fix: the symbol half of
        // "MOMENTUM_BREAKOUT/BTC/USD" must stay a single "BTC/USD" segment.
        String[] parts = "MOMENTUM_BREAKOUT/BTC/USD".split("/", 2);
        assertThat(parts).hasSize(2);
        assertThat(parts[0]).isEqualTo("MOMENTUM_BREAKOUT");
        assertThat(parts[1]).isEqualTo("BTC/USD");
    }
}
