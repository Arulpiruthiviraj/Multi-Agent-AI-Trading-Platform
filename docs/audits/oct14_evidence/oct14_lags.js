// Oct 14: stage-lag population stats + first-block reasons for specific symbols (read-only snapshot).
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const dir = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/';
const snap = fs.readdirSync(dir).filter((x) => /postclose.*\.db$/.test(x)).sort().pop();
const db = new D(dir + snap, { readonly: true, fileMustExist: true });
const A = Date.parse('2026-10-14T13:30:00Z'), B = Date.parse('2026-10-14T20:00:00Z');
const hm = (ms) => ms == null ? null : new Date(ms).toISOString().slice(11, 19) + 'Z';
const out = {};
// 1) promotion -> first TECHNICAL_ANALYSIS_COMPLETED lag for every promotion
const prom = db.prepare("select symbol, ts from observability_events where event_type='SUBSCRIPTION_PROMOTED' and ts between ? and ? order by ts").all(A, B);
const evict = db.prepare("select symbol, ts from observability_events where event_type='SUBSCRIPTION_EVICTED' and ts between ? and ? order by ts").all(A, B);
const tech = db.prepare("select ts from observability_events where symbol = ? and event_type = 'TECHNICAL_ANALYSIS_COMPLETED' and ts >= ? order by ts limit 1");
const evBy = {}; for (const e of evict) (evBy[e.symbol] = evBy[e.symbol] || []).push(e.ts);
const lags = []; let never = 0, evictedBeforeAnalysis = 0;
for (const p of prom) {
  const t = tech.get(p.symbol, p.ts);
  const nextEvict = (evBy[p.symbol] || []).find((x) => x >= p.ts);
  if (!t) { never++; continue; }
  const lag = (t.ts - p.ts) / 1000; lags.push(lag);
  if (nextEvict != null && nextEvict < t.ts) evictedBeforeAnalysis++;
}
lags.sort((a, b) => a - b);
const q = (x) => lags.length ? +lags[Math.min(lags.length - 1, Math.floor(lags.length * x))].toFixed(1) : null;
out.promotionToFirstTechnical = { promotions: prom.length, withAnalysisAfter: lags.length, neverAnalyzedAfter: never, evictedBeforeAnalysis, secP50: q(0.5), secP90: q(0.9), secP99: q(0.99), over10min: lags.filter((x) => x > 600).length, over30min: lags.filter((x) => x > 1800).length };
// 2) long promotion->analysis delays listing
const long = []; for (const p of prom) { const t = tech.get(p.symbol, p.ts); if (t && t.ts - p.ts > 600000) long.push({ symbol: p.symbol, promoted: hm(p.ts), firstAnalysis: hm(t.ts), minutes: +((t.ts - p.ts) / 60000).toFixed(1), evictedInBetween: (evBy[p.symbol] || []).some((x) => x >= p.ts && x < t.ts) }); }
out.longDelays = { count: long.length, evictedInBetweenCount: long.filter((x) => x.evictedInBetween).length, top: long.sort((a, b) => b.minutes - a.minutes).slice(0, 20) };
// 3) specific symbols: not-promoted reasons & first admitted
for (const s of ['IBRX', 'SMR', 'VSTM', 'BSP', 'FAST', 'HALO', 'CIEN']) {
  const np = {}; for (const r of db.prepare("select payload from observability_events where symbol = ? and event_type = 'SUBSCRIPTION_NOT_PROMOTED' and ts between ? and ?").iterate(s, A, B)) { try { const p = JSON.parse(r.payload); const k = p.reasonCode || p.reason || '?'; np[k] = (np[k] || 0) + 1; } catch { /* */ } }
  const fa = db.prepare("select min(ts) t, count(*) c from observability_events where symbol = ? and event_type = 'DISCOVERY_CANDIDATE_ADMITTED' and ts between ? and ?").get(s, A, B);
  const fs1 = db.prepare("select min(ts) t from observability_events where symbol = ? and ts between ? and ? and event_type in ('DISCOVERY_CANDIDATE_ADMITTED','DISCOVERY_CANDIDATE_FILTERED')").get(s, A, B);
  const pr = db.prepare("select group_concat(ts) t from observability_events where symbol = ? and event_type = 'SUBSCRIPTION_PROMOTED' and ts between ? and ?").get(s, A, B);
  const ev = db.prepare("select group_concat(ts) t from observability_events where symbol = ? and event_type = 'SUBSCRIPTION_EVICTED' and ts between ? and ?").get(s, A, B);
  const ideas = db.prepare("select min(ts) t, count(*) c from observability_events where symbol = ? and event_type = 'TRADE_IDEA_GENERATED' and ts between ? and ?").get(s, A, B);
  out['symbol_' + s] = { firstSeenByDiscovery: hm(fs1.t), firstAdmitted: hm(fa.t), admittedEvents: fa.c, notPromoted: np, promotedAt: (pr.t || '').split(',').filter(Boolean).map((x) => hm(+x)), evictedAt: (ev.t || '').split(',').filter(Boolean).map((x) => hm(+x)), firstIdea: hm(ideas.t), ideas: ideas.c };
}
// 4) rescue renewals per symbol class: how many routine renewals hit symbols that were ALSO not-evictable blockers
out.incumbentNotEvictable = db.prepare("select count(*) c, count(distinct symbol) s from observability_events where event_type='SUBSCRIPTION_NOT_PROMOTED' and ts between ? and ? and payload like '%INCUMBENT_NOT_EVICTABLE%'").get(A, B);
// 5) trading-state / lifecycle events during the day
out.stateEvents = db.prepare("select event_type, count(*) c, min(ts) a, max(ts) b from observability_events where ts between ? and ? and (event_type like '%TRADING_STATE%' or event_type like '%PAUSE%' or event_type like '%RESUME%' or event_type like '%RECONCIL%' or event_type like '%UNCLEAN%' or event_type like '%SHUTDOWN%' or event_type like 'SESSION_%' or event_type like '%WATCHDOG%') group by event_type").all(A, B).map((r) => ({ ...r, a: hm(r.a), b: hm(r.b) }));
fs.writeFileSync('C:/Users/ithay/AppData/Local/Temp/J/oct14_lags.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 5500));
