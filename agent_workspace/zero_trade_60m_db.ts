import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'argus.db'), { readonly: true });
const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function cols(table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name);
}

const tables = [
  'trades', 'fills', 'risk_assessments', 'risk_gate_results', 'event_traces',
  'consensus_decisions', 'consensus_evidence', 'agent_predictions', 'observability_events',
  'transaction_traces', 'quant_assessments', 'agent_reasoning_logs',
];

const report: any = { since };
for (const t of tables) {
  try {
    report[t + '_cols'] = cols(t);
  } catch {
    report[t + '_cols'] = 'MISSING';
  }
}

function pickTs(table: string, candidates: string[]) {
  const c = report[table + '_cols'] as string[];
  if (!Array.isArray(c)) return null;
  return candidates.find((x) => c.includes(x)) || null;
}

function countSince(table: string, tsCol: string | null) {
  if (!tsCol) return { error: 'no ts col' };
  return db.prepare(`SELECT count(*) as c FROM ${table} WHERE ${tsCol} >= ?`).get(since);
}

const maps: Array<[string, string[]]> = [
  ['trades', ['submitted_at', 'timestamp', 'filled_at']],
  ['fills', ['filled_at']],
  ['risk_assessments', ['created_at', 'assessed_at']],
  ['risk_gate_results', ['created_at']],
  ['event_traces', ['timestamp']],
  ['consensus_decisions', ['created_at']],
  ['agent_predictions', ['timestamp']],
  ['observability_events', ['timestamp']],
  ['transaction_traces', ['created_at', 'updated_at']],
  ['quant_assessments', ['created_at']],
  ['agent_reasoning_logs', ['timestamp', 'created_at']],
];

for (const [table, cands] of maps) {
  const ts = pickTs(table, cands);
  report[table + '_ts'] = ts;
  report[table + '_60m'] = countSince(table, ts);
}

// event type breakdown
const etTs = pickTs('event_traces', ['timestamp']);
if (etTs) {
  report.event_types = db.prepare(
    `SELECT event_type, count(*) as c FROM event_traces WHERE ${etTs} >= ? GROUP BY event_type ORDER BY c DESC LIMIT 40`,
  ).all(since);
}

const apTs = pickTs('agent_predictions', ['timestamp']);
if (apTs) {
  report.agent_pred = db.prepare(
    `SELECT agent_name, prediction, count(*) as c FROM agent_predictions WHERE ${apTs} >= ? GROUP BY agent_name, prediction ORDER BY c DESC`,
  ).all(since);
}

const cdTs = pickTs('consensus_decisions', ['created_at']);
if (cdTs) {
  const cdCols = report.consensus_decisions_cols as string[];
  const confCol = cdCols.includes('weighted_confidence') ? 'weighted_confidence' : (cdCols.includes('confidence') ? 'confidence' : null);
  const reasonCol = cdCols.includes('reasoning') ? 'reasoning' : (cdCols.includes('reason') ? 'reason' : null);
  report.consensus_sample = db.prepare(
    `SELECT * FROM consensus_decisions WHERE ${cdTs} >= ? ORDER BY ${cdTs} DESC LIMIT 20`,
  ).all(since);
  report.consensus_approved = db.prepare(
    `SELECT approved, count(*) as c FROM consensus_decisions WHERE ${cdTs} >= ? GROUP BY approved`,
  ).all(since);
  if (confCol && reasonCol) {
    report.consensus_rejects = db.prepare(
      `SELECT symbol, approved, ${confCol} as conf, substr(${reasonCol},1,200) as reason, ${cdTs} as ts
       FROM consensus_decisions WHERE ${cdTs} >= ? AND (approved = 0 OR approved = false)
       ORDER BY ${cdTs} DESC LIMIT 30`,
    ).all(since);
  }
}

const raTs = pickTs('risk_assessments', ['created_at', 'assessed_at']);
if (raTs) {
  report.risk_sample_cols = report.risk_assessments_cols;
  report.risk_rows = db.prepare(`SELECT * FROM risk_assessments WHERE ${raTs} >= ? ORDER BY ${raTs} DESC LIMIT 10`).all(since);
}

const rgTs = pickTs('risk_gate_results', ['created_at']);
if (rgTs) {
  const rgCols = report.risk_gate_results_cols as string[];
  const gateCol = rgCols.find((c) => /gate/i.test(c)) || 'gate';
  const passCol = rgCols.find((c) => /pass/i.test(c)) || 'passed';
  report.gate_breakdown = db.prepare(
    `SELECT ${gateCol} as gate, ${passCol} as passed, count(*) as c FROM risk_gate_results WHERE ${rgTs} >= ? GROUP BY ${gateCol}, ${passCol} ORDER BY c DESC LIMIT 50`,
  ).all(since);
}

const qaTs = pickTs('quant_assessments', ['created_at']);
if (qaTs) {
  report.quant_60m = countSince('quant_assessments', qaTs);
  report.quant_emitted = db.prepare(
    `SELECT emitted_trade_idea, count(*) as c FROM quant_assessments WHERE ${qaTs} >= ? GROUP BY emitted_trade_idea`,
  ).all(since);
}

fs.writeFileSync(
  path.join(process.cwd(), 'agent_workspace', 'zero_trade_60m_db.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({
  since,
  trades: report.trades_60m,
  fills: report.fills_60m,
  events: report.event_traces_60m,
  event_types: report.event_types?.slice?.(0, 20),
  agent_pred: report.agent_pred?.slice?.(0, 25),
  consensus_approved: report.consensus_approved,
  consensus_rejects: report.consensus_rejects?.slice?.(0, 10),
  risk_count: report.risk_assessments_60m,
  gate_fails: (report.gate_breakdown || []).filter((g: any) => g.passed === 0 || g.passed === false).slice(0, 15),
  quant: report.quant_emitted,
}, null, 2));
db.close();
