const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });

// For each kronos_predictions row, count matching agent_predictions(KronosEngine) rows
// with same symbol+prediction+confidence within 1000ms.
const kp = db.prepare(`SELECT id, symbol, prediction, confidence, timestamp FROM kronos_predictions`).all();
const apK = db.prepare(`SELECT id, symbol, prediction, confidence, timestamp, trace_id FROM agent_predictions WHERE agent_name='KronosEngine'`).all();

// index apK by symbol
const bySymbol = {};
for (const r of apK) {
  (bySymbol[r.symbol] ||= []).push(r);
}

let matchCounts = {0:0,1:0,2:0,3:0,morethan3:0};
let totalMatches = 0;
for (const k of kp) {
  const kt = new Date(k.timestamp).getTime();
  const candidates = (bySymbol[k.symbol]||[]).filter(a => a.prediction===k.prediction && Math.abs(a.confidence-k.confidence)<0.0001 && Math.abs(new Date(a.timestamp).getTime()-kt) < 1000);
  const n = candidates.length;
  totalMatches += n;
  if (n<=3) matchCounts[n]++; else matchCounts.morethan3++;
}
console.log('kronos_predictions rows:', kp.length);
console.log('match-count distribution (# of agent_predictions[KronosEngine] rows matching each kronos_predictions row within 1s, same symbol+prediction+confidence):', matchCounts);
console.log('total agent_predictions[KronosEngine] rows:', apK.length);
console.log('total matched (sum):', totalMatches);

// Among matched pairs, how many have trace_id null vs set?
let nullTrace=0, setTrace=0;
for (const r of apK) { if (r.trace_id===null) nullTrace++; else setTrace++; }
console.log('KronosEngine agent_predictions: null trace_id =', nullTrace, ' set trace_id =', setTrace);

db.close();
