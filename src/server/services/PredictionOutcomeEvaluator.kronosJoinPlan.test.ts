import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression for the 2026-10-12 recurring event-loop freeze: the Kronos pending-count join compared an INTEGER
 * id to a TEXT prediction_id, defeating the unique (prediction_id, source_table) index (231,858 ms on prod).
 * This asserts the query-plan class directly (index SEARCH, not an automatic-index scan) and a scaled timing
 * contrast between the old and the cast form on identical data, so it fails on the old join and passes on the new.
 */
function seed() {
  const db = new Database(':memory:');
  db.exec(`create table kronos_predictions (id integer primary key autoincrement, timestamp text, symbol text);
           create table prediction_outcomes (id integer primary key autoincrement, prediction_id text not null, source_table text not null, outcome text);
           create unique index idx_prediction_outcomes_source on prediction_outcomes(prediction_id, source_table);`);
  const k = db.prepare('insert into kronos_predictions (timestamp, symbol) values (?,?)');
  const o = db.prepare('insert into prediction_outcomes (prediction_id, source_table, outcome) values (?,?,?)');
  db.transaction(() => {
    for (let i = 1; i <= 3000; i++) k.run('2026-10-12T00:00:00Z', 'S');
    for (let i = 1; i <= 1000; i++) o.run(String(i), 'kronos_predictions', 'WIN');
  })();
  return db;
}
const oldSql = "select count(*) c from kronos_predictions left join prediction_outcomes on (prediction_outcomes.prediction_id = kronos_predictions.id and prediction_outcomes.source_table = 'kronos_predictions') where prediction_outcomes.id is null";
const newSql = "select count(*) c from kronos_predictions left join prediction_outcomes on (prediction_outcomes.prediction_id = cast(kronos_predictions.id as text) and prediction_outcomes.source_table = 'kronos_predictions') where prediction_outcomes.id is null";

describe('Kronos pending-outcome join (freeze root cause)', () => {
  it('old integer-vs-text join cannot use the unique index; the cast form can', () => {
    const db = seed();
    const planOld = db.prepare('explain query plan ' + oldSql).all().map((r: any) => r.detail).join(' | ');
    const planNew = db.prepare('explain query plan ' + newSql).all().map((r: any) => r.detail).join(' | ');
    expect(planOld).toContain('AUTOMATIC'); // old: automatic partial index on source_table only => O(N*M)
    expect(planNew).toContain('idx_prediction_outcomes_source (prediction_id=? AND source_table=?)');
  });
  it('both forms return the same count, and the cast form is orders of magnitude cheaper', () => {
    const db = seed();
    const t0 = performance.now(); const a = db.prepare(oldSql).get() as any; const oldMs = performance.now() - t0;
    const t1 = performance.now(); const b = db.prepare(newSql).get() as any; const newMs = performance.now() - t1;
    expect(b.c).toBe(a.c);
    expect(b.c).toBe(2000);
    expect(newMs * 5).toBeLessThan(oldMs);
  });
  it('production source binds the fix: the Kronos join never compares prediction_id to the integer id directly', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'PredictionOutcomeEvaluator.ts'), 'utf8');
    expect(src).not.toMatch(/eq\(predictionOutcomes\.predictionId,\s*kronosPredictions\.id\)/);
    expect(src).toMatch(/predictionId,\s*sql<string>`cast\(\$\{kronosPredictions\.id\} as text\)`/);
  });
});
