// READ-ONLY (2026-10-14 audit follow-up, Level 3): grade a deterministic sample of RECENT predictions (the ones the starved grader never reached) with the
// production outcome rule (entry = first 1Min close in the window, final = last close at the horizon, WIN iff the side matched the direction), then compare
// (a) the STORED calibration (frozen on Sep 14-16 data) and (b) a refit on the earlier recent window against the held-out later window.
// Usage: node recentWindowCalibrationOos.cjs <snapshot.db> <out.json>
const Database = require('better-sqlite3');
const fs = require('fs');
const [dbPath, outPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const PRIOR = 10;
const bucketOf = (c) => (c < 0.6 ? 0 : c < 0.7 ? 0.6 : c < 0.8 ? 0.7 : c < 0.9 ? 0.8 : 0.9);
const mid = (b) => (b === 0 ? 0.3 : b + 0.05);
const post = (w, l, m) => (w + m * PRIOR) / (w + l + PRIOR);
const stored = Object.fromEntries(db.prepare("select agent_name a, bucket_low b, wins w, losses l, calibrated_confidence c from agent_confidence_calibration where provider='ALL'").all().map((r) => [`${r.a}|${r.b}`, r]));
const HORIZON_MS = { KronosEngine: 5 * 60_000, TechnicalAgent: 60 * 60_000, QuantEngine: 60 * 60_000 };
const WINDOWS = { early: ['2026-10-07T00:00:00', '2026-10-10T00:00:00'], late: ['2026-10-12T00:00:00', '2026-10-14T18:00:00'] };
const q = db.prepare("select timestamp t, close c from ohlcv_bars where symbol=? and timeframe='1Min' and timestamp between ? and ? order by timestamp");
const CL = 10 * 60_000;
function grade(agent, win, maxN) {
  const rows = db.prepare('select symbol, prediction, confidence, timestamp from agent_predictions where agent_name=? and timestamp>=? and timestamp<? and prediction in (\'BUY\',\'SELL\')').all(agent, win[0], win[1]);
  const stride = Math.max(1, Math.floor(rows.length / maxN));
  const out = []; const h = HORIZON_MS[agent];
  for (let i = 0; i < rows.length; i += stride) {
    const r = rows[i]; const t = Date.parse(r.timestamp); const bars = q.all(r.symbol, t, t + h + 60_000);
    if (bars.length < 2) continue;
    if (bars[0].t > t + 60_000 || bars[bars.length - 1].t < t + h - 60_000) continue;
    const win_ = bars.filter((b) => b.t <= t + h); if (win_.length < 2) continue;
    const entry = win_[0].c, fin = win_[win_.length - 1].c; if (!(entry > 0) || fin === entry) continue;
    const correct = r.prediction === 'BUY' ? fin > entry : fin < entry;
    out.push({ symbol: r.symbol, side: r.prediction, c: r.confidence, t, win: correct ? 1 : 0, cl: `${r.symbol}|${Math.floor(t / CL)}` });
  }
  return { out, population: rows.length, stride };
}
function eff(rs) { const m = new Map(); for (const r of rs) { const e = m.get(r.cl) ?? { w: 0, n: 0 }; e.w += r.win; e.n++; m.set(r.cl, e); } let w = 0; for (const e of m.values()) w += e.w / e.n; return { n: m.size, wins: w, losses: m.size - w }; }
const result = { generatedFrom: dbPath, method: 'production outcome rule on sampled recent predictions; clusters = symbol x 10min', agents: {} };
for (const agent of Object.keys(HORIZON_MS)) {
  const early = grade(agent, WINDOWS.early, 1800); const late = grade(agent, WINDOWS.late, 1800);
  const A = { horizonMin: HORIZON_MS[agent] / 60000, populationEarly: early.population, populationLate: late.population, gradedEarly: early.out.length, gradedLate: late.out.length, buckets: {}, bySide: {} };
  for (const side of ['BUY', 'SELL']) { const s = late.out.filter((r) => r.side === side); A.bySide[side] = { n: s.length, winRate: s.length ? +(s.reduce((a, r) => a + r.win, 0) / s.length).toFixed(4) : null, effectiveN: eff(s).n }; }
  let bStored = 0, bRefit = 0, bCoin = 0, bRaw = 0, n = 0;
  for (const b of [0, 0.6, 0.7, 0.8, 0.9]) {
    const tr = early.out.filter((r) => bucketOf(r.c) === b); const te = late.out.filter((r) => bucketOf(r.c) === b);
    const trw = tr.reduce((a, r) => a + r.win, 0); const e = eff(tr); const st = stored[`${agent}|${b}`];
    const pStored = st ? st.c : mid(b); const pRefitEff = post(e.wins, e.losses, mid(b)); const pRefitRaw = post(trw, tr.length - trw, mid(b));
    const teW = te.length ? te.reduce((a, r) => a + r.win, 0) / te.length : null;
    A.buckets[b] = { storedCalibrated: st ? +st.c.toFixed(4) : null, storedWinsLosses: st ? `${st.w}/${st.l}` : null, earlyN: tr.length, earlyEffN: +e.n.toFixed(0), earlyWinRate: tr.length ? +(trw / tr.length).toFixed(4) : null, refitEffective: +pRefitEff.toFixed(4), refitRaw: +pRefitRaw.toFixed(4), lateN: te.length, lateEffN: eff(te).n, lateWinRate: teW === null ? null : +teW.toFixed(4) };
    for (const r of te) { bStored += (pStored - r.win) ** 2; bRefit += (pRefitEff - r.win) ** 2; bRaw += (pRefitRaw - r.win) ** 2; bCoin += (0.5 - r.win) ** 2; n++; }
  }
  A.oosBrier = n ? { n, storedCalibration: +(bStored / n).toFixed(5), refitEffectiveEarlyWindow: +(bRefit / n).toFixed(5), refitRawEarlyWindow: +(bRaw / n).toFixed(5), coinFlip: +(bCoin / n).toFixed(5) } : null;
  result.agents[agent] = A;
  console.error(`done ${agent}`);
}
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
