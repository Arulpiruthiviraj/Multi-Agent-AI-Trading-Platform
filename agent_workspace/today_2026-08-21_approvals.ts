import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'argus.db'), { readonly: true });
const dayStart = '2026-08-21T00:00:00.000Z';
const dayEnd = '2026-08-22T00:00:00.000Z';

const approved = db
  .prepare(
    `SELECT * FROM consensus_decisions WHERE created_at >= ? AND created_at < ? AND approved = 1 ORDER BY created_at`,
  )
  .all(dayStart, dayEnd);

const risk = db
  .prepare(`SELECT * FROM risk_assessments WHERE created_at >= ? AND created_at < ? ORDER BY created_at`)
  .all(dayStart, dayEnd);

const trades = db
  .prepare(
    `SELECT id, symbol, side, status, submitted_at, filled_at, broker_id, execution_environment,
            substr(coalesce(reasoning,''),1,160) as reasoning
     FROM trades
     WHERE coalesce(submitted_at, timestamp) >= ? AND coalesce(submitted_at, timestamp) < ?
     ORDER BY coalesce(submitted_at, timestamp)`,
  )
  .all(dayStart, dayEnd);

const recentTrades = db
  .prepare(
    `SELECT id, symbol, side, status, submitted_at, broker_id, execution_environment
     FROM trades ORDER BY coalesce(submitted_at, timestamp) DESC LIMIT 20`,
  )
  .all();

const gates = db
  .prepare(
    `SELECT r.trace_id, r.gate_name, r.passed, r.sequence, substr(coalesce(r.detail,''),1,120) as detail
     FROM risk_gate_results r
     WHERE r.trace_id IN (SELECT trace_id FROM risk_assessments WHERE created_at >= ? AND created_at < ?)
     ORDER BY r.trace_id, r.sequence`,
  )
  .all(dayStart, dayEnd);

const predByHour = db
  .prepare(
    `SELECT substr(timestamp,1,13) as hour, count(*) as c FROM agent_predictions
     WHERE timestamp >= ? AND timestamp < ? GROUP BY substr(timestamp,1,13) ORDER BY hour`,
  )
  .all(dayStart, dayEnd);

const consensusByHour = db
  .prepare(
    `SELECT substr(created_at,1,13) as hour, approved, count(*) as c FROM consensus_decisions
     WHERE created_at >= ? AND created_at < ? GROUP BY substr(created_at,1,13), approved ORDER BY hour`,
  )
  .all(dayStart, dayEnd);

const agentRth = db
  .prepare(
    `SELECT agent_name, prediction, count(*) as c FROM agent_predictions
     WHERE timestamp >= '2026-08-21T13:30:00.000Z' AND timestamp < '2026-08-21T20:00:00.000Z'
     GROUP BY agent_name, prediction ORDER BY c DESC`,
  )
  .all();

const out = {
  approved_consensus: approved.map((a: any) => ({
    ts: a.created_at,
    symbol: a.symbol,
    side: a.side,
    conf: a.weighted_confidence,
    txn: a.transaction_id,
    reason: String(a.reasoning || '').slice(0, 200),
  })),
  risk,
  trades,
  recentTrades,
  gates_sample: gates.slice(0, 80),
  gate_fail_summary: (() => {
    const m: Record<string, number> = {};
    for (const g of gates as any[]) {
      if (g.passed === 0 || g.passed === false) m[g.gate_name] = (m[g.gate_name] || 0) + 1;
    }
    return m;
  })(),
  predByHour,
  consensusByHour,
  agentRth,
};

fs.writeFileSync(
  path.join(process.cwd(), 'agent_workspace', 'today_2026-08-21_approvals.json'),
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify({
  approvedCount: approved.length,
  approved: out.approved_consensus,
  riskCount: risk.length,
  risk: risk.map((r: any) => ({
    ts: r.created_at, symbol: r.symbol, side: r.side, approved: r.approved,
    gate: r.rejection_gate, qty: r.max_quantity, trace: r.trace_id,
  })),
  tradesCount: trades.length,
  trades,
  gateFails: out.gate_fail_summary,
  recentTrades: recentTrades.slice(0, 8),
}, null, 2));
db.close();
