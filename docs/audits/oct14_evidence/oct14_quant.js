// Oct 14: what Quant produced and what lifecycle authorization removed (read-only snapshot).
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const dir = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/';
const snap = fs.readdirSync(dir).filter((x) => /postclose.*\.db$/.test(x)).sort().pop();
const db = new D(dir + snap, { readonly: true, fileMustExist: true });
const A = Date.parse('2026-10-14T13:30:00Z'), B = Date.parse('2026-10-14T20:00:00Z');
const sample = db.prepare("select event_type, symbol, payload from observability_events where ts between ? and ? and payload like '%NO_LIFECYCLE_RECORD%' limit 2").all(A, B);
console.log('SAMPLE', JSON.stringify(sample.map((r) => ({ t: r.event_type, s: r.symbol, p: r.payload.slice(0, 700) }))));
const qa = db.prepare("select payload from observability_events where event_type='QUANT_ASSESSMENT_COMPLETED' and ts between ? and ? limit 1").get(A, B);
console.log('QUANT_ASSESSMENT sample', qa.payload.slice(0, 900));
const bySym = {}, byStrat = {}, bySide = {}; let n = 0;
for (const r of db.prepare("select event_type, symbol, payload, ts from observability_events where ts between ? and ? and payload like '%NO_LIFECYCLE_RECORD%'").iterate(A, B)) {
  let p; try { p = JSON.parse(r.payload); p = p.payload || p; } catch { continue; }
  n++;
  const sid = p.strategyId || p.quantStrategyId || (p.summary && p.summary.strategyId) || (String(r.payload).match(/strategy ([A-Z_]+)/) || [])[1] || '?';
  byStrat[sid] = (byStrat[sid] || 0) + 1; bySym[r.symbol] = (bySym[r.symbol] || 0) + 1; const side = p.side || (String(r.payload).match(/"side":"(BUY|SELL)"/) || [])[1] || '?'; bySide[side] = (bySide[side] || 0) + 1;
}
console.log(JSON.stringify({ n, byStrat, bySide, bySymTop: Object.entries(bySym).sort((a, b) => b[1] - a[1]).slice(0, 25) }));
