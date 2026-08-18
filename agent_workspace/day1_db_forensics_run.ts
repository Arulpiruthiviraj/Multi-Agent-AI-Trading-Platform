import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const MARKET_DAY = '2026-08-17';
const TZ = 'America/New_York';
const DB_PATH = join(process.cwd(), 'data', 'argus.db');
const OUT_PATH = join(process.cwd(), 'agent_workspace', 'day1_db_forensics.json');

const nyDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function nyDateOf(input: string | number | null | undefined): string | null {
  if (input == null) return null;
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return nyDateFormatter.format(d);
}

function isMarketDay(input: string | number | null | undefined): boolean {
  return nyDateOf(input) === MARKET_DAY;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function safeAll(db: Database.Database, sql: string, params: unknown[] = []): unknown[] {
  try {
    return db.prepare(sql).all(...params) as unknown[];
  } catch (e) {
    return [{ _queryError: String(e) }];
  }
}

function countBy(rows: Record<string, unknown>[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = String(row[key] ?? 'null');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const notes: string[] = [];
const report: Record<string, unknown> = {
  meta: {
    generatedAt: new Date().toISOString(),
    databasePath: DB_PATH,
    marketDay: MARKET_DAY,
    timezone: TZ,
    readOnly: true,
  },
  notes,
};

// 1. ALL trades
const tradeCols = columnNames(db, 'trades');
const tradesRaw = db.prepare('SELECT * FROM trades ORDER BY timestamp ASC').all() as Record<string, unknown>[];
report.trades = tradesRaw.map((t) => ({
  id: t.id,
  symbol: t.symbol,
  side: t.side,
  qty: t.quantity,
  price: t.price,
  status: t.status,
  timestamp: t.timestamp,
  trace_id: t.trace_id,
  execution_environment: t.execution_environment ?? null,
  reasoning: t.reasoning,
  broker_order_id: t.broker_order_id,
  pnl: t.profit_loss,
  _extra: {
    transaction_id: t.transaction_id,
    submitted_at: t.submitted_at,
    accepted_at: t.accepted_at,
    filled_at: t.filled_at,
    quant_strategy_id: t.quant_strategy_id,
  },
}));
report.trades_column_check = {
  requested: ['id', 'symbol', 'side', 'qty', 'price', 'status', 'timestamps', 'trace_id', 'execution_environment', 'reasoning', 'broker_order_id', 'pnl'],
  dbColumns: tradeCols,
  qtyMapsTo: 'quantity',
  pnlMapsTo: 'profit_loss',
};

// 2. ALL fills
if (tableExists(db, 'fills')) {
  report.fills = db.prepare('SELECT * FROM fills ORDER BY filled_at ASC, id ASC').all();
} else {
  notes.push('Table fills missing');
  report.fills = [];
}

// Transactions on market day
const allTransactions = db.prepare('SELECT * FROM transactions ORDER BY opened_at ASC').all() as Record<string, unknown>[];
const dayTransactions = allTransactions.filter((tx) => isMarketDay(tx.opened_at as string));

// 3. transactions
report.transactions_market_day = {
  total: dayTransactions.length,
  countByStatus: countBy(dayTransactions, 'status'),
  countByFinalDecision: countBy(dayTransactions, 'final_decision'),
  countByOutcome: countBy(dayTransactions, 'outcome'),
  openTransactions: dayTransactions
    .filter((tx) => tx.status === 'OPEN')
    .map((tx) => ({
      id: tx.id,
      symbol: tx.symbol,
      opened_at: tx.opened_at,
      closed_at: tx.closed_at,
      status: tx.status,
      final_decision: tx.final_decision,
      outcome: tx.outcome,
    })),
};

// Event traces on market day
const allEventTraces = db.prepare('SELECT * FROM event_traces ORDER BY timestamp ASC').all() as Record<string, unknown>[];
const dayEventTraces = allEventTraces.filter((e) => isMarketDay(e.timestamp as number));

// 4. event_traces
const decisionEventTypes = [
  'TRADE_IDEA_GENERATED',
  'CHIEF_APPROVED_IDEA',
  'RISK_ASSESSMENT_STARTED',
  'RISK_ASSESSMENT_COMPLETED',
  'ORDER_EXECUTED',
];
const sampleDecisionEvents: Record<string, unknown[]> = {};
for (const et of decisionEventTypes) {
  sampleDecisionEvents[et] = dayEventTraces
    .filter((e) => e.event_type === et)
    .slice(0, 5)
    .map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      timestampIso: new Date(e.timestamp as number).toISOString(),
      nyDate: nyDateOf(e.timestamp as number),
      correlation_id: e.correlation_id,
      transaction_id: e.transaction_id,
      source: e.source,
      destination: e.destination,
      success: e.success,
      payload: e.payload,
    }));
}
report.event_traces_market_day = {
  total: dayEventTraces.length,
  countByEventType: countBy(dayEventTraces, 'event_type'),
  sampleDecisionEvents,
  note: 'User asked for CHIEF_APPROVED and RISK_ASSESSMENT; canonical names are CHIEF_APPROVED_IDEA and RISK_ASSESSMENT_COMPLETED/STARTED per config/eventNames.json',
};

