// READ-ONLY field-level payload audit of quant_assessments and decision_provenance (Oct 14 snapshot only; never the live DB).
// Sampling by rowid stride (no GROUP BY / sort, so no SQLite temp spill). Measures per top-level JSON key: avg bytes, zlib-compressed bytes,
// cross-row duplicate rate (same canonical value seen in another sampled row), and cross-column duplication inside one row.
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const SNAP = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/argus_oct14_postclose_1792008436014.db';
const OUT = process.argv[2] || 'C:/WorkProjects/argus-audit-oct14/docs/audits/oct14_evidence/json_payload_audit.json';
const N = Number(process.env.SAMPLE || 1500);
const db = new D(SNAP, { readonly: true, fileMustExist: true });
const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const res = { snapshot: 'argus_oct14_postclose', sample: N, tables: {} };

function audit(table) {
  const cols = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
  const total = db.prepare(`select count(*) c from ${table}`).get().c;
  const stride = Math.max(1, Math.floor(total / N));
  const rows = db.prepare(`select * from ${table} where rowid % ? = 0 limit ?`).all(stride, N);
  const stat = {}; // key -> {bytes, z, n, seen:Map(hash->count), dupRows}
  let rowBytes = 0, rowZ = 0;
  const colHashes = new Map(); // hash -> set of "col.key" (cross-column dup)
  const add = (k, str) => {
    const s = stat[k] ||= { bytes: 0, z: 0, n: 0, seen: new Map(), dup: 0 };
    s.bytes += Buffer.byteLength(str); s.z += zlib.deflateSync(str).length; s.n++;
    const hh = h(str); if (s.seen.has(hh)) s.dup++; s.seen.set(hh, 1);
    if (str.length > 200) { const set = colHashes.get(hh) || new Set(); set.add(k); colHashes.set(hh, set); }
  };
  for (const r of rows) {
    let b = 0;
    for (const c of cols) {
      const v = r[c]; if (v == null) continue;
      const str = typeof v === 'string' ? v : String(v);
      b += Buffer.byteLength(str);
      let parsed = null;
      if (typeof v === 'string' && str.length > 200 && (str[0] === '{' || str[0] === '[')) { try { parsed = JSON.parse(str); } catch { /* not json */ } }
      add(c, str);
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
        for (const [k, sub] of Object.entries(parsed)) add(`${c}.${k}`, JSON.stringify(sub));
      }
    }
    rowBytes += b; rowZ += zlib.deflateSync(JSON.stringify(r)).length;
  }
  const out = Object.entries(stat).map(([k, s]) => ({
    key: k, avgBytes: Math.round(s.bytes / s.n), avgZlib: Math.round(s.z / s.n), zlibRatio: +(s.z / s.bytes).toFixed(3), nPresent: s.n,
    sampleDupRate: +(s.dup / s.n).toFixed(3),
  })).filter((x) => x.avgBytes >= 150).sort((a, b) => b.avgBytes - a.avgBytes).slice(0, 40);
  const crossCol = [...colHashes.values()].filter((s) => s.size > 1).map((s) => [...s].join(' == ')).reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  res.tables[table] = { totalRows: total, sampledRows: rows.length, avgRowBytes: Math.round(rowBytes / rows.length), avgRowZlib: Math.round(rowZ / rows.length), topKeys: out, crossColumnDuplicates: crossCol };
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
}
for (const t of ['quant_assessments', 'decision_provenance']) { audit(t); console.log('done', t); }
