import { afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resetPendingCapitalReservationsForTests } from './src/server/engines/PendingCapitalReservations';

/**
 * Real bug this closes: BrokerAdapter.test.ts (and, as of this same investigation,
 * MarketDataCrossChecker.test.ts) statically import modules that transitively import
 * src/server/db/index.ts, which opens and migrates a real SQLite file at module-load time -
 * with no ARGUS_DB_PATH override set anywhere in either file, that file was the actual live
 * data/argus.db, not an isolated one. Multiple test workers hitting the same live file
 * concurrently is exactly the competing-connection risk CLAUDE.md already documents (a false
 * SQLITE_CORRUPT report from one connection while the app's own stays healthy) - here it more
 * likely manifested as the intermittent whole-suite failures observed when re-running the suite
 * after adding a second real-DB-touching test file.
 *
 * This gives every test file a fresh, unique, isolated temp DB by default, before that file's own
 * imports resolve - so a file that forgets to isolate can no longer reach the real database at
 * all. Test files that need finer control (seeding specific data, inspecting the file directly)
 * still set their own ARGUS_DB_PATH in their own beforeAll before dynamically importing '../db' -
 * that assignment runs after this file's, and simply overrides it before their own import reads it.
 */
const defaultDbPath = path.join(
  os.tmpdir(),
  `argus_test_default_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.ARGUS_DB_PATH = defaultDbPath;

// Isolate research warehouse so Vitest never reads developer data/research baselines
// (parquet / runs / strategyEvidence) as if they were unit-test fixtures.
const defaultResearchDir = path.join(
  os.tmpdir(),
  `argus_research_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`
);
fs.mkdirSync(defaultResearchDir, { recursive: true });
process.env.ARGUS_RESEARCH_DIR = defaultResearchDir;

// Isolate optional MCP/Chronos probes from the developer's .env. dotenv.config() does not
// override keys that are already set, so this must be assigned (not deleted) before any
// EncryptionService import. OpenAlice health against a half-open Guardian caused ECONNRESET
// in v2System.quantObservability.test.ts (~20s = two 10s MCP timeouts). Tests that need a
// live Guardian set ARGUS_TEST_ALLOW_OPENALICE=true before importing the service.
if (process.env.ARGUS_TEST_ALLOW_OPENALICE !== 'true') {
  process.env.OPENALICE_ENABLED = 'false';
}

// Do not share the developer's Chronos/Ollama sockets across Vitest workers. A live
// local_ai_service.py on :8008 produced read ECONNRESET on unrelated supertest requests
// (GET /api/v2/quant/strategies) when the full suite ran in parallel. Isolated file runs passed.
if (process.env.ARGUS_TEST_ALLOW_CHRONOS !== 'true') {
  process.env.LOCAL_AI_SERVICE_URL = 'http://127.0.0.1:9';
}
if (process.env.ARGUS_TEST_ALLOW_OLLAMA !== 'true') {
  process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
}

// Real gap found 2026-09-07 (post-audit remediation full-suite run): with this deployment's real
// .env genuinely carrying EXTENDED_HOURS_EXECUTION_ENABLED=true (CLAUDE.md's Phase 5 note) and the
// suite run during real pre-market wall-clock hours, RiskEngine gate 25 correctly (by design)
// rejected every order in 4 unrelated integration/RiskEngine test files as
// EXTENDED_HOURS_BROKER_UNSUPPORTED (InternalPaperBroker has no extended-hours order construction)
// - not a RiskEngine bug, a test-hermeticity gap: those tests never intended to exercise the
// extended-hours path and don't control for real wall-clock time either. RiskEngine.test.ts /
// OrderManagement.test.ts already `delete` this themselves before each test that needs the plain
// path and explicitly set it back to 'true' within the specific tests that want extended-hours
// behavior - same opt-in idiom as ARGUS_TEST_ALLOW_CHRONOS/OLLAMA/OPENALICE above, just applied
// suite-wide so a future new test file cannot silently reacquire this same leakage. Assigned (not
// deleted) - same reason as OPENALICE_ENABLED above: dotenv.config() (transitively triggered by
// EncryptionService.ts et al. at module-load time, later than this file) does not override a key
// that is already set, but happily repopulates one that was merely deleted.
if (process.env.ARGUS_TEST_ALLOW_EXTENDED_HOURS !== 'true') {
  process.env.EXTENDED_HOURS_EXECUTION_ENABLED = 'false';
}

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(defaultDbPath + suffix); } catch { /* best-effort cleanup - may never have been created */ }
  }
});

// Real bug found this pass: RiskEngine.test.ts (and other files that call riskEngine.evaluateRisk()
// directly, bypassing the real OMS release call) accumulate stale in-memory capital reservations
// across tests within the same file - PendingCapitalReservations' module state only naturally
// clears once OrderManagement.ts's executeOrder() releases it, which these unit tests never invoke.
// One global reset here (not six individual test-file edits) keeps every test's capital-gate
// assertions independent of what earlier tests in the same file approved.
afterEach(() => {
  resetPendingCapitalReservationsForTests();
});
