/**
 * Day-1 forensic extract — read-only. Writes agent_workspace/day1_db_forensics.json
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'argus.db');
const outPath = path.join(process.cwd(), 'agent_workspace', 'day1_db_forensics.json');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const NY_DAY = '2026-08-17';
const NY_START = `${NY_DAY}T00:00:00.000-04:00`;
const NY_END = `${NY_DAY}T23:59:59.999-04:00`;

function q<T = unknown>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function q1<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  nyTradingDay: NY_DAY,
  integrity: q1('PRAGMA integrity_check'),
};

out.trades_all = q('SELECT * FROM trades ORDER BY timestamp');
out.fills_all = q('SELECT * FROM fills ORDER BY rowid');

out.transactions_day = {
  by_status: q(`SELECT status, COUNT(*) as n FROM transactions WHERE opened_at >= ? AND opened_at <= ? GROUP BY status`, [NY_START, NY_END]),
  by_final_decision: q(`SELECT final_decision, COUNT(*) as n FROM transactions WHERE opened_at >= ? AND opened_at <= ? GROUP BY final_decision`, [NY_START, NY_END]),
  by_outcome: q(`SELECT outcome, COUNT(*) as n FROM transactions WHERE opened_at >= ? AND opened_at <= ? GROUP BY outcome`, [NY_START, NY_END]),
  open: q(`SELECT id, symbol, opened_at, closed_at, status, final_decision, outcome FROM transactions WHERE status = 'OPEN' ORDER BY opened_at`),
  window: q1<{ first: string; last: string; n: number }>(`
    SELECT MIN(opened_at) as first, MAX(opened_at) as last, COUNT(*) as n
    FROM transactions WHERE opened_at >= ? AND opened_at <= ?
  `, [NY_START, NY_END]),
};

out.event_traces_day = {
  by_type: q(`
    SELECT event_type, COUNT(*) as n FROM event_traces
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY event_type ORDER BY n DESC
  `, [NY_START, NY_END]),
  window: q1(`
    SELECT MIN(created_at) as first, MAX(created_at) as last, COUNT(*) as n
    FROM event_traces WHERE created_at >= ? AND created_at <= ?
  `, [NY_START, NY_END]),
  trade_ideas: q(`
    SELECT trace_id, symbol, event_type, created_at, payload_json
    FROM event_traces
    WHERE created_at >= ? AND created_at <= ? AND event_type = 'TRADE_IDEA_GENERATED'
    ORDER BY created_at LIMIT 50
  `, [NY_START, NY_END]),
  chief_approved: q(`
    SELECT trace_id, symbol, event_type, created_at
    FROM event_traces
    WHERE created_at >= ? AND created_at <= ? AND event_type = 'CHIEF_APPROVED_IDEA'
    ORDER BY created_at
  `, [NY_START, NY_END]),
  order_executed: q(`
    SELECT trace_id, symbol, event_type, created_at
    FROM event_traces
    WHERE created_at >= ? AND created_at <= ? AND event_type = 'ORDER_EXECUTED'
    ORDER BY created_at
  `, [NY_START, NY_END]),
};

out.risk_gates_day = {
  by_gate: q(`
    SELECT gate_name, passed, COUNT(*) as n
    FROM risk_gate_results r
    JOIN risk_assessments a ON a.id = r.assessment_id
    WHERE a.created_at >= ? AND a.created_at <= ?
    GROUP BY gate_name, passed ORDER BY gate_name, passed
  `, [NY_START, NY_END]),
  assessments: q(`
    SELECT approved, COUNT(*) as n FROM risk_assessments
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY approved
  `, [NY_START, NY_END]),
  reject_reasons: q(`
    SELECT rejection_reason, COUNT(*) as n FROM risk_assessments
    WHERE created_at >= ? AND created_at <= ? AND approved = 0
    GROUP BY rejection_reason ORDER BY n DESC LIMIT 20
  `, [NY_START, NY_END]),
};

out.consensus_day = q(`
  SELECT * FROM consensus_decisions
  WHERE created_at >= ? AND created_at <= ?
  ORDER BY created_at
`, [NY_START, NY_END]);

out.agent_predictions_day = q(`
  SELECT agent, side, COUNT(*) as n, AVG(confidence) as avg_conf
  FROM agent_predictions
  WHERE created_at >= ? AND created_at <= ?
  GROUP BY agent, side ORDER BY agent, side
`, [NY_START, NY_END]);

out.ai_calls_day = q(`
  SELECT provider, model, success, COUNT(*) as n, AVG(latency_ms) as avg_latency
  FROM ai_calls
  WHERE created_at >= ? AND created_at <= ?
  GROUP BY provider, model, success
`, [NY_START, NY_END]);

out.kill_switch_day = q(`
  SELECT * FROM kill_switch_events
  WHERE created_at >= ? AND created_at <= ?
  ORDER BY created_at
`, [NY_START, NY_END]);

out.reconciliation_day = {
  summary: q(`
    SELECT
      SUM(CASE WHEN mismatches IS NULL OR mismatches = '[]' OR mismatches = '' THEN 1 ELSE 0 END) as clean,
      SUM(CASE WHEN mismatches IS NOT NULL AND mismatches != '[]' AND mismatches != '' THEN 1 ELSE 0 END) as with_mismatch,
      COUNT(*) as total
    FROM reconciliation_events
    WHERE checked_at >= ? AND checked_at <= ?
  `, [NY_START, NY_END]),
  mismatches: q(`
    SELECT * FROM reconciliation_events
    WHERE checked_at >= ? AND checked_at <= ?
      AND mismatches IS NOT NULL AND mismatches != '[]' AND mismatches != ''
    ORDER BY checked_at LIMIT 20
  `, [NY_START, NY_END]),
};

out.portfolio = q('SELECT * FROM portfolio');
out.broker_connections = q('SELECT * FROM broker_connections');
out.daily_summary = q(`SELECT * FROM daily_trading_summary WHERE trading_date LIKE '2026-08-17%' OR trading_date = '2026-08-17'`);
out.quant_assessments_day = q(`
  SELECT id, symbol, strategy_id, side, confidence, created_at
  FROM quant_assessments WHERE created_at >= ? AND created_at <= ?
  ORDER BY created_at LIMIT 100
`, [NY_START, NY_END]);

out.settings = q1('SELECT * FROM settings LIMIT 1');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
db.close();
