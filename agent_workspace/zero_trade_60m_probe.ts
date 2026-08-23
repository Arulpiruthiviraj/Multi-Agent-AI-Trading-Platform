/**
 * Read-only 60-minute zero-trade forensic probe. No mutations, no orders.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'argus.db');
const db = new Database(dbPath, { readonly: true });
const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const sinceMs = Date.now() - 60 * 60 * 1000;

function tryAll(sql: string, ...params: unknown[]) {
  try {
    return db.prepare(sql).all(...params);
  } catch (e: any) {
    return [{ _error: e.message }];
  }
}
function tryGet(sql: string, ...params: unknown[]) {
  try {
    return db.prepare(sql).get(...params);
  } catch (e: any) {
    return { _error: e.message };
  }
}

const out: Record<string, unknown> = { since, probedAt: new Date().toISOString() };

out.tradesByStatus = tryAll(
  `SELECT status, side, count(*) as c FROM trades
   WHERE coalesce(submitted_at, timestamp) >= ?
   GROUP BY status, side`,
  since,
);
out.tradesCount = tryGet(
  `SELECT count(*) as c FROM trades WHERE coalesce(submitted_at, timestamp) >= ?`,
  since,
);

// risk_assessments column names vary — probe
out.riskCols = tryAll(`PRAGMA table_info(risk_assessments)`);
out.riskByApproved = tryAll(
  `SELECT approved, count(*) as c FROM risk_assessments
   WHERE coalesce(created_at, timestamp, assessed_at) >= ?
   GROUP BY approved`,
  since,
);
out.riskGateFails = tryAll(
  `SELECT gate_name, passed, count(*) as c FROM risk_gate_results
   WHERE coalesce(created_at, timestamp) >= ?
   GROUP BY gate_name, passed
   ORDER BY c DESC LIMIT 40`,
  since,
);

out.eventTracesTypes = tryAll(
  `SELECT event_type, count(*) as c FROM event_traces
   WHERE timestamp >= ?
   GROUP BY event_type
   ORDER BY c DESC LIMIT 50`,
  since,
);

out.consensusDecisions = tryAll(
  `SELECT approved, count(*) as c FROM consensus_decisions
   WHERE coalesce(created_at, timestamp) >= ?
   GROUP BY approved`,
  since,
);

out.recentConsensus = tryAll(
  `SELECT symbol, approved, weighted_confidence, reasoning, coalesce(created_at, timestamp) as ts
   FROM consensus_decisions
   WHERE coalesce(created_at, timestamp) >= ?
   ORDER BY coalesce(created_at, timestamp) DESC LIMIT 25`,
  since,
);

out.agentPredictions = tryAll(
  `SELECT agent_name, prediction, count(*) as c FROM agent_predictions
   WHERE timestamp >= ?
   GROUP BY agent_name, prediction
   ORDER BY c DESC LIMIT 40`,
  since,
);

out.observability = tryAll(
  `SELECT event_type, count(*) as c FROM observability_events
   WHERE timestamp >= ?
   GROUP BY event_type
   ORDER BY c DESC LIMIT 40`,
  since,
);

out.settings = tryGet(
  `SELECT selected_broker, trading_mode, auto_bot_enabled FROM settings LIMIT 1`,
);

out.fills60 = tryGet(
  `SELECT count(*) as c FROM fills WHERE filled_at >= ?`,
  since,
);

const logPath = path.join(process.cwd(), 'logs', 'argus-dev.log');
let logTail: string[] = [];
if (fs.existsSync(logPath)) {
  const st = fs.statSync(logPath);
  out.logSizeBytes = st.size;
  out.logMtime = st.mtime.toISOString();
  // Read last ~2MB
  const fd = fs.openSync(logPath, 'r');
  const size = st.size;
  const readLen = Math.min(size, 2_000_000);
  const buf = Buffer.alloc(readLen);
  fs.readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split(/\r?\n/);
  const recent = lines.filter((l) => {
    const m = l.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (!m) return false;
    return Date.parse(m[1] + 'Z') >= sinceMs - 5 * 60 * 1000 || Date.parse(m[1]) >= sinceMs;
  });
  // Also keep keyword hits from the tail regardless of parseable date
  const keywords = [
    'subscribeRequested',
    'already_subscribed',
    'scanned',
    'NO TRADE',
    'ChiefTrader',
    'QuantEngine',
    'Consensus',
    'placeOrder',
    'TRADING_',
    'SAFE_MODE',
    'RiskEngine',
    'ORDER_',
    'MANUAL_',
    'TRADE_REJECTED',
    'hardCap',
    'emptySlots',
    'OpportunityDiscovery',
    'IBKR',
  ];
  const hitLines = lines.filter((l) => keywords.some((k) => l.includes(k))).slice(-200);
  out.logKeywordHits = hitLines.length;
  out.logKeywordSample = hitLines.slice(-80);
  logTail = recent.slice(-50);
}
out.logRecentDated = logTail;

// Live HTTP if up
async function probeHttp() {
  try {
    const h = await fetch('http://127.0.0.1:3000/api/v2/runtime/health', { signal: AbortSignal.timeout(4000) });
    out.healthHttp = await h.json();
  } catch (e: any) {
    out.healthHttp = { error: e.message };
  }
  try {
    const s = await fetch('http://127.0.0.1:3000/api/v2/runtime/status', { signal: AbortSignal.timeout(4000) });
    out.statusHttp = await s.json();
  } catch (e: any) {
    out.statusHttp = { error: e.message };
  }
  try {
    const c = await fetch('http://127.0.0.1:3000/api/v2/continuous-intelligence/status', { signal: AbortSignal.timeout(4000) });
    out.ciStatus = await c.json();
  } catch (e: any) {
    out.ciStatus = { error: e.message };
  }
}

await probeHttp();
const outPath = path.join(process.cwd(), 'agent_workspace', 'zero_trade_60m_probe.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('Wrote', outPath);
console.log(JSON.stringify({
  tradesCount: out.tradesCount,
  tradesByStatus: out.tradesByStatus,
  riskByApproved: out.riskByApproved,
  fills60: out.fills60,
  eventTop: (out.eventTracesTypes as any[])?.slice?.(0, 15),
  consensus: out.consensusDecisions,
  settings: out.settings,
  healthErr: (out.healthHttp as any)?.error,
  ci: out.ciStatus,
}, null, 2));
db.close();
