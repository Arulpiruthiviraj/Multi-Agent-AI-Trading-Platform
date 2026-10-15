// ISOLATED storage proof of concept. Reads an adjacent window from the Oct 14 snapshot (read-only) and writes THREE fresh temp databases:
//   baseline : the current layout (JSON text columns)
//   A        : versioned compressed envelope per large column (zstd-3, sha256 of the original bytes, original length, format version)
//   B        : A + content-addressed shared evidence (market-wide context, compact bar-reference evidence) stored once in evidence_blobs
// Every row is read back and its original text is verified byte-for-byte (sha256) from each variant. Nothing here touches production.
// usage: node storagePoc.cjs <snapshot.db> <outDir> <outJson>   env: ROWS (default 6000)
const D = require('better-sqlite3');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [SNAP, OUTDIR, OUTJSON] = process.argv.slice(2);
const ROWS = Number(process.env.ROWS || 6000);
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const zst = (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
const unzst = (b) => zlib.zstdDecompressSync(b);
const FMT = 1; // envelope format version
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

// envelope: [fmt u8][algo u8: 1=zstd][rawLen u32][sha256(raw) 32B][payload]
function seal(text) {
  const raw = Buffer.from(text, 'utf8'); const head = Buffer.alloc(6); head[0] = FMT; head[1] = 1; head.writeUInt32LE(raw.length, 2);
  return Buffer.concat([head, sha(raw), zst(raw)]);
}
function open(env) {
  if (env[0] !== FMT) throw new Error('unknown envelope format ' + env[0]);
  const raw = unzst(env.subarray(38)); if (raw.length !== env.readUInt32LE(2)) throw new Error('length mismatch');
  if (!sha(raw).equals(env.subarray(6, 38))) throw new Error('sha mismatch'); return raw.toString('utf8');
}

const src = new D(SNAP, { readonly: true, fileMustExist: true });
const maxQ = src.prepare('select max(rowid) m from quant_assessments').get().m;
const maxP = src.prepare('select max(rowid) m from decision_provenance').get().m;
const QA = src.prepare('select * from quant_assessments where rowid between ? and ? order by rowid limit ?').all(Math.floor(maxQ * 0.7), maxQ, ROWS);
const DP = src.prepare('select * from decision_provenance where rowid between ? and ? order by rowid limit ?').all(Math.floor(maxP * 0.7), maxP, ROWS);
src.close();
const srcBytes = { qa: QA.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r)), 0), dp: DP.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r)), 0) };

function openDb(name) {
  const p = path.join(OUTDIR, name + '.db'); for (const e of ['', '-wal', '-shm']) try { fs.unlinkSync(p + e); } catch { /* none */ }
  const db = new D(p); db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); return { db, p };
}
const QCOLS = ['id', 'symbol', 'timeframe', 'regime', 'market_context', 'strategy_evaluations', 'grouped_scores', 'emitted_trade_idea', 'created_at', 'ai_contradiction_analysis'];
const PCOLS = ['id', 'decision_id', 'symbol', 'timeframe', 'decision_time_ms', 'bar_evidence_json', 'quote_json', 'bid_ask_json', 'current_price', 'price_observed_at_ms', 'strategy_context_json', 'context_truncated', 'regime', 'strategy_versions_json', 'config_version', 'build_sha', 'lifecycle_states_json', 'strategy_id', 'evaluations_json', 'evaluation_fingerprint', 'data_source', 'created_at'];
const BIGQ = ['market_context', 'strategy_evaluations', 'grouped_scores', 'ai_contradiction_analysis'];
const BIGP = ['bar_evidence_json', 'strategy_context_json', 'strategy_versions_json', 'lifecycle_states_json', 'evaluations_json'];
const ddl = (cols, big, blob) => cols.map((c) => `"${c}" ${c === 'emitted_trade_idea' ? '' : blob && big.includes(c) ? 'BLOB' : (/_ms$|^context_truncated$/.test(c) ? 'INTEGER' : (c === 'current_price' ? 'REAL' : 'TEXT'))}`).join(',');

