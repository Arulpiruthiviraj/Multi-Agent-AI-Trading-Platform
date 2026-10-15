// Offline Oct 14 funnel extraction from a CONSISTENT SNAPSHOT of the production DB (read-only). No secrets are read or written.
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const dir = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/';
const snap = process.argv[2] || fs.readdirSync(dir).filter((x) => /postclose.*\.db$/.test(x)).sort().pop();
const db = new D(dir + snap, { readonly: true, fileMustExist: true });
const A = Date.parse('2026-10-14T13:30:00Z'), B = Date.parse('2026-10-14T20:00:00Z');
const PRE = Date.parse('2026-10-14T08:00:00Z');
const out = { snapshot: snap, window: ['2026-10-14T13:30:00Z', '2026-10-14T20:00:00Z'] };
const t = (label, fn) => { const t0 = Date.now(); try { out[label] = fn(); } catch (e) { out[label] = { error: e.message }; } out['_ms_' + label] = Date.now() - t0; console.error(label, Date.now() - t0, 'ms'); };
const iso = (ms) => ms == null ? null : new Date(ms).toISOString();

t('eventTypeCounts', () => db.prepare('select event_type, count(*) c, count(distinct symbol) syms, min(ts) a, max(ts) b from observability_events where ts between ? and ? group by event_type order by c desc').all(A, B).map((r) => ({ ...r, a: iso(r.a), b: iso(r.b) })));

t('sessionBounds', () => db.prepare('select count(*) c, min(ts) a, max(ts) b from observability_events where ts between ? and ?').get(A, B));

t('trades', () => db.prepare("select id, symbol, side, status, quantity, timestamp, broker_id, execution_environment from trades where timestamp >= '2026-10-14' order by timestamp").all());
t('riskAssessments', () => db.prepare("select approved, rejection_gate, count(*) c, count(distinct symbol) syms from risk_assessments where created_at >= '2026-10-14T00:00:00Z' group by approved, rejection_gate").all());
t('fillsToday', () => db.prepare("select count(*) c from fills where timestamp >= '2026-10-14'").get());

const termGroups = (eventType, keys) => {
  const rows = db.prepare('select symbol, payload, ts from observability_events where event_type = ? and ts between ? and ?').all(eventType, A, B);
  const g = {};
  for (const r of rows) {
    let p = {}; try { p = JSON.parse(r.payload); } catch { /* ignore */ }
    p = p.payload || p;
    const k = keys.map((x) => String(p[x] ?? '?')).join('|');
    const e = g[k] || (g[k] = { count: 0, syms: new Set(), first: r.ts, last: r.ts });
    e.count++; e.syms.add(r.symbol); e.first = Math.min(e.first, r.ts); e.last = Math.max(e.last, r.ts);
  }
  return Object.entries(g).map(([k, v]) => ({ key: k, count: v.count, uniqueSymbols: v.syms.size, first: iso(v.first), last: iso(v.last) })).sort((a, b) => b.count - a.count);
};
t('consensusTerminal', () => termGroups('CONSENSUS_TERMINAL_REASON', ['terminalReasonCode', 'approved']));
t('deskNoTrade', () => termGroups('DESK_NO_TRADE', ['terminalReasonCode', 'quantReasonCode']));
t('quantNotAuthorizedSample', () => db.prepare("select symbol, payload from observability_events where ts between ? and ? and (payload like '%QUANT_NOT_AUTHORIZED%' or payload like '%NO_LIFECYCLE_RECORD%') limit 3").all(A, B));
t('quantNotAuthorizedCount', () => db.prepare("select count(*) c, count(distinct symbol) syms, min(ts) a, max(ts) b from observability_events where ts between ? and ? and payload like '%NO_LIFECYCLE_RECORD%'").get(A, B));

