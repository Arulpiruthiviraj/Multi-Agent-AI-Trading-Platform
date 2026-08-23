/**
 * Read-only forensic probe for 2026-08-21 America/New_York paper session.
 * No mutations, no orders.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'argus.db'), { readonly: true });

// NY session bounds for 2026-08-21 (approx UTC): RTH 13:30–20:00 UTC in EDT
const dayStart = '2026-08-21T00:00:00.000Z';
const dayEnd = '2026-08-22T00:00:00.000Z';
const rthStart = '2026-08-21T13:30:00.000Z';
const rthEnd = '2026-08-21T20:00:00.000Z';

function cols(t: string) {
  try {
    return db.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => c.name);
  } catch {
    return [] as string[];
  }
}
function pick(names: string[], cands: string[]) {
  return cands.find((c) => names.includes(c)) || null;
}

const report: any = {
  probedAt: new Date().toISOString(),
  dayStart,
  dayEnd,
  rthStart,
  rthEnd,
};

report.settings = db.prepare('SELECT * FROM settings LIMIT 1').get();

const tables = [
  'trades', 'fills', 'risk_assessments', 'risk_gate_results', 'consensus_decisions',
  'agent_predictions', 'event_traces', 'observability_events', 'quant_assessments',
  'reconciliation_events', 'kill_switch_events', 'transaction_traces', 'transactions',
];

for (const t of tables) {
  const c = cols(t);
  report[`${t}_cols`] = c;
}

function countBetween(table: string, tsCol: string | null, start: string, end: string) {
  if (!tsCol) return { error: 'no ts' };
  return db.prepare(`SELECT count(*) as c FROM ${table} WHERE ${tsCol} >= ? AND ${tsCol} < ?`).get(start, end);
}

const maps: Array<[string, string[]]> = [
  ['trades', ['submitted_at', 'timestamp']],
  ['fills', ['filled_at']],
  ['risk_assessments', ['created_at']],
  ['consensus_decisions', ['created_at']],
  ['agent_predictions', ['timestamp']],
  ['event_traces', ['timestamp']],
  ['quant_assessments', ['created_at']],
  ['reconciliation_events', ['created_at', 'checked_at', 'timestamp']],
  ['kill_switch_events', ['created_at', 'timestamp']],
  ['transaction_traces', ['created_at', 'updated_at']],
  ['observability_events', ['ts', 'timestamp']],
];

for (const [table, cands] of maps) {
  const ts = pick(report[`${table}_cols`] || [], cands);
  report[`${table}_ts`] = ts;
  report[`${table}_day`] = countBetween(table, ts, dayStart, dayEnd);
  report[`${table}_rth`] = countBetween(table, ts, rthStart, rthEnd);
}

// Trades all-time today any env
report.trades_day_detail = db.prepare(
  `SELECT status, side, execution_environment, broker_id, count(*) as c
   FROM trades WHERE coalesce(submitted_at, timestamp) >= ? AND coalesce(submitted_at, timestamp) < ?
   GROUP BY status, side, execution_environment, broker_id`,
).all(dayStart, dayEnd);

report.agent_pred_day = db.prepare(
  `SELECT agent_name, prediction, count(*) as c FROM agent_predictions
   WHERE timestamp >= ? AND timestamp < ?
   GROUP BY agent_name, prediction ORDER BY c DESC`,
).all(dayStart, dayEnd);

report.agent_pred_rth = db.prepare(
  `SELECT agent_name, prediction, count(*) as c FROM agent_predictions
   WHERE timestamp >= ? AND timestamp < ?
   GROUP BY agent_name, prediction ORDER BY c DESC`,
).all(rthStart, rthEnd);

report.consensus_day = db.prepare(
  `SELECT approved, count(*) as c FROM consensus_decisions
   WHERE created_at >= ? AND created_at < ? GROUP BY approved`,
).all(dayStart, dayEnd);

report.consensus_rejects_sample = db.prepare(
  `SELECT symbol, approved, weighted_confidence, agreements_count, substr(reasoning,1,220) as reason, created_at
   FROM consensus_decisions WHERE created_at >= ? AND created_at < ? AND approved = 0
   ORDER BY created_at DESC LIMIT 40`,
).all(dayStart, dayEnd);

report.consensus_approved_rows = db.prepare(
  `SELECT * FROM consensus_decisions WHERE created_at >= ? AND created_at < ? AND approved = 1 LIMIT 20`,
).all(dayStart, dayEnd);

report.risk_day = db.prepare(
  `SELECT approved, rejection_gate, count(*) as c FROM risk_assessments
   WHERE created_at >= ? AND created_at < ?
   GROUP BY approved, rejection_gate`,
).all(dayStart, dayEnd);

report.quant_day = db.prepare(
  `SELECT emitted_trade_idea, count(*) as c FROM quant_assessments
   WHERE created_at >= ? AND created_at < ? GROUP BY emitted_trade_idea`,
).all(dayStart, dayEnd);

// Campaign / target columns from settings
const sCols = cols('settings');
report.settings_campaign_keys = sCols.filter((k) => /campaign|target|goal|budget|autobot|broker|trading/i.test(k));

const campKeys = [
  'campaign_enabled', 'campaignEnabled', 'daily_profit_target', 'dailyProfitTarget',
  'campaign_daily_target', 'campaignDailyTargetDollars', 'campaign_target_dollars',
];
report.campaign_values = {};
for (const k of sCols) {
  if (/campaign|target|goal|budget|selected_broker|trading_mode|auto_bot|trading_state/i.test(k)) {
    try {
      report.campaign_values[k] = (report.settings as any)[k];
    } catch { /* */ }
  }
}