const big = { quant_assessments: BIGQ, decision_provenance: BIGP };
const stats = {};
function measure(name, fn) {
  const { db, p } = fn.open; const wIns = []; const t0 = process.cpuUsage(); let walPeak = 0;
  const run = fn.run; const insertOne = (row, table) => { const a = process.hrtime.bigint(); run(db, row, table); wIns.push(Number(process.hrtime.bigint() - a) / 1e6); try { walPeak = Math.max(walPeak, fs.statSync(p + '-wal').size); } catch { /* none */ } };
  for (const r of QA) insertOne(r, 'quant_assessments');
  for (const r of DP) insertOne(r, 'decision_provenance');
  const cpu = process.cpuUsage(t0); db.pragma('wal_checkpoint(TRUNCATE)');
  const size = fs.statSync(p).size;
  // read back + verify every row's original text
  const rd = []; let bad = 0; let verified = 0;
  for (const [table, rows, cols] of [['quant_assessments', QA, QCOLS], ['decision_provenance', DP, PCOLS]]) {
    for (const r of rows) {
      const a = process.hrtime.bigint(); const got = fn.read(db, table, r.id); rd.push(Number(process.hrtime.bigint() - a) / 1e6);
      for (const c of cols) { const o = r[c]; const g = got[c]; if (String(o ?? '') !== String(g ?? '')) { bad++; break; } }
      verified++;
    }
  }
  const rep = []; for (let i = 0; i < 5; i++) { const a = process.hrtime.bigint(); db.prepare('select regime, count(*) c from quant_assessments group by regime').all(); db.prepare('select strategy_id, count(*) c from decision_provenance group by strategy_id').all(); rep.push(Number(process.hrtime.bigint() - a) / 1e6); }
  const blobTable = db.prepare("select count(*) c from sqlite_master where name='evidence_blobs'").get().c ? db.prepare('select count(*) n, coalesce(sum(length(payload)),0) b, coalesce(sum(refs),0) r from evidence_blobs').get() : null;
  stats[name] = {
    dbBytes: size, bytesPerRow: Math.round(size / (QA.length + DP.length)), walPeakBytes: walPeak,
    insertMs: { p50: +pct(wIns, 0.5).toFixed(3), p95: +pct(wIns, 0.95).toFixed(3), p99: +pct(wIns, 0.99).toFixed(3) },
    readReconstructMs: { p50: +pct(rd, 0.5).toFixed(3), p95: +pct(rd, 0.95).toFixed(3), p99: +pct(rd, 0.99).toFixed(3) },
    cpuUserMsTotalWrite: Math.round(cpu.user / 1000), reportQueryMsMedian: +pct(rep, 0.5).toFixed(2), rowsVerifiedByteExact: verified - bad, rowsMismatched: bad, evidenceBlobStore: blobTable,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
  db.close(); fs.writeFileSync(OUTJSON, JSON.stringify({ rowsQuantAssessments: QA.length, rowsProvenance: DP.length, sourceJsonBytes: srcBytes, zstdLevel: 3, envelopeFormat: FMT, walMode: 'WAL synchronous=NORMAL', stats }, null, 1));
  console.log(name, JSON.stringify(stats[name]));
}

// ---- baseline
{
  const o = openDb('baseline');
  o.db.exec(`create table quant_assessments(${ddl(QCOLS, BIGQ, false)}, primary key(id)); create table decision_provenance(${ddl(PCOLS, BIGP, false)}, primary key(id)); create index qa_sym on quant_assessments(symbol, created_at); create index dp_sym on decision_provenance(symbol, decision_time_ms);`);
  const ins = { quant_assessments: o.db.prepare(`insert into quant_assessments values(${QCOLS.map(() => '?').join(',')})`), decision_provenance: o.db.prepare(`insert into decision_provenance values(${PCOLS.map(() => '?').join(',')})`) };
  measure('baseline', { open: o, run: (db, r, t) => ins[t].run(...(t === 'quant_assessments' ? QCOLS : PCOLS).map((c) => r[c])), read: (db, t, id) => db.prepare(`select * from ${t} where id=?`).get(id) });
}
// ---- A: per-column compressed envelopes
{
  const o = openDb('A_compressed');
  o.db.exec(`create table quant_assessments(${ddl(QCOLS, BIGQ, true)}, primary key(id)); create table decision_provenance(${ddl(PCOLS, BIGP, true)}, primary key(id)); create index qa_sym on quant_assessments(symbol, created_at); create index dp_sym on decision_provenance(symbol, decision_time_ms);`);
  const ins = { quant_assessments: o.db.prepare(`insert into quant_assessments values(${QCOLS.map(() => '?').join(',')})`), decision_provenance: o.db.prepare(`insert into decision_provenance values(${PCOLS.map(() => '?').join(',')})`) };
    measure('A_compressed', {
    open: o,
    run: (db, r, t) => ins[t].run(...(t === 'quant_assessments' ? QCOLS : PCOLS).map((c) => (big[t].includes(c) && typeof r[c] === 'string' ? seal(r[c]) : r[c]))),
    read: (db, t, id) => { const g = db.prepare(`select * from ${t} where id=?`).get(id); for (const c of big[t]) if (Buffer.isBuffer(g[c])) g[c] = open(g[c]); return g; },
  });
}
// ---- B: A + content-addressed shared evidence
{
  const o = openDb('B_shared');
  o.db.exec(`create table evidence_blobs(hash BLOB primary key, payload BLOB not null, refs INTEGER not null default 1) without rowid;
    create table quant_assessments(${ddl(QCOLS, BIGQ, true)}, primary key(id)); create table decision_provenance(${ddl(PCOLS, BIGP, true)}, primary key(id)); create index qa_sym on quant_assessments(symbol, created_at); create index dp_sym on decision_provenance(symbol, decision_time_ms);`);
  const putBlob = o.db.prepare('insert into evidence_blobs(hash,payload) values(?,?) on conflict(hash) do update set refs=refs+1');
  const getBlob = o.db.prepare('select payload from evidence_blobs where hash=?');
  const store = (text) => { const raw = Buffer.from(text, 'utf8'); const h = sha(raw); putBlob.run(h, seal(text)); return h; };
  const fetchBlob = (h) => open(getBlob.get(h).payload);
  // reference marker stored in the big column instead of an envelope: [0xB1][hash32]
  const refOf = (h) => Buffer.concat([Buffer.from([0xb1]), h]);
  const ins = { quant_assessments: o.db.prepare(`insert into quant_assessments values(${QCOLS.map(() => '?').join(',')})`), decision_provenance: o.db.prepare(`insert into decision_provenance values(${PCOLS.map(() => '?').join(',')})`) };
  const compactBars = (row) => { const arr = JSON.parse(row.bar_evidence_json); const base = arr[0].barTimestamp; return JSON.stringify({ s: row.symbol, tf: row.timeframe, b: base, d: arr.map((b) => [b.barTimestamp - base, b.availableAtMs - b.barTimestamp]) }); };
  const barsExact = (row, text) => { // bars can be re-expanded exactly iff barId == symbol:tf:ts for every element and key order is the canonical one
    try { const arr = JSON.parse(row.bar_evidence_json); if (!arr.every((b) => b.barId === `${row.symbol}:${row.timeframe}:${b.barTimestamp}` && Object.keys(b).join() === 'barId,barTimestamp,availableAtMs')) return false; const c = JSON.parse(text); return JSON.stringify(c.d.map(([dt, av]) => ({ barId: `${c.s}:${c.tf}:${c.b + dt}`, barTimestamp: c.b + dt, availableAtMs: c.b + dt + av }))) === row.bar_evidence_json; } catch { return false; }
  };
  const expandBars = (text) => { const c = JSON.parse(text); return JSON.stringify(c.d.map(([dt, av]) => ({ barId: `${c.s}:${c.tf}:${c.b + dt}`, barTimestamp: c.b + dt, availableAtMs: c.b + dt + av }))); };
  let fallbacks = 0;
  measure('B_shared', {
    open: o,
    run: (db, r, t) => {
      const vals = (t === 'quant_assessments' ? QCOLS : PCOLS).map((c) => {
        const v = r[c];
        if (typeof v !== 'string') return v;
        if (t === 'quant_assessments' && c === 'market_context') return refOf(store(v)); // shared per-minute context, stored once
        if (t === 'decision_provenance' && c === 'strategy_context_json') {
          try { const ctx = JSON.parse(v); if (JSON.stringify(ctx) === v && ctx.marketContext !== undefined) { const mc = JSON.stringify(ctx.marketContext); const h = store(mc); ctx.marketContext = { $ref: h.toString('hex') }; const skel = JSON.stringify(ctx); return Buffer.concat([Buffer.from([0xb2]), seal(skel)]); } } catch { /* fall through */ }
          fallbacks++; return seal(v);
        }
        if (t === 'decision_provenance' && c === 'bar_evidence_json') { const comp = compactBars(r); if (barsExact(r, comp)) return Buffer.concat([Buffer.from([0xb3]), seal(comp)]); fallbacks++; return seal(v); }
        if (big[t].includes(c)) return seal(v);
        return v;
      });
      ins[t].run(...vals);
    },
    read: (db, t, id) => {
      const g = db.prepare(`select * from ${t} where id=?`).get(id);
      for (const c of big[t]) {
        const v = g[c]; if (!Buffer.isBuffer(v)) continue;
        if (v[0] === 0xb1) g[c] = fetchBlob(v.subarray(1, 33));
        else if (v[0] === 0xb2) { const sk = JSON.parse(open(v.subarray(1))); sk.marketContext = JSON.parse(fetchBlob(Buffer.from(sk.marketContext.$ref, 'hex'))); g[c] = JSON.stringify(sk); }
        else if (v[0] === 0xb3) g[c] = expandBars(open(v.subarray(1)));
        else g[c] = open(v);
      }
      return g;
    },
  });
  stats.B_shared.fallbackToFullEnvelope = fallbacks; fs.writeFileSync(OUTJSON, JSON.stringify({ rowsQuantAssessments: QA.length, rowsProvenance: DP.length, sourceJsonBytes: srcBytes, zstdLevel: 3, envelopeFormat: FMT, walMode: 'WAL synchronous=NORMAL', stats }, null, 1));
}
