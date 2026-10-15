// READ-ONLY chronological out-of-sample analysis of KronosEngine's graded predictions (2026-10-14 audit follow-up, Level 3 evidence).
// Usage: node kronosCalibrationOos.js <snapshot.db> <out.json>
// Questions answered: (1) BUY vs SELL skew and base rate, (2) first-half vs second-half reliability per confidence bucket,
// (3) does the stored raw-count calibration predict the held-out half better than the effective-sample (clustered) version,
// (4) horizon sensitivity: directional hit rate of the SAME predictions at 1/5/15/60 minutes.
const Database = require('better-sqlite3');
const fs = require('fs');
const [dbPath, outPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const PRIOR = 10;
const bucketOf = (c) => (c < 0.6 ? 0 : c < 0.7 ? 0.6 : c < 0.8 ? 0.7 : c < 0.9 ? 0.8 : 0.9);
const mid = (b) => (b === 0 ? 0.3 : b + 0.05);
const post = (w, l, m) => (w + m * PRIOR) / (w + l + PRIOR);
const rows = db.prepare(`
  select kp.id id, kp.symbol symbol, kp.prediction pred, kp.confidence conf, kp.timestamp ts, kp.forecast_horizon fh, kp.timeframe tf,
         po.outcome outcome, po.actual_return ret, po.actual_direction dir, po.evaluated_at ev
  from prediction_outcomes po join kronos_predictions kp on CAST(kp.id AS TEXT) = po.prediction_id
  where po.source_table = 'kronos_predictions' and po.outcome in ('WIN','LOSS') order by kp.timestamp`).all();
const out = { n: rows.length };
const norm = (c) => (c > 1 ? c / 100 : c);
const decorated = rows.map((r) => ({ ...r, c: norm(r.conf), t: Date.parse(r.ts), win: r.outcome === 'WIN' ? 1 : 0 }));
out.range = { first: decorated[0]?.ts, last: decorated[decorated.length - 1]?.ts };
out.bySide = {};
for (const side of ['BUY', 'SELL', 'HOLD']) {
  const s = decorated.filter((r) => r.pred === side);
  out.bySide[side] = { n: s.length, winRate: s.length ? s.reduce((a, r) => a + r.win, 0) / s.length : null };
}
out.baseRate = { upMoves: decorated.filter((r) => r.dir === 'UP').length / decorated.length, downMoves: decorated.filter((r) => r.dir === 'DOWN').length / decorated.length, flat: decorated.filter((r) => r.dir === 'FLAT').length / decorated.length };
// cluster = same symbol within a 10-minute block (the autocorrelation unit used for "effective" samples here; documented simplification of effectiveSample.ts)
const CLUSTER_MS = 10 * 60_000;
const clusterKey = (r) => `${r.symbol}|${Math.floor(r.t / CLUSTER_MS)}`;
function effective(rs) {
  const m = new Map();
  for (const r of rs) { const k = clusterKey(r); const e = m.get(k) ?? { w: 0, n: 0 }; e.w += r.win; e.n += 1; m.set(k, e); }
  let w = 0; const n = m.size; for (const e of m.values()) w += e.w / e.n; // each cluster contributes its mean outcome as one observation
  return { n, wins: w, losses: n - w };
}
const split = Math.floor(decorated.length * 0.7);
const train = decorated.slice(0, split); const test = decorated.slice(split);
out.split = { trainN: train.length, testN: test.length, trainThrough: train[train.length - 1]?.ts, testFrom: test[0]?.ts };
out.buckets = {};
let brierRaw = 0, brierEff = 0, brierNaive = 0, brierStated = 0, nTest = 0;
for (const b of [0, 0.6, 0.7, 0.8, 0.9]) {
  const tr = train.filter((r) => bucketOf(r.c) === b); const te = test.filter((r) => bucketOf(r.c) === b);
  const rw = tr.reduce((a, r) => a + r.win, 0); const rl = tr.length - rw; const ef = effective(tr);
  const pRaw = post(rw, rl, mid(b)); const pEff = post(ef.wins, ef.losses, mid(b));
  const teWin = te.length ? te.reduce((a, r) => a + r.win, 0) / te.length : null;
  out.buckets[b] = { trainN: tr.length, trainWinRate: tr.length ? rw / tr.length : null, trainEffectiveN: ef.n, calibratedRaw: +pRaw.toFixed(4), calibratedEffective: +pEff.toFixed(4), testN: te.length, testWinRate: teWin, testEffectiveN: effective(te).n };
  for (const r of te) { brierRaw += (pRaw - r.win) ** 2; brierEff += (pEff - r.win) ** 2; brierNaive += (0.5 - r.win) ** 2; brierStated += (Math.min(1, r.c) - r.win) ** 2; nTest++; }
}
out.oosBrier = { n: nTest, calibratedRaw: nTest ? +(brierRaw / nTest).toFixed(5) : null, calibratedEffective: nTest ? +(brierEff / nTest).toFixed(5) : null, coinFlip0_5: nTest ? +(brierNaive / nTest).toFixed(5) : null, statedConfidence: nTest ? +(brierStated / nTest).toFixed(5) : null };
// first half vs second half drift per side
const half = Math.floor(decorated.length / 2);
out.halves = {};
for (const [name, rs] of [['first', decorated.slice(0, half)], ['second', decorated.slice(half)]]) {
  out.halves[name] = { n: rs.length, winRate: rs.reduce((a, r) => a + r.win, 0) / rs.length, effective: effective(rs), buyWin: avg(rs.filter((r) => r.pred === 'BUY')), sellWin: avg(rs.filter((r) => r.pred === 'SELL')) };
}
function avg(rs) { return rs.length ? { n: rs.length, winRate: rs.reduce((a, r) => a + r.win, 0) / rs.length } : null; }
// horizon sensitivity on a deterministic sample of up to 1500 graded BUY/SELL predictions that have 1Min bars
const sample = decorated.filter((r) => r.pred === 'BUY' || r.pred === 'SELL').filter((_, i) => i % Math.max(1, Math.floor(decorated.length / 1500)) === 0).slice(0, 1500);
const q = db.prepare("select timestamp t, close c from ohlcv_bars where symbol=? and timeframe='1Min' and timestamp between ? and ? order by timestamp");
const horizons = [1, 5, 15, 60]; const acc = Object.fromEntries(horizons.map((h) => [h, { n: 0, hit: 0, up: 0 }]));
const accSide = { BUY: Object.fromEntries(horizons.map((h) => [h, { n: 0, hit: 0 }])), SELL: Object.fromEntries(horizons.map((h) => [h, { n: 0, hit: 0 }])) };
for (const r of sample) {
  const bars = q.all(r.symbol, r.t - 120_000, r.t + 65 * 60_000);
  if (bars.length < 3) continue;
  const p0 = (bars.filter((b) => b.t <= r.t).pop() ?? bars[0]).c;
  for (const h of horizons) {
    const tgt = r.t + h * 60_000; const b = bars.find((x) => x.t >= tgt); if (!b || b.t - tgt > 120_000) continue;
    const ret = b.c / p0 - 1; if (ret === 0) continue;
    const hit = (r.pred === 'BUY') === (ret > 0) ? 1 : 0;
    acc[h].n++; acc[h].hit += hit; acc[h].up += ret > 0 ? 1 : 0; accSide[r.pred][h].n++; accSide[r.pred][h].hit += hit;
  }
}
out.horizonSensitivity = { sampleSize: sample.length, overall: Object.fromEntries(horizons.map((h) => [h, { n: acc[h].n, hitRate: acc[h].n ? +(acc[h].hit / acc[h].n).toFixed(4) : null, fractionUp: acc[h].n ? +(acc[h].up / acc[h].n).toFixed(4) : null }])), bySide: Object.fromEntries(Object.entries(accSide).map(([s, v]) => [s, Object.fromEntries(horizons.map((h) => [h, { n: v[h].n, hitRate: v[h].n ? +(v[h].hit / v[h].n).toFixed(4) : null }]))])) };
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
