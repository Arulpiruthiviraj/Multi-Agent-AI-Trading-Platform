package io.argus.quantcore.backtest.cli;

import io.argus.quantcore.backtest.campaign.CampaignPolicySimulator;
import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.backtest.engine.JavaBacktestEngine;
import io.argus.quantcore.backtest.engine.TradeRecord;
import io.argus.quantcore.backtest.loader.SqliteBarLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * CLI entry point: {@code java -jar quant-core-java-*.jar --start 2022-01-01 --end 2026-08-21
 * --symbols SPY,QQQ,NVDA --threads 16 --target 100 --db ../data/argus.db}
 *
 * Research/CLI only - reads real historical bars read-only (SqliteBarLoader), runs the
 * demonstration RsiThresholdStrategy in parallel across symbols (JavaBacktestEngine), and writes
 * a markdown report. Never touches any live/paper runtime database, never places an order.
 */
public final class BacktestCli {

    private BacktestCli() {
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> flags = parseFlags(args);
        String dbPath = flags.getOrDefault("db", "../data/argus.db");
        String timeframe = flags.getOrDefault("timeframe", "1Day");
        long startMs = parseDate(flags.getOrDefault("start", "2018-01-01"));
        long endMs = parseDate(flags.getOrDefault("end", "2026-12-31")) + 86_400_000L;
        double target = Double.parseDouble(flags.getOrDefault("target", "100"));
        double startingCash = Double.parseDouble(flags.getOrDefault("cash", "100000"));
        double positionSizeFraction = Double.parseDouble(flags.getOrDefault("size", "0.1"));

        List<String> requestedSymbols = flags.containsKey("symbols")
            ? Arrays.asList(flags.get("symbols").split(","))
            : null;

        Map<String, List<Bar>> barsBySymbol = new LinkedHashMap<>();
        try (SqliteBarLoader loader = new SqliteBarLoader(dbPath)) {
            List<String> symbols = requestedSymbols != null ? requestedSymbols : loader.listSymbols(timeframe, 30);
            for (String symbol : symbols) {
                List<Bar> bars = loader.loadBars(symbol.trim().toUpperCase(), timeframe, startMs, endMs);
                if (!bars.isEmpty()) {
                    barsBySymbol.put(symbol.trim().toUpperCase(), bars);
                }
            }
        }

        if (barsBySymbol.isEmpty()) {
            System.out.println("No real historical bars found for the requested symbols/timeframe/date range. Nothing to run.");
            return;
        }

        JavaBacktestEngine engine = new JavaBacktestEngine();
        JavaBacktestEngine.RunResult result = engine.run(barsBySymbol, startingCash, positionSizeFraction);

        List<TradeRecord> allTrades = new ArrayList<>();
        for (var symbolResult : result.bySymbol().values()) {
            allTrades.addAll(symbolResult.trades());
        }
        Map<CampaignPolicySimulator.Policy, CampaignPolicySimulator.PolicyResult> policyResults =
            CampaignPolicySimulator.simulateAll(allTrades, target);

        String report = BacktestReportGenerator.generate(barsBySymbol, result, policyResults, target, timeframe, startMs, endMs);
        String timestamp = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss").format(java.time.LocalDateTime.now());
        Path outPath = Path.of("../docs/audits/JAVA_BACKTEST_REPORT_" + timestamp + ".md");
        writeReport(outPath, report);
        System.out.println("Report written to " + outPath.toAbsolutePath().normalize());
    }

    private static void writeReport(Path path, String content) throws IOException {
        Files.createDirectories(path.getParent());
        Files.writeString(path, content);
    }

    private static long parseDate(String yyyyMmDd) {
        return java.time.LocalDate.parse(yyyyMmDd).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli();
    }

    static Map<String, String> parseFlags(String[] args) {
        Map<String, String> flags = new LinkedHashMap<>();
        for (int i = 0; i < args.length; i++) {
            if (args[i].startsWith("--") && i + 1 < args.length) {
                flags.put(args[i].substring(2), args[i + 1]);
                i++;
            }
        }
        return flags;
    }
}
