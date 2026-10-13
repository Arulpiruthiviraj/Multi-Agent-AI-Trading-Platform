import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { instrumentSlowSql, getRecentSlowSql } from './slowSqlTiming';

describe('slowSqlTiming', () => {
  it('records the SQL text of a statement that blocks longer than the threshold, and leaves results untouched', () => {
    const db = new Database(':memory:');
    instrumentSlowSql(db, 20);
    const rows = db.prepare('with recursive c(x) as (select 1 union all select x+1 from c where x < 3000000) select count(*) as n from c').all() as any[];
    expect(rows[0].n).toBe(3000000);
    const rec = getRecentSlowSql().at(-1);
    expect(rec?.method).toBe('all');
    expect(rec?.sql).toContain('with recursive c(x)');
    expect(rec!.durationMs).toBeGreaterThanOrEqual(20);
  });
  it('does not record fast statements and does not double-instrument', () => {
    const db = new Database(':memory:');
    instrumentSlowSql(db, 5000);
    instrumentSlowSql(db, 5000);
    const before = getRecentSlowSql().length;
    db.prepare('select 1 as a').get();
    expect(getRecentSlowSql().length).toBe(before);
  });
});
