package io.argus.quantcore.backtest.cli;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class BacktestCliTest {

    @Test
    void parsesFlagsIntoAMap() {
        Map<String, String> flags = BacktestCli.parseFlags(new String[]{
            "--start", "2025-01-01", "--end", "2026-08-21", "--symbols", "SPY,QQQ,NVDA", "--threads", "16", "--target", "100",
        });
        assertThat(flags).containsEntry("start", "2025-01-01");
        assertThat(flags).containsEntry("symbols", "SPY,QQQ,NVDA");
        assertThat(flags).containsEntry("target", "100");
    }

    @Test
    void ignoresATrailingFlagWithNoValue() {
        Map<String, String> flags = BacktestCli.parseFlags(new String[]{"--start", "2025-01-01", "--dangling"});
        assertThat(flags).containsEntry("start", "2025-01-01");
        assertThat(flags).doesNotContainKey("dangling");
    }
}
