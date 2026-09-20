import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const oldSchema = readFileSync('drizzle/0067_regular_wong.sql', 'utf8');
const migration = readFileSync('drizzle/0070_nullable_forecast_cost.sql', 'utf8');
function legacy() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(oldSchema);
  db.exec(`INSERT INTO quant_forecasts (forecast_id,symbol,created_at,direction,horizon_label,agent_name,forecast_status,sample_size,estimated_transaction_cost_bps,model_version,provenance_json)
    VALUES ('old','AAPL','2026-09-18','BUY','1d','Quant','VALID',42,0,'legacy','{"transactionCostSource":"NONE_ASSUMED_ZERO"}')`);
  return db;
}
describe('nullable forecast cost migration', () => {
  it('preserves every old value and both indexes, permits unknown costs, and preserves FK integrity', () => {
    const db = legacy();
    const before = db.prepare('SELECT * FROM quant_forecasts').all();
    db.transaction(() => db.exec(migration))();
    expect(db.prepare('SELECT * FROM quant_forecasts').all()).toEqual(before);
    const indexes = db.prepare("PRAGMA index_list('quant_forecasts')").all() as any[];
    expect(indexes.map(i => i.name)).toEqual(expect.arrayContaining(['idx_quant_forecasts_symbol','idx_quant_forecasts_lookup']));
    db.exec("UPDATE quant_forecasts SET estimated_transaction_cost_bps = NULL WHERE forecast_id = 'old'");
    expect(db.prepare('SELECT estimated_transaction_cost_bps AS cost FROM quant_forecasts').get()).toEqual({ cost: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
  it('rolls back all schema/data changes on a transactional migration failure', () => {
    const db = legacy();
    expect(() => db.transaction(() => { db.exec(migration); throw new Error('abort'); })()).toThrow('abort');
    expect((db.prepare("PRAGMA table_info('quant_forecasts')").all() as any[]).find(c => c.name === 'estimated_transaction_cost_bps').notnull).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM quant_forecasts').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='quant_forecasts_nullable_cost'").get()).toBeUndefined();
    db.close();
  });
});
