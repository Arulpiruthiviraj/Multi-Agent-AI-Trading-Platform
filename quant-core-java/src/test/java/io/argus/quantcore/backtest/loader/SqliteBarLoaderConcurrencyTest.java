package io.argus.quantcore.backtest.loader;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real concurrency verification on a disposable temp DB (never data/argus.db - that file's sole
 * writer is Node.js, per CLAUDE.md, and this test intentionally does not touch it). Proves
 * SqliteBarLoader's busy_timeout(5000) lets a real concurrent writer and this read-only loader
 * coexist on the SAME file without a SQLITE_BUSY exception, which is the actual, safe mechanism
 * this migration uses in place of making Java a second writer against the live database.
 */
class SqliteBarLoaderConcurrencyTest {

    private File tmpDb;

    @BeforeEach
    void createTempDb() throws Exception {
        tmpDb = File.createTempFile("quantcore_concurrency_", ".db");
        tmpDb.deleteOnExit();
        try (Connection setup = DriverManager.getConnection("jdbc:sqlite:" + tmpDb.getAbsolutePath());
             Statement st = setup.createStatement()) {
            st.execute("PRAGMA journal_mode=WAL");
            st.execute("CREATE TABLE ohlcv_bars (id TEXT PRIMARY KEY, symbol TEXT, timeframe TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL, source TEXT)");
            for (int i = 0; i < 30; i++) {
                st.execute("INSERT INTO ohlcv_bars VALUES ('seed-" + i + "','SEEDSYM','1Day'," + i + ",1,1,1,1,1,'test')");
            }
        }
    }

    @AfterEach
    void cleanup() {
        tmpDb.delete();
        new File(tmpDb.getAbsolutePath() + "-wal").delete();
        new File(tmpDb.getAbsolutePath() + "-shm").delete();
    }

    @Test
    void readerSurvivesAConcurrentRealWriterWithoutSqliteBusyErrors() throws Exception {
        int writerIterations = 200;
        int readerIterations = 200;
        CountDownLatch start = new CountDownLatch(1);
        AtomicReference<Exception> writerError = new AtomicReference<>();
        AtomicReference<Exception> readerError = new AtomicReference<>();
        AtomicInteger readsCompleted = new AtomicInteger();

        Thread writer = new Thread(() -> {
            try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + tmpDb.getAbsolutePath())) {
                start.await();
                for (int i = 0; i < writerIterations; i++) {
                    try (Statement st = conn.createStatement()) {
                        st.execute("INSERT INTO ohlcv_bars VALUES ('w-" + i + "','WRITESYM','1Day'," + (1000 + i) + ",1,1,1,1,1,'test')");
                    }
                }
            } catch (Exception e) {
                writerError.set(e);
            }
        });

        Thread reader = new Thread(() -> {
            try (SqliteBarLoader loader = new SqliteBarLoader(tmpDb.getAbsolutePath())) {
                start.await();
                for (int i = 0; i < readerIterations; i++) {
                    loader.loadBars("SEEDSYM", "1Day", 0L, 1_000_000L);
                    readsCompleted.incrementAndGet();
                }
            } catch (Exception e) {
                readerError.set(e);
            }
        });

        writer.start();
        reader.start();
        start.countDown();
        writer.join(30_000);
        reader.join(30_000);

        assertThat(writerError.get()).as("writer thread error").isNull();
        assertThat(readerError.get()).as("reader thread error (should never see SQLITE_BUSY thanks to busy_timeout)").isNull();
        assertThat(readsCompleted.get()).isEqualTo(readerIterations);
    }
}
