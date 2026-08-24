package io.argus.quantcore.logging;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TraceContextTest {

    @Test
    void bindsAndClearsTraceIdAndSymbol() {
        assertThat(TraceContext.currentTraceId()).isNull();
        assertThat(TraceContext.currentSymbol()).isNull();

        TraceContext.bind("tr-1", "AAPL");
        assertThat(TraceContext.currentTraceId()).isEqualTo("tr-1");
        assertThat(TraceContext.currentSymbol()).isEqualTo("AAPL");

        TraceContext.clear();
        assertThat(TraceContext.currentTraceId()).isNull();
        assertThat(TraceContext.currentSymbol()).isNull();
    }

    @Test
    void nullArgumentsDoNotOverwriteAnAlreadyBoundValue() {
        TraceContext.bind("tr-2", "MSFT");
        TraceContext.bind(null, null);
        assertThat(TraceContext.currentTraceId()).isEqualTo("tr-2");
        assertThat(TraceContext.currentSymbol()).isEqualTo("MSFT");
        TraceContext.clear();
    }
}
