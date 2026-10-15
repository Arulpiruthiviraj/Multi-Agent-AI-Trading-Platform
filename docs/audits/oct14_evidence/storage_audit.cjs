// READ-ONLY storage audit of the Oct 14 post-close snapshot (never the live DB). Pass 1: dbstat per b-tree. Pass 2: row counts + avg payload for the largest tables.
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const SNAP = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/argus_oct14_postclose_1792008436014.db';
const OUT = 'C:/Users/ithay/AppData/Local/Temp/J/storage_audit.json';
const db = new D(SNAP, { readonly: true, fileMustExist: true });
const t0 = Date.now();
const res = { snapshot: 'argus_oct14_postclose (SHA-256 verified)', pageSize: db.pragma('page_size', { simple: true }), pageCount: db.pragma('page_count', { simple: true }), freelistCount: db.pragma('freelist_count', { simple: true }) };
res.totalBytes = res.pageSize * res.pageCount; res.freeBytes = res.pageSize * res.freelistCount;
const owner = new Map(); const kind = new Map();
for (const r of db.prepare("select name, type, tbl_name from sqlite_master").all()) { owner.set(r.name, r.tbl_name); kind.set(r.name, r.type); }
const rows = db.prepare("select name, count(*) pages, sum(pgsize) bytes, sum(unused) unused, sum(payload) payload, sum(ncell) cells from dbstat where aggregate=TRUE group by name").all();
res.dbstatSeconds = (Date.now() - t0) / 1000;
const byTable = new Map();
for (const r of rows) {
  const t = owner.get(r.name) ?? r.name; const k = kind.get(r.name) ?? 'other';
  const e = byTable.get(t) ?? { table: t, tableBytes: 0, indexBytes: 0, indexes: [], unused: 0, cells: 0 };
  if (k === 'index') { e.indexBytes += r.bytes; e.indexes.push({ name: r.name, mb: +(r.bytes / 1e6).toFixed(1) }); } else { e.tableBytes += r.bytes; e.cells += r.cells; }
  e.unused += r.unused; byTable.set(t, e);
}
const tables = [...byTable.values()].map((e) => ({ ...e, totalBytes: e.tableBytes + e.indexBytes })).sort((a, b) => b.totalBytes - a.totalBytes);
res.top = tables.slice(0, 30).map((e) => ({ table: e.table, totalGB: +(e.totalBytes / 1e9).toFixed(3), tableGB: +(e.tableBytes / 1e9).toFixed(3), indexGB: +(e.indexBytes / 1e9).toFixed(3), pctOfDb: +(100 * e.totalBytes / res.totalBytes).toFixed(1), unusedMB: +(e.unused / 1e6).toFixed(1), topIndexes: e.indexes.sort((a, b) => b.mb - a.mb).slice(0, 4) }));
res.allTables = tables.map((e) => ({ table: e.table, totalMB: +(e.totalBytes / 1e6).toFixed(1) }));
res.sumTablesGB = +(tables.reduce((a, e) => a + e.totalBytes, 0) / 1e9).toFixed(2);
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
// pass 2 (exact counts for the biggest tables)
for (const e of res.top.slice(0, 14)) {
  const t1 = Date.now();
  try { e.rows = db.prepare(`select count(*) c from "${e.table}"`).get().c; e.avgBytesPerRow = e.rows ? Math.round(e.totalGB * 1e9 / e.rows) : null; } catch (err) { e.rows = 'ERR ' + err.message; }
  e.countSeconds = (Date.now() - t1) / 1000;
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
}
res.doneAt = new Date().toISOString(); res.totalSeconds = (Date.now() - t0) / 1000;
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log('DONE', res.totalSeconds);
