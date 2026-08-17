/**
 * Read-only forensic dump of data/argus.db for FINAL_ANALYSIS audit.
 * Usage: npx tsx scripts/_audit_db_forensics.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import { isOrganicClosedPaper, countOrganicPaperSessions, summarizeOrganicPaper } from '../src/server/research/organicPaper';
import { researchSafety } from '../src/server/config/researchSafety';

const dbPath = path.join(process.cwd(), 'data', 'argus.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

const out: Record<string, unknown> = {
  dbPath,
  integrity: db.prepare('PRAGMA integrity_check').get(),
  tables: (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name),
};

if (tableExists('trades')) {
  const cols = (db.prepare(`PRAGMA table_info(trades)`).all() as Array<{ name: string }>).map((c) => c.name);
  out.trades_columns = cols;
  const rows = db.prepare(`SELECT * FROM trades`).all() as any[];
  // Normalize to organicPaper field names
  const normalized = rows.map((r) => ({
    status: r.status,
    side: r.side,
    profitLoss: r.profit_loss ?? r.profitLoss ?? null,
    traceId: r.trace_id ?? r.traceId ?? null,
    reasoning: r.reasoning ?? null,
    executionEnvironment: r.execution_environment ?? r.executionEnvironment ?? null,
    timestamp: r.timestamp ?? null,
    filledAt: r.filled_at ?? r.filledAt ?? null,
  }));
  out.trades_total = rows.length;
  out.trades_by_status = db.prepare(`SELECT status, COUNT(*) as n FROM trades GROUP BY status`).all();
  out.trades_by_side = db.prepare(`SELECT side, COUNT(*) as n FROM trades GROUP BY side`).all();
  if (cols.includes('execution_environment')) {
    out.trades_by_env = db.prepare(`
      SELECT COALESCE(execution_environment,'(null)') as env, COUNT(*) as n
      FROM trades GROUP BY execution_environment ORDER BY n DESC
    `).all();
  }
  out.trades_sample = rows.slice(0, 25).map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    status: r.status,
    env: r.execution_environment ?? null,
    pnl: r.profit_loss ?? null,
    reasoning: String(r.reasoning ?? '').slice(0, 100),
  }));
  out.organic_closed_count = normalized.filter(isOrganicClosedPaper).length;
  out.organic_sessions = countOrganicPaperSessions(normalized);
  out.organic_summary = summarizeOrganicPaper(normalized, researchSafety.minPaperTrades);
  out.minPaperTrades = researchSafety.minPaperTrades;
  out.minPaperSessions = researchSafety.minPaperSessions;
}

for (const t of ['fills', 'transactions', 'reconciliation_events', 'kill_switch_events', 'risk_gate_results', 'risk_assessments', 'settings']) {
  out[`${t}_exists`] = tableExists(t);
  if (tableExists(t)) {
    out[`${t}_total`] = (db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get() as { n: number }).n;
  }
}

if (tableExists('transactions')) {
  const cols = (db.prepare(`PRAGMA table_info(transactions)`).all() as Array<{ name: string }>).map((c) => c.name);
  out.transactions_columns = cols;
  for (const candidate of ['status', 'transition_status', 'state', 'type', 'outcome']) {
    if (cols.includes(candidate)) {
      out.transactions_grouped_by = candidate;
      out.transactions_by = db.prepare(
        `SELECT COALESCE(${candidate},'(null)') as k, COUNT(*) as n FROM transactions GROUP BY 1 ORDER BY n DESC`,
      ).all();
      break;
    }
  }
}

if (tableExists('settings')) {
  const cols = (db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>).map((c) => c.name);
  out.settings_columns = cols;
  out.settings_row = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
}

if (tableExists('reconciliation_events')) {
  out.reconciliation_recent = db.prepare(`SELECT * FROM reconciliation_events ORDER BY rowid DESC LIMIT 10`).all();
}
if (tableExists('kill_switch_events')) {
  out.kill_switch_recent = db.prepare(`SELECT * FROM kill_switch_events ORDER BY rowid DESC LIMIT 10`).all();
}

console.log(JSON.stringify(out, null, 2));
db.close();
