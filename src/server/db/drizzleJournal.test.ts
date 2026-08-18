import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('drizzle journal consistency (DEF-17)', () => {
  const drizzleDir = path.join(process.cwd(), 'drizzle');
  const journalPath = path.join(drizzleDir, 'meta', '_journal.json');

  it('journal lists 0035_strategy_engine_tables and every tag has a SQL file', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tags = journal.entries.map(e => e.tag);
    expect(tags).toContain('0035_strategy_engine_tables');
    expect(fs.existsSync(path.join(drizzleDir, '0035_strategy_engine_tables.sql'))).toBe(true);
    for (const entry of journal.entries) {
      const sqlPath = path.join(drizzleDir, `${entry.tag}.sql`);
      expect(fs.existsSync(sqlPath)).toBe(true);
    }
    const idxs = journal.entries.map(e => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });
});
