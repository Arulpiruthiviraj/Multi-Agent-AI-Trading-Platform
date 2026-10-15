// READ-ONLY stage 2 of the storage audit (Oct 14 snapshot only): daily growth of the biggest tables, widest columns, event-type mix.
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const db = new D('C:/Users/ithay/AppData/Local/Temp/J/db_backup/argus_oct14_postclose_1792008436014.db', { readonly: true, fileMustExist: true });
const OUT = 'C:/Users/ithay/AppData/Local/Temp/J/storage_audit2.json';
const res = {};
const t0 = Date.now(); const lap = (k) => { res[k + '_s'] = (Date.now() - t0) / 1000; fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); };
const cols = (t) => db.prepare(`pragma table_info(${t})`).all().map((c) => c.name);
res.columns = Object.fromEntries(['observability_events', 'quant_assessments', 'decision_provenance', 'event_traces', 'agent_reasoning_logs'].map((t) => [t, cols(t)]));
// widest columns by sampling 3000 rows (rowid stride)
function widest(t) {
  const n = db.prepare(`select count(*) c from ${t}`).get().c; const stride = Math.max(1, Math.floor(n / 3000));
  const cs = cols(t); const expr = cs.map((c) => `avg(length("${c}")) a_${c}`).join(',');
  const r = db.prepare(`select ${expr} from ${t} where rowid % ${stride} = 0`).get();
  return Object.entries(r).map(([k, v]) => [k.slice(2), Math.round(v || 0)]).sort((a, b) => b[1] - a[1]).slice(0, 4);
}
for (const t of ['quant_assessments', 'decision_provenance', 'event_traces', 'agent_reasoning_logs']) { res['widest_' + t] = widest(t); lap('widest_' + t); }
// daily rows (last 16 days) for tables with an indexed time column
const dayExpr = { observability_events: ["ts", 'ms'], quant_assessments: ['timestamp', 'iso'], decision_provenance: ['created_at', 'any'], event_traces: ['timestamp', 'iso'] };
for (const [t, [col]] of Object.entries(dayExpr)) {
  try {
    const sample = db.prepare(`select ${col} v from ${t} order by rowid desc limit 1`).get()?.v;
    const isNum = typeof sample === 'number';
    const day = isNum ? `date(${col}/1000,'unixepoch')` : `substr(${col},1,10)`;
    const minV = isNum ? Date.now() - 16 * 86400e3 : new Date(Date.now() - 16 * 86400e3).toISOString();
    res['daily_' + t] = db.prepare(`select ${day} d, count(*) c from ${t} where ${col} >= ? group by d order by d`).all(minV);
  } catch (e) { res['daily_' + t] = 'ERR ' + e.message; }
  lap('daily_' + t);
}
// observability event-type mix (full scan)
res.obsByType = db.prepare("select event_type t, count(*) c, sum(length(payload)) pb from observability_events group by event_type order by (count(*)*1.0) desc limit 14").all();
lap('obsByType');
res.obsByBytes = db.prepare("select event_type t, count(*) c, sum(length(coalesce(payload,''))) pb from observability_events group by event_type order by pb desc limit 8").all();
lap('obsByBytes');
res.done = true; lap('done');
console.log('DONE');