// Join risk data to market day via trace_id / transaction_id from day transactions
const dayTransactionIds = new Set(dayTransactions.map((t) => String(t.id)));
const dayTraceIdsFromTx = new Set<string>();

// 5 & 6 risk gates and assessments - filter by created_at NY day OR linked transaction
const riskAssessmentsAll = tableExists(db, 'risk_assessments')
  ? (db.prepare('SELECT * FROM risk_assessments ORDER BY created_at ASC').all() as Record<string, unknown>[])
  : [];
const riskGateAll = tableExists(db, 'risk_gate_results')
  ? (db.prepare('SELECT * FROM risk_gate_results ORDER BY id ASC').all() as Record<string, unknown>[])
  : [];

const dayRiskAssessments = riskAssessmentsAll.filter(
  (r) => isMarketDay(r.created_at as string) || (r.transaction_id && dayTransactionIds.has(String(r.transaction_id))),
);
const dayRiskTraceIds = new Set(dayRiskAssessments.map((r) => String(r.trace_id)));

const dayRiskGates = riskGateAll.filter((g) => dayRiskTraceIds.has(String(g.trace_id)));

const gatePassFail: Record<string, { pass: number; fail: number }> = {};
for (const g of dayRiskGates) {
  const name = String(g.gate_name);
  if (!gatePassFail[name]) gatePassFail[name] = { pass: 0, fail: 0 };
  if (g.passed) gatePassFail[name].pass++;
  else gatePassFail[name].fail++;
}

report.risk_gate_results_market_day = {
  total: dayRiskGates.length,
  countByGatePassFail: gatePassFail,
  filterNote: 'Gates linked to risk_assessments on market day (by created_at NY date or transaction opened that day)',
};

report.risk_assessments_market_day = {
  total: dayRiskAssessments.length,
  approved: dayRiskAssessments.filter((r) => r.approved).length,
  rejected: dayRiskAssessments.filter((r) => !r.approved).length,
  rejectionsByGate: countBy(
    dayRiskAssessments.filter((r) => !r.approved),
    'rejection_gate',
  ),
};

// 7 consensus_decisions
const consensusAll = tableExists(db, 'consensus_decisions')
  ? (db.prepare('SELECT * FROM consensus_decisions ORDER BY created_at ASC').all() as Record<string, unknown>[])
  : [];
report.consensus_decisions_market_day = consensusAll.filter((c) => isMarketDay(c.created_at as string));

// 8 agent_predictions
const predsAll = tableExists(db, 'agent_predictions')
  ? (db.prepare('SELECT * FROM agent_predictions ORDER BY timestamp ASC').all() as Record<string, unknown>[])
  : [];
const dayPreds = predsAll.filter((p) => isMarketDay(p.timestamp as string));
const agentSideCounts: Record<string, Record<string, number>> = {};
for (const p of dayPreds) {
  const agent = String(p.agent_name);
  const side = String(p.prediction);
  if (!agentSideCounts[agent]) agentSideCounts[agent] = {};
  agentSideCounts[agent][side] = (agentSideCounts[agent][side] ?? 0) + 1;
}
report.agent_predictions_market_day = {
  total: dayPreds.length,
  countByAgentAndSide: agentSideCounts,
};

// 9 ai_calls
const aiCallsAll = tableExists(db, 'ai_calls')
  ? (db.prepare('SELECT * FROM ai_calls ORDER BY created_at ASC').all() as Record<string, unknown>[])
  : [];
const dayAiCalls = aiCallsAll.filter((c) => isMarketDay(c.created_at as string));
const providerModelCounts: Record<string, number> = {};
const failures: unknown[] = [];
for (const c of dayAiCalls) {
  const key = `${c.provider ?? 'null'}|${c.model ?? 'null'}`;
  providerModelCounts[key] = (providerModelCounts[key] ?? 0) + 1;
  if (c.status === 'error' || c.error) {
    failures.push({
      id: c.id,
      provider: c.provider,
      model: c.model,
      agent: c.agent,
      error: c.error,
      createdAt: c.created_at,
    });
  }
}
report.ai_calls_market_day = {
  total: dayAiCalls.length,
  countByProviderModel: providerModelCounts,
  failureCount: failures.length,
  failures,
};

