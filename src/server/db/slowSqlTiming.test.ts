import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { instrumentSlowSql, getRecentSlowSql, sqlSignature } from './slowSqlTiming';

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

  it('classifies a long wide-select statement by its FROM table using the FULL text, not the 400-char truncation', () => {
    const cols = Array.from({ length: 60 }, (_, i) => `"column_number_${i}"`).join(', ');
    const full = `select ${cols} from "trades" where "trades"."symbol" = ? and "trades"."status" = 'FILLED'`;
    expect(full.replace(/\s+/g, ' ').slice(0, 400)).not.toMatch(/from "trades"/); // the truncation hides FROM
    const sig = sqlSignature(full);
    expect(sig.table).toBe('trades');
    expect(sig.signature).toMatch(/^select trades #[0-9a-f]{8}$/);
    // same shape, different literal/params -> same signature; different shape -> different signature
    expect(sqlSignature(full.replace("'FILLED'", "'REJECTED'")).signature).toBe(sig.signature);
    expect(sqlSignature(`select ${cols} from "trades"`).signature).not.toBe(sig.signature);
    expect(sqlSignature('insert into "fills" ("a","b") values (?, ?)').table).toBe('fills');
    expect(sqlSignature('update "trades" set "status" = ? where "id" = ?').table).toBe('trades');
  });
  it('a slow statement carries its signature, table and application caller frames', () => {
    const db = new Database(':memory:');
    instrumentSlowSql(db, 20);
    db.prepare('with recursive c(x) as (select 1 union all select x+1 from c where x < 3000000) select count(*) as n from c').all();
    const rec = getRecentSlowSql().at(-1)!;
    expect(rec.signature).toMatch(/^with /);
    expect(Array.isArray(rec.callerFrames)).toBe(true);
    expect(rec.callerFrames.join('\n')).toMatch(/slowSqlTiming\.test/);
    expect(rec.callerFrames.join('\n')).not.toMatch(/node_modules|slowSqlTiming\.ts/);
  });
});
