import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { deleteExpiredByRowidWindows, resetRetentionCursorsForTests } from './retentionBatch';
import { beforeEach } from 'vitest';
beforeEach(() => resetRetentionCursorsForTests());

function seed(n: number, expiredCount: number) {
  const db = new Database(':memory:');
  db.exec('create table t (id text primary key, created_at text not null, payload text)');
  const ins = db.prepare('insert into t values (?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run('id' + i, i < expiredCount ? '2026-01-01T00:00:00.000Z' : '2026-10-12T00:00:00.000Z', 'x');
  })();
  return db;
}
const CUT = '2026-09-01T00:00:00.000Z';

describe('deleteExpiredByRowidWindows', () => {
  it('deletes exactly the expired prefix across multiple windows and keeps fresh rows', () => {
    const db = seed(1000, 700);
    let total = 0;
    for (let i = 0; i < 40; i++) { const r = deleteExpiredByRowidWindows(db, 't', 'created_at', CUT, 100, 1); total += r.deleted; if (!r.lastWindowHadExpired && i > 8) break; }
    expect(total).toBe(700);
    expect((db.prepare('select count(*) c from t').get() as any).c).toBe(300);
    expect((db.prepare("select count(*) c from t where created_at < ?").get(CUT) as any).c).toBe(0);
  });
  it('is equivalent to the old IN-subselect delete on chronological data', () => {
    const a = seed(500, 321), b = seed(500, 321);
    a.prepare('delete from t where id in (select id from t where created_at < ? limit ?)').run(CUT, 10000);
    let t = 0; for (let i = 0; i < 40; i++) { const r = deleteExpiredByRowidWindows(b, 't', 'created_at', CUT, 50, 1); t += r.deleted; }
    expect(t).toBe(321);
    expect(b.prepare('select id from t order by rowid').all()).toEqual(a.prepare('select id from t order by rowid').all());
  });
  it('stops at the frontier and does nothing when nothing is expired', () => {
    const db = seed(300, 0);
    expect(deleteExpiredByRowidWindows(db, 't', 'created_at', CUT, 100, 5).deleted).toBe(0);
    resetRetentionCursorsForTests();
    expect((db.prepare('select count(*) c from t').get() as any).c).toBe(300);
  });
  it('per-statement work is bounded by the window, not the table (old pattern scans everything)', () => {
    const db = seed(200000, 150000);
    const t0 = performance.now();
    deleteExpiredByRowidWindows(db, 't', 'created_at', CUT, 1000, 1);
    const windowMs = performance.now() - t0;
    expect(windowMs).toBeLessThan(150); // one 1000-row window on a 200k-row table
  });
});
