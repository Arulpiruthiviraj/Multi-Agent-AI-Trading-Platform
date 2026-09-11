import Database from 'better-sqlite3';
const db = new Database('data/argus.db', { readonly: true });
try {
  const rows = db.prepare(`
    SELECT name, SUM(pgsize) as bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 20
  `).all() as { name: string; bytes: number }[];
  const total = db.prepare(`SELECT SUM(pgsize) as bytes FROM dbstat`).get() as { bytes: number };
  console.log('Total DB bytes (dbstat sum):', total.bytes, `(${(total.bytes / 1e9).toFixed(2)} GB)`);
  for (const r of rows) {
    console.log(`${(r.bytes / 1e6).toFixed(1).padStart(10)} MB   ${r.name}`);
  }
} catch (e: any) {
  console.log('dbstat unavailable:', e.message);
}
db.close();