// 10 kill_switch_events
if (tableExists(db, 'kill_switch_events')) {
  const kseAll = db.prepare('SELECT * FROM kill_switch_events ORDER BY created_at ASC').all() as Record<string, unknown>[];
  report.kill_switch_events_market_day = kseAll.filter((k) => isMarketDay(k.created_at as string));
} else {
  notes.push('Table kill_switch_events missing');
  report.kill_switch_events_market_day = [];
}

// 11 reconciliation_events
if (tableExists(db, 'reconciliation_events')) {
  const recAll = db.prepare('SELECT * FROM reconciliation_events ORDER BY checked_at ASC').all() as Record<string, unknown>[];
  const dayRec = recAll.filter((r) => isMarketDay(r.checked_at as string));
  report.reconciliation_events_market_day = {
    total: dayRec.length,
    matches: dayRec.filter((r) => r.matches).length,
    mismatches: dayRec.filter((r) => !r.matches).length,
    events: dayRec,
  };
} else {
  notes.push('Table reconciliation_events missing');
}

// 12 portfolio
if (tableExists(db, 'portfolio')) {
  report.portfolio = db.prepare('SELECT * FROM portfolio ORDER BY symbol ASC').all();
} else {
  notes.push('Table portfolio missing');
}

// 13 broker_connections
if (tableExists(db, 'broker_connections')) {
  const cols = columnNames(db, 'broker_connections');
  const rows = db.prepare('SELECT * FROM broker_connections ORDER BY id ASC').all() as Record<string, unknown>[];
  report.broker_connections = rows.map((r) => {
    const safe: Record<string, unknown> = {};
    for (const c of cols) {
      if (c.includes('encrypted') || c.includes('secret')) safe[c] = r[c] != null ? '[REDACTED]' : null;
      else safe[c] = r[c];
    }
    return safe;
  });
} else {
  notes.push('Table broker_connections missing');
}

// 14 daily_trading_summary
if (tableExists(db, 'daily_trading_summary')) {
  report.daily_trading_summary = db.prepare('SELECT * FROM daily_trading_summary WHERE date = ?').get(MARKET_DAY) ?? null;
} else {
  notes.push('Table daily_trading_summary missing');
}

// 15 quant_assessments
if (tableExists(db, 'quant_assessments')) {
  const qaAll = db.prepare('SELECT * FROM quant_assessments ORDER BY created_at ASC').all() as Record<string, unknown>[];
  report.quant_assessments_market_day = qaAll.filter((q) => isMarketDay(q.created_at as string));
} else {
  notes.push('Table quant_assessments missing');
}

// Session window
function minMaxIso(values: (string | number | null | undefined)[]): { first: string | null; last: string | null } {
  const times = values
    .map((v) => {
      if (v == null) return NaN;
      const t = typeof v === 'number' ? v : Date.parse(String(v));
      return t;
    })
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return { first: null, last: null };
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { first: new Date(min).toISOString(), last: new Date(max).toISOString() };
}

const txTimestamps: (string | null | undefined)[] = [];
for (const tx of dayTransactions) {
  txTimestamps.push(tx.opened_at as string);
  txTimestamps.push(tx.closed_at as string | null);
}

report.session_window = {
  event_traces_market_day: {
    ...minMaxIso(dayEventTraces.map((e) => e.timestamp as number)),
    firstNy: dayEventTraces.length ? nyDateOf(dayEventTraces[0].timestamp as number) : null,
    lastNy: dayEventTraces.length ? nyDateOf(dayEventTraces[dayEventTraces.length - 1].timestamp as number) : null,
    count: dayEventTraces.length,
  },
  transactions_market_day: {
    ...minMaxIso(txTimestamps),
    count: dayTransactions.length,
    openedAtRange: minMaxIso(dayTransactions.map((t) => t.opened_at as string)),
  },
};

report.summary_counts = {
  trades_total: tradesRaw.length,
  fills_total: Array.isArray(report.fills) ? report.fills.length : 0,
  transactions_market_day: dayTransactions.length,
  event_traces_market_day: dayEventTraces.length,
  risk_assessments_market_day: dayRiskAssessments.length,
  risk_gate_results_market_day: dayRiskGates.length,
};

db.close();
writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');
console.log('Wrote', OUT_PATH);
console.log(JSON.stringify(report.summary_counts));
