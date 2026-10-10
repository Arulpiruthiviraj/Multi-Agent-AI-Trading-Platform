import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createCertificationSnapshot } from './certificationSnapshot';

const owned: string[] = [];
afterEach(() => { for (const folder of owned.splice(0)) {
  if (dirname(folder) !== resolve(tmpdir()) || !basename(folder).startsWith('argus-cert-snapshot-test-')) throw new Error('Unsafe cleanup');
  rmSync(folder, { recursive: true, force: true });
} });
function paths() { const folder = mkdtempSync(join(tmpdir(), 'argus-cert-snapshot-test-')); owned.push(folder); return { source: join(folder, 'source.db'), target: join(folder, 'target.db') }; }

it('backs up a pinned WAL snapshot while concurrent commits continue, leaving source unchanged', async () => {
  const p = paths(); const writer = new Database(p.source);
  writer.pragma('journal_mode=WAL');
  writer.exec('CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO evidence VALUES (1,\'before\')');
  try {
    const copying = createCertificationSnapshot(p.source, p.target);
    writer.prepare('INSERT INTO evidence VALUES (?,?)').run(2, 'after');
    await copying;
    const snapshot = new Database(p.target, { readonly: true });
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.prepare('SELECT * FROM evidence').all()).toEqual([{ id: 1, value: 'before' }]);
      expect(writer.prepare('SELECT count(*) n FROM evidence').get()).toEqual({ n: 2 });
    } finally { snapshot.close(); }
  } finally { writer.close(); }
});
it('fails closed for missing sources and cannot replace existing destinations or the source', async () => {
  const p = paths();
  await expect(createCertificationSnapshot(p.source, p.target)).rejects.toThrow();
  expect(existsSync(p.source)).toBe(false); expect(existsSync(p.target)).toBe(false);
  const writer = new Database(p.source); writer.exec('CREATE TABLE preserved (id INTEGER)'); writer.close();
  await expect(createCertificationSnapshot(p.source, p.source)).rejects.toThrow('DESTINATION');
  await createCertificationSnapshot(p.source, p.target);
  await expect(createCertificationSnapshot(p.source, p.target)).rejects.toThrow('DESTINATION');
});
