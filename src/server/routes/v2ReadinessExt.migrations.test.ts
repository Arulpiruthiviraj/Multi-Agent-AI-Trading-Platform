import { describe, it, expect } from 'vitest';
import { pendingJournalMigrations } from './v2ReadinessExt';

// drizzle applies the journal entries whose `when` is newer than the latest applied row's
// created_at. The production DB has had one fewer applied ROW than journal ENTRIES with nothing
// pending, which a row-count comparison reported as "migrations behind" on every run.
describe('pendingJournalMigrations (mirrors drizzle: newer than latest applied, not row counts)', () => {
  const journal = [
    { tag: '0000_a', when: 1000 },
    { tag: '0001_b', when: 2000 },
    { tag: '0002_c', when: 3000 },
  ];

  it('reports nothing pending when every entry is at or before the latest applied timestamp, even if there are fewer rows than entries', () => {
    // Two applied rows for three entries (the real production shape): latest applied is 3000.
    expect(pendingJournalMigrations(journal, 3000)).toEqual([]);
  });

  it('reports exactly the entries newer than the latest applied timestamp', () => {
    expect(pendingJournalMigrations(journal, 2000)).toEqual([{ tag: '0002_c', when: 3000 }]);
  });

  it('treats an empty migration table as everything pending (fresh database)', () => {
    expect(pendingJournalMigrations(journal, null)).toHaveLength(3);
  });

  it('does not report an entry whose timestamp equals the latest applied one', () => {
    expect(pendingJournalMigrations(journal, 1000).map((e) => e.tag)).toEqual(['0001_b', '0002_c']);
  });
});
