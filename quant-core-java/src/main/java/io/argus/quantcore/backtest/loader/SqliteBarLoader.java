package io.argus.quantcore.backtest.loader;

import io.argus.quantcore.backtest.engine.Bar;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads real OHLCV bars from the live schema's {@code ohlcv_bars} table (read-only). Research
 * use only — this loader has no write path and is never called from anything on the live spine.
 *
 * A Parquet loader (also named in the migration blueprint's Phase 4 tasks) is NOT implemented
 * here: this repo has no Parquet warehouse file actually present in this environment to read
 * (CLAUDE.md's own "warehouse parquet presence" language refers to a capability that may exist
 * elsewhere but wasn't found on disk during this pass), and hand-rolling a real Parquet reader
 * (a non-trivial columnar binary format) without a library was out of scope for this pass. The
 * SQLite path below reads real, verified data (47,235 rows across ~9 major symbols, confirmed by
 * direct query 2026-08-21) - this is the loader Phase 4's actual verification ran against.
 */
public final class SqliteBarLoader implements AutoCloseable {

    private final Connection connection;

    public SqliteBarLoader(String sqliteDbPath) throws Exception {
        Class.forName("org.sqlite.JDBC");
        // Resolve to an absolute path - a relative path plus a trailing "?mode=ro" query string is
        // unreliable on Windows through this driver. Read-only is instead set via SQLiteConfig
        // (setReadOnly(true)), which is the driver's own supported mechanism - this loader must
        // never be able to write.
        String absolutePath = java.nio.file.Path.of(sqliteDbPath).toAbsolutePath().normalize().toString();
        org.sqlite.SQLiteConfig config = new org.sqlite.SQLiteConfig();
        config.setReadOnly(true);
        this.connection = DriverManager.getConnection("jdbc:sqlite:" + absolutePath, config.toProperties());
    }

    public List<Bar> loadBars(String symbol, String timeframe, long startMs, long endMs) throws Exception {
        String sql = """
            SELECT timestamp, open, high, low, close, volume
            FROM ohlcv_bars
            WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
            """;
        List<Bar> bars = new ArrayList<>();
        try (PreparedStatement stmt = connection.prepareStatement(sql)) {
            stmt.setString(1, symbol);
            stmt.setString(2, timeframe);
            stmt.setLong(3, startMs);
            stmt.setLong(4, endMs);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    bars.add(new Bar(
                        rs.getLong("timestamp"),
                        rs.getDouble("open"),
                        rs.getDouble("high"),
                        rs.getDouble("low"),
                        rs.getDouble("close"),
                        rs.getDouble("volume")
                    ));
                }
            }
        }
        return bars;
    }

    public List<String> listSymbols(String timeframe, int minBars) throws Exception {
        String sql = """
            SELECT symbol, COUNT(*) as c FROM ohlcv_bars WHERE timeframe = ?
            GROUP BY symbol HAVING c >= ? ORDER BY c DESC
            """;
        List<String> symbols = new ArrayList<>();
        try (PreparedStatement stmt = connection.prepareStatement(sql)) {
            stmt.setString(1, timeframe);
            stmt.setInt(2, minBars);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    symbols.add(rs.getString("symbol"));
                }
            }
        }
        return symbols;
    }

    @Override
    public void close() throws Exception {
        connection.close();
    }
}
