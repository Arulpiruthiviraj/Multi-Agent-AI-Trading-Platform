// Per-symbol Oct 14 trace for the strongest movers Argus OBSERVED (Alpaca IEX snapshot evidence in its own admission events). Read-only snapshot.
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const dir = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/';
const snap = fs.readdirSync(dir).filter((x) => /postclose.*\.db$/.test(x)).sort().pop();
const db = new D(dir + snap, { readonly: true, fileMustExist: true });
const A = Date.parse('2026-10-14T13:30:00Z'), B = Date.parse('2026-10-14T20:00:00Z');
const iso = (ms) => ms == null ? null : new Date(ms).toISOString().slice(11, 19) + 'Z';
const best = {};
const scan = (type) => {
  for (const r of db.prepare('select symbol, payload, ts from observability_events where event_type = ? and ts between ? and ?').iterate(type, A, B)) {
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    const g = p.gapPct; const ev = p.gapEvidence;
    const e = best[r.symbol] || (best[r.symbol] = { symbol: r.symbol, firstSeen: r.ts, maxAbsGap: 0, gapAtMax: null, priceAtMax: null, tsAtMax: null, dollarVolMax: 0, spreadBpsMin: null, rvolMax: 0, sources: new Set(), admitted: 0, filtered: 0, filterReasons: {}, adv: null, prevClose: null });
    e.firstSeen = Math.min(e.firstSeen, r.ts);
    e.sources.add(p.source || '?');
    if (type === 'DISCOVERY_CANDIDATE_ADMITTED') e.admitted++; else { e.filtered++; const k = p.reason || '?'; e.filterReasons[k] = (e.filterReasons[k] || 0) + 1; }
    if (typeof g === 'number' && Math.abs(g) > e.maxAbsGap) { e.maxAbsGap = Math.abs(g); e.gapAtMax = g; e.priceAtMax = p.price ?? ev?.price ?? null; e.tsAtMax = r.ts; e.prevClose = ev?.previousClose ?? null; }
    if (typeof p.dollarVolume === 'number') e.dollarVolMax = Math.max(e.dollarVolMax, p.dollarVolume);
    if (typeof p.spreadBps === 'number') e.spreadBpsMin = e.spreadBpsMin == null ? p.spreadBps : Math.min(e.spreadBpsMin, p.spreadBps);
    if (typeof p.rvol === 'number') e.rvolMax = Math.max(e.rvolMax, p.rvol);
    if (typeof p.advShares === 'number') e.adv = p.advShares;
  }
};
scan('DISCOVERY_CANDIDATE_ADMITTED'); scan('DISCOVERY_CANDIDATE_FILTERED');
const rows = Object.values(best).filter((e) => e.maxAbsGap > 0).sort((a, b) => b.maxAbsGap - a.maxAbsGap);
const top = rows.filter((e) => e.admitted > 0).slice(0, 60);
const first = db.prepare('select min(ts) t, count(*) c from observability_events where symbol = ? and event_type = ? and ts between ? and ?');
const cnt = db.prepare('select count(*) c from observability_events where symbol = ? and event_type = ? and ts between ? and ?');
const term = db.prepare("select payload from observability_events where symbol = ? and event_type = 'CONSENSUS_TERMINAL_REASON' and ts between ? and ?");
const out = [];
for (const e of top) {
  const row = { symbol: e.symbol, maxGapPct: +(e.gapAtMax * 100).toFixed(2), price: e.priceAtMax, prevClose: e.prevClose, at: iso(e.tsAtMax), dollarVolMax: Math.round(e.dollarVolMax), spreadBpsMin: e.spreadBpsMin && +e.spreadBpsMin.toFixed(1), rvolMax: e.rvolMax || null, adv: e.adv && Math.round(e.adv), sources: [...e.sources].join(','), admitted: e.admitted, filtered: e.filtered, filterReasons: e.filterReasons, firstSeen: iso(e.firstSeen) };
  for (const [k, type] of [['promoted', 'SUBSCRIPTION_PROMOTED'], ['subscribeOutcome', 'MARKET_DATA_SUBSCRIPTION_OUTCOME'], ['evicted', 'SUBSCRIPTION_EVICTED'], ['notPromoted', 'SUBSCRIPTION_NOT_PROMOTED'], ['technical', 'TECHNICAL_ANALYSIS_COMPLETED'], ['quantAssessed', 'QUANT_ASSESSMENT_COMPLETED'], ['ideas', 'TRADE_IDEA_GENERATED'], ['consensus', 'CONSENSUS_TERMINAL_REASON']]) {
    const f = first.get(e.symbol, type, A, B); row[k] = { first: iso(f.t), n: f.c };
  }
  const reasons = {}; for (const r of term.iterate(e.symbol, A, B)) { try { const p = JSON.parse(r.payload); const k = (p.payload || p).terminalReasonCode || '?'; reasons[k] = (reasons[k] || 0) + 1; } catch { /* */ } }
  row.consensusReasons = reasons;
  out.push(row);
}
fs.writeFileSync('C:/Users/ithay/AppData/Local/Temp/J/oct14_symbols.json', JSON.stringify({ snapshot: snap, observedMoverCount: rows.length, top: out }, null, 1));
console.log('observed symbols with gap evidence:', rows.length);
