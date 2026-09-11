package io.argus.quantcore.server;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Sequence-gap detection and resynchronization (added 2026-09-10 -
 * docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §6, the confirmed fix for the
 * RSI/MACD shadow-parity divergence root cause: a dropped fire-and-forget tick previously left
 * this class's buffer permanently diverged from TS's own price history with no way to detect or
 * recover from it).
 */
class SymbolStateTest {

    @Test
    void firstTickWithASequenceNumberNeverReportsAGap() {
        SymbolState state = new SymbolState();
        boolean gap = state.onTick(100.0, 1000.0, 1L, 0L);
        assertThat(gap).isFalse();
        assertThat(state.lastAppliedSequence()).isEqualTo(0L);
    }

    @Test
    void consecutiveSequenceNumbersNeverReportAGap() {
        SymbolState state = new SymbolState();
        state.onTick(100.0, 1000.0, 1L, 0L);
        boolean gap1 = state.onTick(101.0, 1000.0, 2L, 1L);
        boolean gap2 = state.onTick(102.0, 1000.0, 3L, 2L);

        assertThat(gap1).isFalse();
        assertThat(gap2).isFalse();
        assertThat(state.lastAppliedSequence()).isEqualTo(2L);
    }

    @Test
    void aSkippedSequenceNumberIsReportedAsAGap() {
        SymbolState state = new SymbolState();
        state.onTick(100.0, 1000.0, 1L, 0L);
        boolean gap = state.onTick(102.0, 1000.0, 3L, 5L); // expected 1, got 5

        assertThat(gap).isTrue();
        // The tick is still applied - a gap is flagged, never silently dropped.
        assertThat(state.lastAppliedSequence()).isEqualTo(5L);
    }

    @Test
    void aReorderedOlderSequenceNumberIsReportedAsAGap() {
        SymbolState state = new SymbolState();
        state.onTick(100.0, 1000.0, 1L, 5L);
        boolean gap = state.onTick(101.0, 1000.0, 2L, 3L); // went backwards

        assertThat(gap).isTrue();
    }

    @Test
    void theNoSequenceOverloadNeverReportsOrTracksAGap() {
        SymbolState state = new SymbolState();
        state.onTick(100.0, 1000.0, 1L); // no-sequence overload
        assertThat(state.lastAppliedSequence()).isEqualTo(-1L);
    }

    @Test
    void resyncWhollyReplacesStateAndClearsAnyPriorGap() {
        SymbolState state = new SymbolState();
        state.onTick(999.0, 1.0, 1L, 0L);
        state.onTick(999.0, 1.0, 2L, 5L); // real gap

        double[] canonicalPrices = new double[30];
        double[] canonicalVolumes = new double[30];
        for (int i = 0; i < 30; i++) {
            canonicalPrices[i] = 100.0 + i;
            canonicalVolumes[i] = 1000.0;
        }
        state.resync(canonicalPrices, canonicalVolumes, 100L, 12345L);

        assertThat(state.lastAppliedSequence()).isEqualTo(100L);
        // The very next tick, continuing the resync'd sequence, must NOT report a gap.
        boolean gapAfterResync = state.onTick(130.0, 1000.0, 12346L, 101L);
        assertThat(gapAfterResync).isFalse();
    }

    @Test
    void resyncMakesIndicatorsComputableImmediatelyGivenEnoughHistory() {
        SymbolState state = new SymbolState();
        double[] prices = new double[30];
        for (int i = 0; i < 30; i++) {
            prices[i] = 100.0 + i * 0.5;
        }
        state.resync(prices, new double[0], 0L, 1L);

        IndicatorSnapshot snapshot = state.snapshot("TEST");
        assertThat(snapshot.insufficientHistory()).isFalse();
        assertThat(snapshot.rsi()).isNotNull();
    }
}
