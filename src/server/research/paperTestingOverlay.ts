/**
 * Load PAPER_TESTING rows for Quant. Does not enable QUANT.
 * Subset WFO (fullStrategyParity false) must not replace live quantThresholds.json.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveDbDir } from '../db/resolveDbDir';

export interface PaperTestingOverlay {
  applied: boolean;
  reason: string;
  regime: string;
  rows: Array<{ strategyId: string; params: Record<string, unknown>; fullStrategyParity: boolean }>;
}

export function resolvePaperTestingOverlay(regime: string): PaperTestingOverlay {
  const empty = (reason: string): PaperTestingOverlay => ({ applied: false, reason, regime, rows: [] });
  if (process.env.QUANT_ENGINE_ENABLED !== 'true') {
    return empty('QUANT_ENGINE_ENABLED is not true — overlay idle');
  }
  if (process.env.QUANT_PAPER_TESTING_PARAMS !== 'true') {
    return empty('QUANT_PAPER_TESTING_PARAMS is not true — JSON thresholds remain source of truth');
  }
  const dbPath = process.env.ARGUS_DB_PATH || path.join(resolveDbDir(process.platform, existsSync, process.cwd(), path.resolve), 'argus.db');
  if (!existsSync(dbPath)) return empty('strategy_configurations db missing');
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = sqlite.prepare(
        `SELECT strategy_id, params_json, full_strategy_parity, status FROM strategy_configurations WHERE status = 'PAPER_TESTING' AND (regime = ? OR regime = 'ANY')`,
      ).all(regime) as Array<{ strategy_id: string; params_json: string; full_strategy_parity: number; status: string }>;
      const parsed = rows.map((r) => ({
        strategyId: r.strategy_id,
        params: JSON.parse(r.params_json || '{}') as Record<string, unknown>,
        fullStrategyParity: !!r.full_strategy_parity,
      }));
      const usable = parsed.filter((r) => r.fullStrategyParity === true);
      if (usable.length === 0) {
        return {
          applied: false,
          reason: 'PAPER_TESTING rows exist but fullStrategyParity is false (parity-subset WFO cannot retune live evaluate())',
          regime,
          rows: parsed,
        };
      }
      return { applied: true, reason: 'fullStrategyParity PAPER_TESTING overlay', regime, rows: usable };
    } finally {
      sqlite.close();
    }
  } catch (e: any) {
    return empty(`overlay read failed: ${e?.message || String(e)}`);
  }
}
