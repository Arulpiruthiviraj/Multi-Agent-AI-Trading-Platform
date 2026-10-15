// Summarize a historical-real-bars session: ideas by agent/side, consensus confidence distribution, approval count, normalized no-trade reasons.
// Usage: node historicalSessionSummary.cjs <result.json>
const Database = require('better-sqlite3'); const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const p = fs.existsSync(j.evidenceRetention?.path ?? '') ? j.evidenceRetention.path : j.dbPath;
const db = new Database(p, { readonly: true });
const ideas = db.prepare("select json_extract(payload,'$.payload.agent') a, json_extract(payload,'$.payload.side') s, count(*) c from observability_events where event_type='TRADE_IDEA_GENERATED' group by a,s order by c desc").all();
const rounds = db.prepare("select payload from observability_events where event_type='CHIEF_CONSENSUS_COMPLETED'").all().map((r) => JSON.parse(r.payload).payload);
const conf = rounds.map((r) => r.confidence).filter((x) => typeof x === 'number').sort((a, b) => a - b);
const q = (f) => conf.length ? +conf[Math.min(conf.length - 1, Math.floor(f * conf.length))].toFixed(3) : null;
const reasons = {}; for (const r of rounds) { const k = String(r.reason || (r.approved ? 'APPROVED' : '')).replace(/[0-9.]+%?/g, '#').slice(0, 110); reasons[k] = (reasons[k] || 0) + 1; }
const orders = db.prepare('select side,status,count(*) c from trades group by 1,2').all();
console.log(JSON.stringify({ file: process.argv[2], symbols: j.discovery?.symbols, forwardFilled: j.discovery?.forwardFilledMinutes, ideasByAgentSide: ideas, rounds: rounds.length, approvedRounds: rounds.filter((r) => r.approved).length, confidence: { max: conf[conf.length - 1] ?? null, p50: q(0.5), p90: q(0.9), p99: q(0.99), atLeast0_6: conf.filter((c) => c >= 0.6).length, atLeast0_75: conf.filter((c) => c >= 0.75).length }, topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8), orders }, null, 1));
