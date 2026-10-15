// READ-ONLY validation of the storage-redesign estimates on the Oct 14 snapshot (argv[2] = snapshot path, argv[3] = output json).
// Three sampling designs per table (random rowids, adjacent time window, stratified by symbol), zlib vs zstd, byte-weighted compression with a
// bootstrap 95% interval, true same-window dedup of the market-wide context, and the provenance bar-reference coverage against ohlcv_bars.
const D = require('better-sqlite3');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const SNAP = process.argv[2];
const OUT = process.argv[3];
const N = Number(process.env.SAMPLE || 800);
const db = new D(SNAP, { readonly: true, fileMustExist: true });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const zst = (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
const res = { snapshot: SNAP.split(/[\\/]/).pop(), sampleSize: N, node: process.version };
const rnd = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const rand = rnd(12345);

function pickRandomRowids(table, n) {
  const mx = db.prepare(`select max(rowid) m from ${table}`).get().m; const out = new Set();
  while (out.size < n) out.add(1 + Math.floor(rand() * mx));
  return [...out];
}
const getByRowids = (table, ids) => { const st = db.prepare(`select * from ${table} where rowid=?`); return ids.map((i) => st.get(i)).filter(Boolean); };
function sizes(rows) {
  const per = rows.map((r) => { const s = JSON.stringify(r); const b = Buffer.from(s); return { raw: b.length, z: zlib.deflateSync(b).length, zs: zst(b).length }; });
  return per;
}
function bootstrapRatio(per, key, B = 400) { // byte-weighted compressed fraction with 95% interval
  const n = per.length; const vals = [];
  for (let b = 0; b < B; b++) { let raw = 0, c = 0; for (let i = 0; i < n; i++) { const p = per[Math.floor(rand() * n)]; raw += p.raw; c += p[key]; } vals.push(c / raw); }
  vals.sort((a, c) => a - c);
  let raw = 0, c = 0; for (const p of per) { raw += p.raw; c += p[key]; }
  return { ratio: +(c / raw).toFixed(4), ci95: [+vals[Math.floor(B * 0.025)].toFixed(4), +vals[Math.floor(B * 0.975)].toFixed(4)], avgRaw: Math.round(raw / n) };
}
function summarize(rows) { const per = sizes(rows); return { n: rows.length, zlib: bootstrapRatio(per, 'z'), zstd3: bootstrapRatio(per, 'zs') }; }

for (const table of ['quant_assessments', 'decision_provenance']) {
  const t = {}; const dateCol = table === 'quant_assessments' ? 'created_at' : 'created_at';
  t.random = summarize(getByRowids(table, pickRandomRowids(table, N)));
  const mx = db.prepare(`select max(rowid) m from ${table}`).get().m;
  t.adjacentWindow = summarize(db.prepare(`select * from ${table} where rowid between ? and ? limit ?`).all(Math.floor(mx * 0.6), mx, N));
  // stratified: first N/8 rows for each of the 8 most frequent symbols (index scan over a rowid window, not a full GROUP BY)
  const syms = db.prepare(`select symbol, count(*) c from (select symbol from ${table} where rowid between ? and ?) group by symbol order by c desc limit 8`).all(Math.floor(mx * 0.5), Math.floor(mx * 0.5) + 30000).map((r) => r.symbol);
  const strat = []; for (const s of syms) strat.push(...db.prepare(`select * from ${table} where symbol=? and rowid > ? limit ?`).all(s, Math.floor(mx * 0.4), Math.floor(N / 8)));
  t.stratifiedBySymbol = { symbols: syms, ...summarize(strat) };
  res[table] = t; fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log('sized', table);
}

// ---- true same-window dedup of the market-wide context (adjacent window of consecutive assessments)
{
  const mx = db.prepare('select max(rowid) m from quant_assessments').get().m;
  const rows = db.prepare('select created_at, market_context, regime from quant_assessments where rowid between ? and ? limit 6000').all(Math.floor(mx * 0.7), mx);
  let raw = 0; const uniq = new Map(); const uniqSub = { spy: new Set(), qqq: new Set(), iwm: new Set(), sector: new Set(), breadth: new Set() }; let subRaw = 0;
  for (const r of rows) {
    raw += Buffer.byteLength(r.market_context); const h = sha(r.market_context); uniq.set(h, (uniq.get(h) || 0) + 1);
    try { const m = JSON.parse(r.market_context); for (const k of Object.keys(uniqSub)) if (m[k] !== undefined) { const s = JSON.stringify(m[k]); uniqSub[k].add(sha(s)); subRaw += s.length; } } catch { /* ignore */ }
  }
  res.marketContextDedupAdjacentWindow = {
    rows: rows.length, distinctWholeObjects: uniq.size, wholeObjectDupRate: +(1 - uniq.size / rows.length).toFixed(3),
    distinctSubObjects: Object.fromEntries(Object.entries(uniqSub).map(([k, v]) => [k, v.size])),
    note: 'sub-object distinct counts over the window vs rows: low counts = the same SPY/QQQ/IWM/sector/breadth snapshot is stored once per distinct minute, not per symbol',
  };
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log('dedup done');
}

// ---- provenance bar evidence: reference-only? coverage in ohlcv_bars? compact encoding size?
{
  const ids = pickRandomRowids('decision_provenance', 300);
  const rows = getByRowids('decision_provenance', ids);
  const hasBar = db.prepare('select 1 from ohlcv_bars where id=?');
  const barRow = db.prepare('select source, provisional from ohlcv_bars where id=?');
  let refs = 0, found = 0, provisional = 0, availLagMs = [], rawBytes = 0, compactBytes = 0, compactZst = 0, withValues = 0; const srcs = {}; const byTf = {};
  for (const r of rows) {
    let arr; try { arr = JSON.parse(r.bar_evidence_json); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    rawBytes += Buffer.byteLength(r.bar_evidence_json);
    if (arr.some((b) => 'open' in b || 'close' in b)) withValues++;
    // compact form: symbol/timeframe once, base timestamp, then (ts delta, availability delta) pairs
    const base = arr.length ? arr[0].barTimestamp : 0;
    const compact = JSON.stringify({ s: r.symbol, tf: r.timeframe, b: base, d: arr.map((b) => [b.barTimestamp - base, b.availableAtMs - b.barTimestamp]) });
    compactBytes += compact.length; compactZst += zst(Buffer.from(compact)).length;
    for (const b of arr.slice(-5)) { // check the 5 most recent refs per row against ohlcv_bars (cost bound)
      refs++; const f = barRow.get(b.barId); if (f) { found++; srcs[f.source] = (srcs[f.source] || 0) + 1; if (f.provisional) provisional++; } availLagMs.push(b.availableAtMs - b.barTimestamp);
    }
    byTf[r.timeframe] = (byTf[r.timeframe] || 0) + 1;
  }
  availLagMs.sort((a, b) => a - b);
  res.provenanceBarEvidence = {
    rowsChecked: rows.length, rowsWithOHLCVValuesInline: withValues, byTimeframe: byTf, rawAvgBytes: Math.round(rawBytes / rows.length), compactJsonAvgBytes: Math.round(compactBytes / rows.length), compactZstdAvgBytes: Math.round(compactZst / rows.length),
    recentRefsChecked: refs, foundInOhlcvBars: found, foundFraction: +(found / Math.max(1, refs)).toFixed(3), foundSources: srcs, foundButProvisional: provisional,
    availabilityLagMsP50: availLagMs[Math.floor(availLagMs.length / 2)], availabilityLagMsP95: availLagMs[Math.floor(availLagMs.length * 0.95)],
  };
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log('bars done');
}
