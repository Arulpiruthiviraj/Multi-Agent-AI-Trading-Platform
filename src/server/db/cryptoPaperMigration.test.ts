import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readFileSync } from 'node:fs';

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
  entries: Array<{ tag: string; when: number }>;
};
const previous = journal.entries.find(e => e.tag === '0077_trade_plan_close_confidence')!;
// 2026-10-01: read the real latest journal entry dynamically rather than hardcoding
// '0079_repair_skipped_crypto_paper_tables' as "the" latest migration - that assumption broke the
// moment a 0080+ migration was added. This test only cares that migrating a fresh/legacy DB reaches
// whatever the real newest migration actually is.
const latest = journal.entries[journal.entries.length - 1];
const original = readFileSync('drizzle/0078_skinny_mockingbird.sql', 'utf8');
const tables = ['crypto_paper_broker_state', 'crypto_paper_positions', 'crypto_paper_orders'];

function deployedBeforeCrypto() {
  const sqlite = new Database(':memory:');
  // Reproduce the production migration watermark. No application imports or production DB.
  sqlite.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('fixture-0077', previous.when);
  // Build the actual claimed schema rather than maintaining a hand-written subset that breaks
  // whenever a subsequent migration touches another pre-existing table. Stop by journal order:
  // the deliberately skipped 0078 has an older timestamp, the bug this fixture reproduces.
  for (const entry of journal.entries.slice(0, journal.entries.indexOf(previous) + 1)) {
    sqlite.exec(readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
  }
  return sqlite;
}

describe('crypto paper migration upgrade repair', () => {
  it('repairs an already-upgraded database that skipped 0078 and stays idempotent', () => {
    const sqlite = deployedBeforeCrypto();
    try {
      expect(() => sqlite.prepare('SELECT * FROM crypto_paper_broker_state')).toThrow(/no such table/);
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: 'drizzle' });
      for (const table of tables) expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      const migrations = sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all();
      // Real, dynamic expectation: migrating from the 0077 watermark (a DB that SKIPPED 0078, the
      // exact scenario this test simulates) applies every later real migration EXCEPT 0078 itself
      // (which never gets a __drizzle_migrations row in this scenario - that is the real repair
      // behavior under test) through whatever is actually newest today - hardcoding "exactly one
      // migration after 0077" broke the moment a 0080+ migration was added.
      const previousIndex = journal.entries.findIndex((e) => e.tag === previous.tag);
      expect(migrations).toEqual(
        journal.entries.slice(previousIndex).filter((e) => e.tag !== '0078_skinny_mockingbird').map((e) => ({ created_at: e.when })),
      );
      migrate(db, { migrationsFolder: 'drizzle' });
      expect(sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all()).toEqual(migrations);
    } finally { sqlite.close(); }
  });

  it('preserves existing balances, positions, orders and unique client-order protection', () => {
    const sqlite = deployedBeforeCrypto();
    try {
      sqlite.exec(original);
      sqlite.exec(`INSERT INTO crypto_paper_broker_state VALUES ('singleton', 91234.5, 100000, -2.5, 'fixture');
        INSERT INTO crypto_paper_positions VALUES ('BTC-USD', .1, 40000, 4, 'fixture');
        INSERT INTO crypto_paper_orders (id,client_order_id,symbol,side,type,status,quantity,filled_quantity,created_at,updated_at)
          VALUES ('order-1','client-1','BTC-USD','BUY','LIMIT','PARTIALLY_FILLED',.2,.1,'fixture','fixture');`);
      const before = tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all());
      migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
      expect(tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(() => sqlite.exec(`INSERT INTO crypto_paper_orders (id,client_order_id,symbol,side,type,status,quantity,created_at,updated_at)
        VALUES ('order-2','client-1','BTC-USD','BUY','LIMIT','PENDING',.2,'fixture','fixture')`)).toThrow(/UNIQUE/);
    } finally { sqlite.close(); }
  });

  it('also migrates a fresh database through the real full journal', () => {
    const sqlite = new Database(':memory:');
    try {
      migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
      for (const table of tables) expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      expect(sqlite.prepare('SELECT MAX(created_at) AS latest FROM __drizzle_migrations').get()).toEqual({ latest: latest.when });
    } finally { sqlite.close(); }
  });
});