t('discoveryFiltered', () => termGroups('DISCOVERY_CANDIDATE_FILTERED', ['reason']));
t('subscriptionNotPromoted', () => termGroups('SUBSCRIPTION_NOT_PROMOTED', ['reasonCode']));
t('subscriptionPromoted', () => termGroups('SUBSCRIPTION_PROMOTED', ['reasonCode', 'source']));
t('subscriptionEvicted', () => { const rows = db.prepare('select symbol, payload from observability_events where event_type = ? and ts between ? and ?').all('SUBSCRIPTION_EVICTED', A, B); const g = {}; for (const r of rows) { let p = {}; try { p = JSON.parse(r.payload); } catch { /* */ } const k = String(p.reasoning || '').replace(/\(score=[0-9.]+, ticks=\d+\)/, '(score=_, ticks=_)').replace(/ on [A-Z.]+/, ' on _').slice(0, 110); g[k] = (g[k] || 0) + 1; } return Object.entries(g).map(([k, c]) => ({ k, c })).sort((a, b) => b.c - a.c).slice(0, 8); });
t('rescueGrants', () => { const rows = db.prepare('select symbol, payload, ts from observability_events where event_type = ? and ts between ? and ?').all('TEMPORARY_DATA_RESCUE_GRANTED', A, B); const g = {}; const perHour = {}; for (const r of rows) { let p = {}; try { p = JSON.parse(r.payload); p = p.payload || p; } catch { /* */ } const k = `${p.requestClass}|${p.requestIntent}|alreadySubscribed=${p.alreadySubscribed}`; const e = g[k] || (g[k] = { c: 0, syms: new Set() }); e.c++; e.syms.add(r.symbol); const h = iso(r.ts).slice(11, 13); perHour[h] = (perHour[h] || 0) + 1; } return { byClass: Object.entries(g).map(([k, v]) => ({ k, count: v.c, uniqueSymbols: v.syms.size })).sort((a, b) => b.count - a.count), perHourUTC: perHour }; });
t('rescueDenied', () => termGroups('TEMPORARY_DATA_RESCUE_DENIED', ['requestClass', 'requestIntent', 'deniedReason']));

// promoted -> evicted quickly (CCI pattern)
t('promotedThenEvictedWithin60s', () => {
  const prom = db.prepare('select symbol, ts from observability_events where event_type = ? and ts between ? and ? order by ts').all('SUBSCRIPTION_PROMOTED', A, B);
  const ev = db.prepare('select symbol, ts from observability_events where event_type = ? and ts between ? and ? order by ts').all('SUBSCRIPTION_EVICTED', A, B);
  const byS = {}; for (const e of ev) (byS[e.symbol] = byS[e.symbol] || []).push(e.ts);
  const hits = [];
  for (const p of prom) { const later = (byS[p.symbol] || []).find((x) => x >= p.ts); if (later != null && later - p.ts < 60000) hits.push({ symbol: p.symbol, promoted: iso(p.ts), evictedAfterSec: +((later - p.ts) / 1000).toFixed(1) }); }
  return { promotions: prom.length, evictions: ev.length, quickEvictions: hits.length, sample: hits.slice(0, 25) };
});

// activity gaps (freeze localisation): events per 30-second bucket, report buckets with zero events inside the session
t('quietGaps', () => {
  const rows = db.prepare('select (ts/30000) b, count(*) c from observability_events where ts between ? and ? group by b').all(A, B);
  const have = new Set(rows.map((r) => r.b)); const gaps = []; let start = null;
  for (let b = Math.floor(A / 30000); b <= Math.floor(B / 30000); b++) { if (!have.has(b)) { if (start == null) start = b; } else if (start != null) { if (b - start >= 4) gaps.push({ from: iso(start * 30000), to: iso(b * 30000), minutes: +((b - start) / 2).toFixed(1) }); start = null; } }
  return gaps;
});

// lifecycle records
t('lifecycleRows', () => db.prepare("select version_type, status, created_at, substr(hypothesis,1,80) h from learning_versions where version_type like '%eligib%' or version_type like '%strategy%' order by created_at desc limit 40").all());

// Quant bridge outcomes today (Java availability)
t('quantBridge', () => termGroups('QUANT_BRIDGE_CALL_OUTCOME', ['outcome', 'status']));
t('quantAssessed', () => db.prepare("select event_type, count(*) c, count(distinct symbol) syms from observability_events where ts between ? and ? and event_type in ('QUANT_ASSESSMENT_COMPLETED','QUANT_ASSESSMENT_STARTED','QUANT_EVALUATION_SKIPPED','QUANT_CORE_PARITY_DIVERGENCE') group by event_type").all(A, B));

fs.writeFileSync('C:/Users/ithay/AppData/Local/Temp/J/oct14_funnel.json', JSON.stringify(out, null, 1));
console.log('written');