// First/last prediction times
report.pred_span = db.prepare(
  `SELECT min(timestamp) as first_ts, max(timestamp) as last_ts, count(*) as c
   FROM agent_predictions WHERE timestamp >= ? AND timestamp < ?`,
).all(dayStart, dayEnd);

report.consensus_span = db.prepare(
  `SELECT min(created_at) as first_ts, max(created_at) as last_ts, count(*) as c
   FROM consensus_decisions WHERE created_at >= ? AND created_at < ?`,
).all(dayStart, dayEnd);

// Independent agree histogram from reasoning text
const rejects = report.consensus_rejects_sample as any[];
const buckets: Record<string, number> = {};
for (const r of rejects) {
  const m1 = String(r.reason || '').match(/Independent agreeing agents:\s*(\d+)/i);
  const m2 = String(r.reason || '').match(/at ([\d.]+)%/);
  const key = `agents=${m1?.[1] ?? '?'}_conf≈${m2?.[1] ?? '?'}`;
  buckets[key] = (buckets[key] || 0) + 1;
}
report.reject_pattern_buckets = buckets;

// recon / kill
const reconTs = report.reconciliation_events_ts;
if (reconTs) {
  report.recon_day = db.prepare(
    `SELECT * FROM reconciliation_events WHERE ${reconTs} >= ? AND ${reconTs} < ? ORDER BY ${reconTs} DESC LIMIT 20`,
  ).all(dayStart, dayEnd);
}
const killTs = report.kill_switch_events_ts;
if (killTs) {
  report.kill_day = db.prepare(
    `SELECT * FROM kill_switch_events WHERE ${killTs} >= ? AND ${killTs} < ? ORDER BY ${killTs} DESC LIMIT 20`,
  ).all(dayStart, dayEnd);
}

// Load prior live status if present
for (const f of ['live_status_now.json', 'zero_trade_60m_db.json', 'continuous_status.json']) {
  const p = path.join(process.cwd(), 'agent_workspace', f);
  if (fs.existsSync(p)) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (f === 'live_status_now.json') {
        report.live_status_excerpt = {
          tradingState: j?.pipelineAgents?.tradingState ?? j?.autobot?.tradingState,
          autobot: j?.autobot,
          discovery: j?.pipelineAgents?.discovery,
          newsMode: j?.pipelineAgents?.togglable?.find((a: any) => a.id === 'NewsAgent')?.newsAgentMode,
          quant: j?.pipelineAgents?.togglable?.find((a: any) => a.id === 'QuantEngine'),
          forensicLock: j?.pipelineAgents?.forensicCheckpointBuyLock,
        };
      }
    } catch { /* */ }
  }
}

const out = path.join(process.cwd(), 'agent_workspace', 'today_2026-08-21_forensic_probe.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log('Wrote', out);
console.log(JSON.stringify({
  trades_day: report.trades_day,
  trades_detail: report.trades_day_detail,
  fills_day: report.fills_day,
  pred_day: report.agent_predictions_day,
  pred_rth: report.agent_predictions_rth,
  agent_pred_rth: report.agent_pred_rth?.slice?.(0, 15),
  consensus_day: report.consensus_day,
  consensus_approved: report.consensus_approved_rows?.length,
  risk_day: report.risk_day,
  quant_day: report.quant_day,
  reject_buckets: report.reject_pattern_buckets,
  pred_span: report.pred_span,
  consensus_span: report.consensus_span,
  campaign_keys: report.settings_campaign_keys,
  campaign_values: report.campaign_values,
  live: report.live_status_excerpt,
}, null, 2));
db.close();
